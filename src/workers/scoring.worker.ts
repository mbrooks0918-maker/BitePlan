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
import { dailyTideRange, getCurrentTideState, tideLevelAtFt } from '@/lib/tides'
import {
  depthGradientFt,
  getCurrentDepth,
  getDepthAtMLLW,
  initDepthGrid,
  isDepthGridReady,
} from '@/lib/depth'
import type {
  Bounds,
  ConvergenceTag,
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
  /** Step 13.5 additions — used for per-window water-temp + frontal-phase
   *  derivation inside the worker. */
  temperatureF: number
  shortForecast: string
  precipProbability: number
}
type PackedPressure = { startMs: number; endMs: number; inHg: number }

/** Step 13.5 — env fields the worker needs as a fallback for windows beyond
 *  the NWS forecast horizon. The store derives these for "now"; the worker
 *  uses them as carry-forward defaults when per-window data isn't available. */
type FallbackEnv = {
  waterTempF: number
  pressureInHg: number
  pressureTrendInHgPer3h: number
  frontalPhase: 'pre' | 'during' | 'post' | 'stable'
  airTempF: number
}

type DepthFilterMode = 'strict' | 'tide_aware' | 'tag_only'

// Step 13.6 thresholds (handoff doc / locked design decisions)
const DEPTH_SHALLOW_FT = 2          // kayak navigability cutoff
const DEPTH_DEEP_FT = 30            // popup-only note threshold ("deep water")
// Initial spec said 30 m / 3 ft. The depth grid resolution is 500 m, so a
// 30 m sample step almost always reads the SAME cell, defeating the
// detection. The audit-band thresholds (3 / 5 / 10 ft) were also tuned for
// real 30 m bathymetry. At our 500 m grid resolution we ratchet the
// offset up to 100 m (one neighbouring cell) and the minimum gradient to
// 5 ft so only true "strong" channel-edge breaks survive. Step 20 perf
// pass can revisit if a higher-res grid lands.
const DEPTH_BREAK_OFFSET_M = 100
const DEPTH_BREAK_MIN_DIFF_FT = 5
// A depth_break should anchor a fish-holding spot — the centroid itself
// must be in fishable water at MLLW (>1 ft). Without this gate, dry-at-low
// wetland edges adjacent to a deeper bay get tagged as "channel edges"
// they're not.
const DEPTH_BREAK_MIN_CENTER_FT = 1

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
  pressureSeries: PackedPressure[]
  waterTempF: number
  pressureInHg: number
  pressureTrendInHgPer3h: number
  frontalPhase: 'pre' | 'during' | 'post' | 'stable'
  airTempF: number
  tideLevelAboveMLLWFt: number
  depthFilterMode: DepthFilterMode
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
  pressureSeries: PackedPressure[]
  waterTempF: number
  pressureInHg: number
  pressureTrendInHgPer3h: number
  frontalPhase: 'pre' | 'during' | 'post' | 'stable'
  airTempF: number
  tideLevelAboveMLLWFt: number
  depthFilterMode: DepthFilterMode
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

/** Pressure at `timeMs` from a sparse series. null when not bracketed. */
function pressureForTime(timeMs: number, series: PackedPressure[]): number | null {
  for (const p of series) {
    if (p.startMs <= timeMs && timeMs < p.endMs) return p.inHg
  }
  return null
}

/** Step 13.5 — seasonal lag estimate from air temp → water temp.
 *  Mirror of `estimateWaterTempF` in the store; duplicated here so the
 *  worker stays standalone (no main-thread imports during scoring). */
function estimateWaterTempF(airTempF: number, month: number): number {
  if (!Number.isFinite(airTempF) || airTempF === 0) return 0
  if (month >= 3 && month <= 5) return airTempF - 3
  if (month >= 6 && month <= 8) return airTempF - 2
  if (month >= 9 && month <= 11) return airTempF + 2
  return airTempF + 5
}

/**
 * Per-window frontal-phase derivation for projection / day-conditions.
 * Mirrors `frontalPhaseAt` in weather.ts but operates on the packed series
 * the worker receives. Pre-frontal trips on either a fast pressure drop
 * over the next 6h OR rain/thunder anywhere in the next 24h of hourly
 * forecast. Falls back to the message-level frontalPhase when neither
 * window has data.
 */
function frontalPhaseForTime(
  timeMs: number,
  hourly: PackedHourly[],
  pressureSeries: PackedPressure[],
  fallback: FallbackEnv['frontalPhase'],
): FallbackEnv['frontalPhase'] {
  const SIX_H = 6 * 60 * 60 * 1000
  const HORIZON_24H = 24 * 60 * 60 * 1000

  const now = pressureForTime(timeMs, pressureSeries)
  const plus6 = pressureForTime(timeMs + SIX_H, pressureSeries)
  const now3 = pressureForTime(timeMs + 3 * 60 * 60 * 1000, pressureSeries)
  const trend3 = now != null && now3 != null ? now3 - now : 0

  // 'during' — strong negative trend + thunder/storm keyword in current hour
  const currentHour = windForTime(timeMs, hourly)
  const currentFc = (currentHour?.shortForecast ?? '').toLowerCase()
  if (/thunder|storm|heavy rain/i.test(currentFc) && trend3 < -0.05) return 'during'

  // 'pre' — rain/storm keyword in next 24h OR pressure dropping > 0.10/6h
  let rainAhead = false
  for (const h of hourly) {
    if (h.startMs >= timeMs && h.startMs < timeMs + HORIZON_24H) {
      if (/rain|shower|thunder|storm/i.test(h.shortForecast)) {
        rainAhead = true
        break
      }
    }
  }
  const fastDrop = now != null && plus6 != null && plus6 - now <= -0.10
  if (rainAhead || fastDrop) return 'pre'

  if (trend3 > 0.05) return 'post'

  // If we had no data at all, defer to the message-level fallback.
  if (now == null && currentHour == null) return fallback
  return 'stable'
}

/**
 * Step 13.6 — compute per-unit depth info + a depth_break convergence tag
 * if the gradient meets threshold. Reused by both the single-time score
 * handler and the per-window day-conditions handler.
 *
 * Returns `null` for `surviveFilter` (i.e. exclude) when the depth filter
 * mode rules out this unit. When the depth grid isn't loaded or has no
 * coverage at this point, the filter never excludes (graceful degradation).
 */
function evaluateDepthForUnit(
  unit: ScoringUnit,
  tideLevelAboveMLLWFt: number,
  depthFilterMode: DepthFilterMode,
): {
  surviveFilter: boolean
  depthBreakTag: ConvergenceTag | null
  shallowAtLowTide: boolean
  deepWater: boolean
} {
  const [lon, lat] = unit.centroid
  if (!isDepthGridReady()) {
    return {
      surviveFilter: true,
      depthBreakTag: null,
      shallowAtLowTide: false,
      deepWater: false,
    }
  }
  const mllw = getDepthAtMLLW(lat, lon)
  if (mllw == null) {
    // Out of grid coverage — let the unit through and skip tagging.
    return {
      surviveFilter: true,
      depthBreakTag: null,
      shallowAtLowTide: false,
      deepWater: false,
    }
  }
  const current = getCurrentDepth(lat, lon, tideLevelAboveMLLWFt) ?? 0
  const shallowAtLowTide = mllw < DEPTH_SHALLOW_FT
  const deepWater = mllw > DEPTH_DEEP_FT

  let surviveFilter = true
  if (depthFilterMode === 'strict' && shallowAtLowTide) surviveFilter = false
  if (depthFilterMode === 'tide_aware' && current < DEPTH_SHALLOW_FT) surviveFilter = false
  // 'tag_only' — never excludes; downstream popup carries the shallow tag.

  let depthBreakTag: ConvergenceTag | null = null
  const grad = depthGradientFt(lat, lon, DEPTH_BREAK_OFFSET_M)
  if (
    grad.maxDiff >= DEPTH_BREAK_MIN_DIFF_FT &&
    grad.centerDepth != null &&
    grad.centerDepth >= DEPTH_BREAK_MIN_CENTER_FT
  ) {
    // Find the neighbouring sample that produced maxDiff.
    let otherDepth = grad.centerDepth
    for (const s of grad.samples) {
      if (s == null) continue
      if (Math.abs(s - grad.centerDepth) === grad.maxDiff) {
        otherDepth = s
        break
      }
    }
    // Per the audit's design ("Depth break: 6 ft → 12 ft within 30m"),
    // BOTH sides of the break should be in fishable water. Without this
    // gate, a wetland edge sitting at MLLW=0 next to a 6 ft bay reads as
    // a depth_break, which isn't the channel-edge structure the audit
    // intends — it's just the shoreline. Skip when the shallower side is
    // out of kayak-fishable range at MLLW.
    const a = Math.min(grad.centerDepth, otherDepth)
    const b = Math.max(grad.centerDepth, otherDepth)
    if (a >= DEPTH_BREAK_MIN_CENTER_FT) {
      const strength: 'moderate' | 'strong' = grad.maxDiff > 10 ? 'strong' : 'strong'
      depthBreakTag = {
        type: 'depth_break',
        strength,
        description: `Depth break: ${a.toFixed(0)} ft → ${b.toFixed(0)} ft within ${DEPTH_BREAK_OFFSET_M} m`,
      }
    }
  }

  return { surviveFilter, depthBreakTag, shallowAtLowTide, deepWater }
}

/**
 * Apply depth filtering + augmentation to a unit. Returns either an
 * augmented unit (potentially with a new depth_break convergence tag) plus
 * extra per-unit depth notes, or null when the filter excludes it.
 */
function applyDepthToUnit(
  unit: ScoringUnit,
  tideLevelAboveMLLWFt: number,
  depthFilterMode: DepthFilterMode,
): { unit: ScoringUnit; shallowAtLowTide: boolean; deepWater: boolean } | null {
  const d = evaluateDepthForUnit(unit, tideLevelAboveMLLWFt, depthFilterMode)
  if (!d.surviveFilter) return null
  if (d.depthBreakTag) {
    // Avoid double-tagging if a previous derivation already added one (the
    // habitat-index cache is shared across recomputes).
    const already = unit.convergence.some((t) => t.type === 'depth_break')
    if (!already) {
      return {
        unit: { ...unit, convergence: [...unit.convergence, d.depthBreakTag] },
        shallowAtLowTide: d.shallowAtLowTide,
        deepWater: d.deepWater,
      }
    }
  }
  return { unit, shallowAtLowTide: d.shallowAtLowTide, deepWater: d.deepWater }
}

/**
 * Build the per-window scoring context for projection / day-conditions.
 * Combines per-window data (when bracketed by the hourly or pressure
 * series) with the message-level fallback for windows beyond the NWS
 * horizon (carry-forward approximation, same approach the worker has used
 * since Step 13).
 */
function perWindowEnv(
  timeMs: number,
  hourly: PackedHourly[],
  pressureSeries: PackedPressure[],
  fallback: FallbackEnv,
  fallbackWindKt: number,
  fallbackWindDir: string | undefined,
): {
  windSpeedKt: number
  windDirectionCompass: string | undefined
  waterTempF: number
  pressureInHg: number
  pressureTrendInHgPer3h: number
  frontalPhase: FallbackEnv['frontalPhase']
} {
  const month = new Date(timeMs).getMonth() + 1
  const matchedHourly = windForTime(timeMs, hourly)
  const windSpeedKt = matchedHourly?.windSpeedKt ?? fallbackWindKt
  const windDirectionCompass = matchedHourly?.windDirectionCompass ?? fallbackWindDir
  const airTempF = matchedHourly?.temperatureF ?? fallback.airTempF
  const waterTempF =
    matchedHourly != null
      ? estimateWaterTempF(airTempF, month)
      : fallback.waterTempF
  const pNow = pressureForTime(timeMs, pressureSeries)
  const pFwd = pressureForTime(timeMs + 3 * 60 * 60 * 1000, pressureSeries)
  const pressureInHg = pNow ?? fallback.pressureInHg
  const pressureTrendInHgPer3h =
    pNow != null && pFwd != null ? pFwd - pNow : fallback.pressureTrendInHgPer3h
  const frontalPhase = frontalPhaseForTime(timeMs, hourly, pressureSeries, fallback.frontalPhase)
  return {
    windSpeedKt,
    windDirectionCompass,
    waterTempF,
    pressureInHg,
    pressureTrendInHgPer3h,
    frontalPhase,
  }
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
    // Habitat + depth load in parallel. The depth grid is only ~957 KB so
    // it lands well before the habitat indexing finishes; we don't block on
    // its readiness — if it's still loading on first score pass, depth
    // lookups return null and the filter degrades gracefully.
    await Promise.all([initHabitatIndex(), initDepthGrid()])
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
      // Step 13.5 audit fields — derived by the store before the message,
      // so all units in this pass score against the same env snapshot.
      waterTempF: msg.waterTempF,
      pressureInHg: msg.pressureInHg,
      pressureTrendInHgPer3h: msg.pressureTrendInHgPer3h,
      frontalPhase: msg.frontalPhase,
      // Step 13.6 depth context
      tideLevelAboveMLLWFt: msg.tideLevelAboveMLLWFt,
      depthFilterMode: msg.depthFilterMode,
    }

    const features = getVisibleHabitat(msg.bounds)
    const allUnits: ScoringUnit[] = []
    for (const f of features) {
      const units = deriveScoringUnits(f)
      allUnits.push(...units)
    }
    const inView = filterUnitsToBounds(allUnits, msg.bounds)

    // Step 13.6: apply depth filter + depth_break augmentation per unit.
    const scored: ScoredEntry[] = []
    let droppedToFilter = 0
    for (const baseUnit of inView) {
      const d = applyDepthToUnit(baseUnit, msg.tideLevelAboveMLLWFt, msg.depthFilterMode)
      if (!d) {
        droppedToFilter++
        continue
      }
      const result = scoreUnit(d.unit, ctx)
      // Tag_only mode + shallow → emit the warning factor (0 delta, just a
      // popup line). Deep water gets a 0-delta info note in any mode.
      if (d.shallowAtLowTide && msg.depthFilterMode === 'tag_only') {
        result.missingFactors.push({
          fired: false,
          delta: 0,
          description: 'Shallow at low tide — kayak access may dry up',
          category: 'depth',
        })
      }
      if (d.deepWater) {
        result.missingFactors.push({
          fired: false,
          delta: 0,
          description: 'Deep water — adjust to inshore species accordingly',
          category: 'depth',
        })
      }
      scored.push({ unit: d.unit, result })
    }
    if (droppedToFilter > 0) {
      console.info(
        `[scoring/worker] depth filter '${msg.depthFilterMode}' dropped ${droppedToFilter} shallow units ` +
          `(tide ${msg.tideLevelAboveMLLWFt.toFixed(2)} ft above MLLW)`,
      )
    }

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

        // Per-window env: prefer NWS hourly / pressure data for windows
        // inside the forecast horizon; fall back to message-level
        // carry-forward values otherwise. The audit-v2 factors (water temp,
        // pressure trend, frontal phase) all participate in this lookup so
        // the 12-day trip dashboard reflects how conditions actually shift
        // across the trip, not just today's snapshot.
        const env = perWindowEnv(
          windowStartMs,
          msg.hourlyWind,
          msg.pressureSeries,
          {
            waterTempF: msg.waterTempF,
            pressureInHg: msg.pressureInHg,
            pressureTrendInHgPer3h: msg.pressureTrendInHgPer3h,
            frontalPhase: msg.frontalPhase,
            airTempF: msg.airTempF,
          },
          msg.windSpeedKt,
          msg.windDirectionCompass,
        )

        // Step 13.6 per-window tide level — interpolated from the same
        // multi-day predictions the main scoring pass uses. This is what
        // makes "a unit might be too shallow now but fishable at high tide
        // tomorrow" actually work in the day-conditions view.
        const windowTideLevelFt = tideLevelAtFt(msg.tidePredictions, windowTime)

        const ctx: ScoringContext = {
          time: windowTime,
          tideState,
          species: msg.species,
          moonIllumination: getMoonIllumination(windowTime),
          sunrise,
          sunset,
          windSpeedKt: env.windSpeedKt,
          windDirectionCompass: env.windDirectionCompass,
          dailyTideRangeFt: dailyTideRange(msg.tidePredictions, windowTime),
          month: windowTime.getMonth() + 1,
          hour: windowTime.getHours(),
          waterTempF: env.waterTempF,
          pressureInHg: env.pressureInHg,
          pressureTrendInHgPer3h: env.pressureTrendInHgPer3h,
          frontalPhase: env.frontalPhase,
          tideLevelAboveMLLWFt: windowTideLevelFt,
          depthFilterMode: msg.depthFilterMode,
        }

        let windowMax = 0
        let windowFires = 0
        for (const baseUnit of inView) {
          const d = applyDepthToUnit(baseUnit, windowTideLevelFt, msg.depthFilterMode)
          if (!d) continue
          const r = scoreUnit(d.unit, ctx)
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
