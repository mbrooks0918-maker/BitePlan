/**
 * Forward projection (Step 9).
 *
 * For a single scoring unit, looks ahead 7 days in 3-hour windows and finds
 * the next moment the unit lights up to fire (score ≥ 8), or — failing that —
 * the best hot window (≥ 5). Returns null if nothing reaches hot.
 *
 * The expensive part is the 7 NOAA tide-prediction fetches; they run in
 * parallel and reuse the Step 5 SWR cache, so the second+ projection in a
 * session is near-instant. Per-unit results are also cached by hour-bucket
 * inside this module so reopening the same popup is O(1).
 */

import {
  dailyTideRange,
  fetchTidePredictions,
  getCurrentTideState,
  tideLevelAtFt,
  type TidePrediction,
} from '@/lib/tides'
import {
  frontalPhaseAt,
  hourlyAt,
  pressureAt,
  pressureTrendInHgPer3hAt,
} from '@/lib/weather'
import { estimateWaterTempF, useBitePlanStore } from '@/store/useBitePlanStore'
import { getMoonIllumination, getSunTimes } from '@/lib/moon'
import { scoreUnit } from '@/lib/scoring'
import type { Station } from '@/lib/stations'
import type { ScoringContext, ScoringFactor, ScoringUnit } from '@/types'

// ---- knobs ---------------------------------------------------------------

const WINDOW_HOURS = 3
const TOTAL_WINDOWS = 56          // 7 days × 24 hours / 3 = 56
const FIRE_THRESHOLD = 8
const HOT_THRESHOLD = 5
const TIMEOUT_MS = 5_000
const CACHE_HOUR_BUCKET_MS = 60 * 60 * 1000 // 1 hour — projection cache invalidates across hours

// ---- public types --------------------------------------------------------

export type ProjectionResult = {
  when: Date
  score: number
  tier: 'fire' | 'hot'
  reason: string
}

// ---- helpers -------------------------------------------------------------

function formatYYYYMMDD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}


/**
 * Boil a factor's description down to the short angler-readable phrase used
 * in projection "reason" strings. Pattern-matches the common factor
 * descriptions emitted by `scoring.ts`; falls back to a stripped-parens
 * lowercase version for unrecognised entries.
 */
export function extractReasonPhrase(factor: ScoringFactor): string {
  const d = factor.description
  if (/^rising tide/i.test(d)) return 'rising tide'
  if (/^falling tide/i.test(d)) return 'falling tide'
  if (/^moving water/i.test(d)) return 'moving water'
  if (/^dawn window/i.test(d)) return 'dawn'
  if (/^dusk window/i.test(d)) return 'dusk'
  if (/^mid-morning/i.test(d)) return 'mid-morning'
  if (/^peak inshore season/i.test(d)) return 'peak season'
  if (/^fall transition/i.test(d)) return 'fall transition'
  if (/^full moon/i.test(d)) return 'full moon'
  if (/^new moon/i.test(d)) return 'new moon'
  if (/^strong tide range/i.test(d)) return 'strong tides'
  if (/^redfish/i.test(d)) return 'redfish habitat'
  if (/^trout/i.test(d)) return 'trout habitat'
  if (/^flounder/i.test(d)) return 'flounder habitat'
  // Habitat baseline ("Seagrass edge", "Marsh edge", "Oyster bed") falls
  // through here, but the projection reason already filters habitat factors
  // out (they're constant per unit).
  return d.toLowerCase().replace(/\s*\([^)]+\)/g, '').trim()
}

function buildReason(firedFactors: ScoringFactor[]): string {
  // Habitat baselines are constant per unit — they don't tell the angler what
  // makes THIS WINDOW good. Drop them so the reason focuses on what changes.
  const significant = firedFactors.filter((f) => f.category !== 'habitat')
  const sorted = [...significant].sort((a, b) => b.delta - a.delta)
  const phrases = sorted.slice(0, 3).map(extractReasonPhrase)
  return phrases.join(' + ')
}

/**
 * Promise.race with a timeout that rejects. Used to bound the parallel NOAA
 * fetches so a slow tide endpoint can't hang the projection forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('NOAA timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// ---- session cache -------------------------------------------------------

type CachedEntry = { result: ProjectionResult | null; computedAt: number }
const projectionCache = new Map<string, CachedEntry>()

function cacheKey(unit: ScoringUnit, currentTime: Date): string {
  // Hour-bucketed key. Different hour = different bucket = miss = recompute,
  // which is exactly the handoff doc's "invalidate when currentTime changes
  // by more than 1 hour" rule.
  const hourBucket = Math.floor(currentTime.getTime() / CACHE_HOUR_BUCKET_MS)
  return `${unit.id}|${hourBucket}`
}

// ---- main entry point ----------------------------------------------------

/**
 * Compute the next 7-day projection for `unit`. Throws if NOAA fails for
 * every day or the network exceeds the 5s timeout. Returns null when no
 * future window scores ≥ 5.
 */
export async function projectNextFireWindow(
  unit: ScoringUnit,
  currentCtx: ScoringContext,
  station: Station,
): Promise<ProjectionResult | null> {
  // 1. Fetch a 9-day window: yesterday → +7. The extra day on either side
  //    lets getCurrentTideState bracket window times that sit near midnight
  //    (Gulf diurnal cycles can put the bracketing event on an adjacent day).
  const dayDates: Date[] = []
  for (let d = -1; d <= 7; d++) {
    const day = new Date(currentCtx.time)
    day.setDate(day.getDate() + d)
    dayDates.push(day)
  }

  const dayFetches = dayDates.map(async (d) => {
    try {
      return await fetchTidePredictions(station.id, d)
    } catch (e) {
      console.warn('[projection] tide fetch failed for', formatYYYYMMDD(d), e)
      return [] as TidePrediction[]
    }
  })

  const fetched = await withTimeout(Promise.all(dayFetches), TIMEOUT_MS)
  // One merged + sorted event list across the whole window — getCurrentTideState
  // and dailyTideRange both expect a cross-day stream now.
  const allEvents: TidePrediction[] = fetched.flat()

  // 2. Iterate 56 forward windows (skip i=0 — "next" means strictly after now).
  let bestHot: ProjectionResult | null = null

  for (let i = 1; i <= TOTAL_WINDOWS; i++) {
    const windowTime = new Date(
      currentCtx.time.getTime() + i * WINDOW_HOURS * 60 * 60 * 1000,
    )
    const { state: tideState } = getCurrentTideState(allEvents, windowTime)
    const { sunrise, sunset } = getSunTimes(windowTime, station.lat, station.lon)

    // Per-window env from the NWS hourly + pressure forecasts where they
    // exist. Beyond the forecast's ~7-day horizon, fall back to the current
    // context's values (carry-forward approximation — same model the worker
    // uses). All Step 13.5 audit fields (water temp, pressure, frontal phase)
    // participate here so the next-fire projection reflects how the env is
    // actually moving across the 7-day horizon.
    const weather = useBitePlanStore.getState().currentWeather
    const tMs = windowTime.getTime()
    const matchedHourly = weather ? hourlyAt(weather, tMs) : null
    const windKt = matchedHourly?.windSpeedKt ?? currentCtx.windSpeedKt
    const windDir = matchedHourly?.windDirectionCompass ?? currentCtx.windDirectionCompass

    const month = windowTime.getMonth() + 1
    const airTempF = matchedHourly?.temperatureF ?? 0
    const waterTempF = airTempF > 0
      ? estimateWaterTempF(airTempF, month)
      : currentCtx.waterTempF
    const pNow = weather ? pressureAt(weather, tMs) : null
    const pressureInHg = pNow ?? currentCtx.pressureInHg
    const pressureTrendInHgPer3h = weather
      ? pressureTrendInHgPer3hAt(weather, tMs)
      : currentCtx.pressureTrendInHgPer3h
    const frontalPhase = weather
      ? frontalPhaseAt(weather, tMs)
      : currentCtx.frontalPhase

    // Step 13.6 per-window tide level — same interpolation the worker uses.
    const tideLevelAboveMLLWFt = tideLevelAtFt(allEvents, windowTime)

    const ctx: ScoringContext = {
      time: windowTime,
      tideState,
      species: currentCtx.species,
      moonIllumination: getMoonIllumination(windowTime),
      sunrise,
      sunset,
      windSpeedKt: windKt,
      windDirectionCompass: windDir,
      dailyTideRangeFt: dailyTideRange(allEvents, windowTime),
      month,
      hour: windowTime.getHours(),
      waterTempF,
      pressureInHg,
      pressureTrendInHgPer3h,
      frontalPhase,
      tideLevelAboveMLLWFt,
      depthFilterMode: currentCtx.depthFilterMode,
    }

    const result = scoreUnit(unit, ctx)

    if (result.score >= FIRE_THRESHOLD) {
      return {
        when: windowTime,
        score: result.score,
        tier: 'fire',
        reason: buildReason(result.firedFactors),
      }
    }
    if (result.score >= HOT_THRESHOLD) {
      if (!bestHot || result.score > bestHot.score) {
        bestHot = {
          when: windowTime,
          score: result.score,
          tier: 'hot',
          reason: buildReason(result.firedFactors),
        }
      }
    }
  }

  return bestHot
}

/**
 * Session-cached wrapper. Hits the in-memory cache on repeated taps of the
 * same unit within the same hour; misses on hour boundary so projections
 * stay reasonably fresh as the user works through a day.
 */
export async function getCachedProjection(
  unit: ScoringUnit,
  currentCtx: ScoringContext,
  station: Station,
): Promise<ProjectionResult | null> {
  const key = cacheKey(unit, currentCtx.time)
  const hit = projectionCache.get(key)
  if (hit) return hit.result

  const result = await projectNextFireWindow(unit, currentCtx, station)
  projectionCache.set(key, { result, computedAt: Date.now() })
  return result
}
