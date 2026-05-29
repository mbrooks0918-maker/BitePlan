/// <reference lib="webworker" />

/**
 * BitePlan scoring Web Worker.
 *
 * The worker owns:
 *   - the rbush habitat index (loaded once, on first init message)
 *   - derivation of features into scoring units (cached per feature)
 *   - scoring those units against a context built from main-thread state
 *   - clustering same-tier units into heat zones (convex hull + buffer)
 *
 * The main thread sends an 'init' message at app start and a 'score' message
 * per recompute, and receives back a capped scored-entry list plus a clustered
 * heat-zone list.
 *
 * Why a worker? Cold derivation on the Perdido Bay default view takes ~46 s
 * of synchronous work (turf.area / lineString / along over the wetlands
 * MultiPolygon ring set). Running this on the main thread freezes the page and
 * breaks tile loading. Moving it here keeps the UI responsive — the panel
 * shows "scoring…" while the first pass runs, then updates when the worker
 * reports back.
 */

import {
  buffer as turfBuffer,
  clustersDbscan,
  convex,
  featureCollection,
  point,
} from '@turf/turf'
import type { Feature, FeatureCollection, Point } from 'geojson'
import {
  deriveScoringUnits,
  filterUnitsToBounds,
  getVisibleHabitat,
  initHabitatIndex,
  isHabitatIndexReady,
} from '@/lib/habitat'
import { getMoonIllumination, getSunTimes } from '@/lib/moon'
import { scoreUnit } from '@/lib/scoring'
import { dailyTideRange, getCurrentTideState } from '@/lib/tides'
import type {
  Bounds,
  DayCondition,
  HeatZone,
  ScoringContext,
  ScoringResult,
  ScoringUnit,
  Species,
  Tier,
} from '@/types'
import type { TidePrediction } from '@/lib/tides'

// ---- knobs ---------------------------------------------------------------

// Handoff doc said ~300 m. At our 100 m edge sampling, DBSCAN reachability
// still chains continuous coastline edges into mega-clusters of thousands of
// points whose convex hulls span whole bays. Two combined mitigations:
//   1. Tighter eps (100 m) breaks SOME chains at meaningful gaps.
//   2. ZONE_MAX_MEMBERS caps any single zone polygon. Clusters bigger than
//      that still render their dots — they just don't get a misleading
//      whole-bay convex hull underneath.
const CLUSTER_RADIUS_KM = 0.1 // 100 m DBSCAN eps
const CLUSTER_MIN_POINTS = 3  // clusters of 1-2 don't get a zone polygon
const ZONE_BUFFER_KM = 0.05   // 50 m outward buffer on the convex hull
const ZONE_MAX_MEMBERS = 200  // skip the polygon for very large chained clusters

// ---- message protocol ----------------------------------------------------

type PackedHourly = {
  startMs: number
  endMs: number
  windSpeedKt: number
  windDirectionCompass: string
}
type InitMessage = { type: 'init'; reqId: number }
type ScoreMessage = {
  type: 'score'
  reqId: number
  bounds: Bounds
  currentTime: number // epoch ms — structured clone serializes Date but ms is explicit
  stationLat: number
  stationLon: number
  tidePredictions: TidePrediction[]
  species: Species
  windSpeedKt: number
  windDirectionCompass?: string
  hourlyWind: PackedHourly[]
  maxUnits: number
}
type ComputeDayConditionsMessage = {
  type: 'computeDayConditions'
  reqId: number
  bounds: Bounds
  dayCount: number              // 7 for the picker, 12 for Trip Mode
  startDateMs: number           // midnight (local) of the first day, epoch ms
  stationLat: number
  stationLon: number
  // Multi-day prediction window covering all days needed for cross-day tide
  // bracketing. Main thread fetches via assembleTideWindow and ships the
  // merged sorted array.
  tidePredictions: TidePrediction[]
  species: Species
  windSpeedKt: number
  windDirectionCompass?: string
  hourlyWind: PackedHourly[]
}
type MainToWorker = InitMessage | ScoreMessage | ComputeDayConditionsMessage

/**
 * Look up the hourly wind for `timeMs`. Returns null when the time sits
 * beyond the forecast window — caller falls back to current observed.
 * Linear scan; NWS hourly is ≤ 156 entries so this is fine.
 */
function windForTime(
  timeMs: number,
  hourly: PackedHourly[],
): PackedHourly | null {
  for (const h of hourly) {
    if (h.startMs <= timeMs && timeMs < h.endMs) return h
  }
  return null
}

export type ScoredEntry = { unit: ScoringUnit; result: ScoringResult }
export type InitCompleteMessage = { type: 'init-complete'; reqId: number; featureCount: number }
export type ScoredResponseMessage = {
  type: 'scored'
  reqId: number
  entries: ScoredEntry[]
  zones: HeatZone[]
  totalInView: number
  ms: number
}
export type DayConditionsResponseMessage = {
  type: 'dayConditions'
  reqId: number
  results: DayCondition[]
  ms: number
}
export type WorkerToMain =
  | InitCompleteMessage
  | ScoredResponseMessage
  | DayConditionsResponseMessage

// ---- helpers -------------------------------------------------------------

type ClusterProps = { idx: number; cluster?: number; dbscan?: string }

/**
 * Cluster scored units into per-tier heat zones via turf's DBSCAN
 * implementation. Each cluster of 3+ units becomes one convex-hull polygon
 * buffered outward 50 m. Units that DBSCAN classifies as 'noise' (clusters of
 * 1-2) are not represented as zones — the rendering layer draws their dots
 * directly.
 */
function clusterIntoZones(entries: ScoredEntry[]): HeatZone[] {
  const zones: HeatZone[] = []
  const tiers: Tier[] = ['driveby', 'hot', 'fire']

  for (const tier of tiers) {
    const tierEntries = entries.filter((e) => e.result.tier === tier)
    if (tierEntries.length < CLUSTER_MIN_POINTS) continue

    const pts: FeatureCollection<Point, ClusterProps> = featureCollection(
      tierEntries.map(
        (e, idx) => point(e.unit.centroid, { idx }) as Feature<Point, ClusterProps>,
      ),
    )

    const clustered = clustersDbscan(pts, CLUSTER_RADIUS_KM, {
      units: 'kilometers',
      minPoints: CLUSTER_MIN_POINTS,
    }) as FeatureCollection<Point, ClusterProps>

    type Member = { feature: Feature<Point, ClusterProps>; entry: ScoredEntry }
    const groups = new Map<number, Member[]>()
    for (const f of clustered.features) {
      if (f.properties.dbscan === 'noise' || f.properties.cluster == null) continue
      const id = f.properties.cluster
      const entry = tierEntries[f.properties.idx]
      if (!groups.has(id)) groups.set(id, [])
      groups.get(id)!.push({ feature: f, entry })
    }

    for (const members of groups.values()) {
      if (members.length < CLUSTER_MIN_POINTS) continue
      // Convex hull of a long chained coastline is a misleading giant blob.
      // Don't draw it; dots still render so the heat is visible.
      if (members.length > ZONE_MAX_MEMBERS) continue
      const memberFC = featureCollection(members.map((m) => m.feature))
      const hull = convex(memberFC)
      if (!hull) continue
      const buffered = turfBuffer(hull, ZONE_BUFFER_KM, { units: 'kilometers' })
      if (!buffered) continue
      // Top member of the cluster, used as the representative when the user
      // taps the zone polygon and the popup needs one unit/result to show.
      const top = members.reduce(
        (best, m) => (m.entry.result.score > best.entry.result.score ? m : best),
        members[0],
      )
      zones.push({
        tier,
        geometry: buffered.geometry as HeatZone['geometry'],
        memberCount: members.length,
        topUnit: top.entry.unit,
        topResult: top.entry.result,
      })
    }
  }

  return zones
}

// ---- message handler -----------------------------------------------------

self.onmessage = async (e: MessageEvent<MainToWorker>) => {
  const msg = e.data

  if (msg.type === 'init') {
    await initHabitatIndex()
    const reply: InitCompleteMessage = {
      type: 'init-complete',
      reqId: msg.reqId,
      featureCount: 0,
    }
    ;(self as DedicatedWorkerGlobalScope).postMessage(reply)
    return
  }

  if (msg.type === 'score') {
    if (!isHabitatIndexReady()) {
      const reply: ScoredResponseMessage = {
        type: 'scored',
        reqId: msg.reqId,
        entries: [],
        zones: [],
        totalInView: 0,
        ms: 0,
      }
      ;(self as DedicatedWorkerGlobalScope).postMessage(reply)
      return
    }

    const t0 = performance.now()
    const time = new Date(msg.currentTime)
    const { state: tideState } = getCurrentTideState(msg.tidePredictions, time)
    const { sunrise, sunset } = getSunTimes(time, msg.stationLat, msg.stationLon)
    const ctx: ScoringContext = {
      time,
      tideState,
      species: msg.species,
      moonIllumination: getMoonIllumination(time),
      sunrise,
      sunset,
      windSpeedKt: msg.windSpeedKt,
      windDirectionCompass: msg.windDirectionCompass,
      dailyTideRangeFt: dailyTideRange(msg.tidePredictions, time),
      month: time.getMonth() + 1,
      hour: time.getHours(),
    }

    const features = getVisibleHabitat(msg.bounds)
    const allUnits: ScoringUnit[] = []
    for (const f of features) {
      const units = deriveScoringUnits(f)
      allUnits.push(...units)
    }
    const inView = filterUnitsToBounds(allUnits, msg.bounds)

    const scored: ScoredEntry[] = inView.map((unit) => ({
      unit,
      result: scoreUnit(unit, ctx),
    }))

    // Cluster on the FULL scored set so heat zones reflect the real
    // distribution; only the per-dot list gets capped below.
    const tCluster0 = performance.now()
    const zones = clusterIntoZones(scored)
    const tCluster = performance.now() - tCluster0
    console.info(
      `[scoring/worker] clustered ${scored.length} units → ${zones.length} zones in ${tCluster.toFixed(0)} ms`,
    )

    // Tier-priority cap: fires no-cap, then hots, then drivebys.
    const byTier = { fire: [] as ScoredEntry[], hot: [] as ScoredEntry[], driveby: [] as ScoredEntry[] }
    for (const e of scored) byTier[e.result.tier].push(e)
    for (const list of [byTier.fire, byTier.hot, byTier.driveby]) {
      list.sort((a, b) => b.result.score - a.result.score)
    }
    const capped: ScoredEntry[] = []
    capped.push(...byTier.fire)
    const remaining = () => Math.max(0, msg.maxUnits - capped.length)
    capped.push(...byTier.hot.slice(0, remaining()))
    capped.push(...byTier.driveby.slice(0, remaining()))

    if (scored.length > capped.length) {
      console.warn(
        `[scoring/worker] capped at ${capped.length} units (scored ${scored.length} total in view; kept all ${byTier.fire.length} fires)`,
      )
    }

    const reply: ScoredResponseMessage = {
      type: 'scored',
      reqId: msg.reqId,
      entries: capped,
      zones,
      totalInView: scored.length,
      ms: performance.now() - t0,
    }
    ;(self as DedicatedWorkerGlobalScope).postMessage(reply)
    return
  }

  if (msg.type === 'computeDayConditions') {
    if (!isHabitatIndexReady()) {
      const reply: DayConditionsResponseMessage = {
        type: 'dayConditions',
        reqId: msg.reqId,
        results: [],
        ms: 0,
      }
      ;(self as DedicatedWorkerGlobalScope).postMessage(reply)
      return
    }

    const t0 = performance.now()

    // Same in-view unit set the main scoring uses — reuse the derivation cache.
    const features = getVisibleHabitat(msg.bounds)
    const allUnits: ScoringUnit[] = []
    for (const f of features) {
      const units = deriveScoringUnits(f)
      allUnits.push(...units)
    }
    const inView = filterUnitsToBounds(allUnits, msg.bounds)

    // 3-hour windows starting at 3 AM, covering 03 / 06 / 09 / 12 / 15 / 18 / 21.
    // Seven windows per day; enough to catch every dawn/dusk/midday band.
    const WINDOW_HOURS = [3, 6, 9, 12, 15, 18, 21]
    const DAY_MS = 24 * 60 * 60 * 1000
    const HOUR_MS = 60 * 60 * 1000

    const results: DayCondition[] = []
    for (let dayIdx = 0; dayIdx < msg.dayCount; dayIdx++) {
      const dayStartMs = msg.startDateMs + dayIdx * DAY_MS
      const dayStart = new Date(dayStartMs)
      const dayKey = `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`

      let dayBestScore = -Infinity
      let dayBestWindowStartMs = dayStartMs + 6 * HOUR_MS // sensible fallback
      let dayBestFireCount = 0

      for (const startHour of WINDOW_HOURS) {
        const windowStartMs = dayStartMs + startHour * HOUR_MS
        const windowTime = new Date(windowStartMs)
        const { state: tideState } = getCurrentTideState(msg.tidePredictions, windowTime)
        const { sunrise, sunset } = getSunTimes(windowTime, msg.stationLat, msg.stationLon)

        // Per-window wind: prefer the matching NWS hourly forecast; fall
        // back to the current observed wind for windows beyond NWS's
        // ~7-day forecast range. The fallback is a carry-forward
        // approximation; documented here because it's used in both the
        // day-conditions picker and the projection engine.
        const hourly = windForTime(windowStartMs, msg.hourlyWind)
        const windKt = hourly?.windSpeedKt ?? msg.windSpeedKt
        const windDir = hourly?.windDirectionCompass ?? msg.windDirectionCompass

        const ctx: ScoringContext = {
          time: windowTime,
          tideState,
          species: msg.species,
          moonIllumination: getMoonIllumination(windowTime),
          sunrise,
          sunset,
          windSpeedKt: windKt,
          windDirectionCompass: windDir,
          dailyTideRangeFt: dailyTideRange(msg.tidePredictions, windowTime),
          month: windowTime.getMonth() + 1,
          hour: windowTime.getHours(),
        }

        let windowMax = 0
        let windowFires = 0
        for (const u of inView) {
          const r = scoreUnit(u, ctx)
          if (r.score > windowMax) windowMax = r.score
          if (r.score >= 8) windowFires++
        }

        if (windowMax > dayBestScore) {
          dayBestScore = windowMax
          dayBestWindowStartMs = windowStartMs
          dayBestFireCount = windowFires
        }
      }

      if (dayBestScore < 0) dayBestScore = 0
      const conditionsScore = Math.max(1, Math.min(10, Math.round(dayBestScore)))
      results.push({
        date: dayKey,
        conditionsScore,
        fireZoneCount: dayBestFireCount,
        bestWindowStartMs: dayBestWindowStartMs,
        bestWindowScore: dayBestScore,
      })
    }

    const ms = performance.now() - t0
    console.info(
      `[scoring/worker] day conditions for ${msg.dayCount} days × ${WINDOW_HOURS.length} windows × ${inView.length} units in ${ms.toFixed(0)} ms`,
    )

    const reply: DayConditionsResponseMessage = {
      type: 'dayConditions',
      reqId: msg.reqId,
      results,
      ms,
    }
    ;(self as DedicatedWorkerGlobalScope).postMessage(reply)
    return
  }
}

export {}
