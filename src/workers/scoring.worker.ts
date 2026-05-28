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
import { getCurrentTideState } from '@/lib/tides'
import type {
  Bounds,
  HeatZone,
  ScoringContext,
  ScoringResult,
  ScoringUnit,
  Species,
  Tier,
} from '@/types'
import type { TidePrediction } from '@/lib/tides'

// ---- knobs ---------------------------------------------------------------

const CLUSTER_RADIUS_KM = 0.3 // ~300 m proximity per the handoff doc
const CLUSTER_MIN_POINTS = 3  // clusters of 1-2 don't get a zone polygon
const ZONE_BUFFER_KM = 0.05   // 50 m outward buffer on the convex hull

// ---- message protocol ----------------------------------------------------

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
  maxUnits: number
}
type MainToWorker = InitMessage | ScoreMessage

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
export type WorkerToMain = InitCompleteMessage | ScoredResponseMessage

// ---- helpers -------------------------------------------------------------

function computeDailyTideRange(predictions: TidePrediction[]): number {
  if (predictions.length === 0) return 1.0
  const values = predictions.map((p) => p.v)
  return Math.max(...values) - Math.min(...values)
}

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

    const groups = new Map<number, Feature<Point, ClusterProps>[]>()
    for (const f of clustered.features) {
      if (f.properties.dbscan === 'noise' || f.properties.cluster == null) continue
      const id = f.properties.cluster
      if (!groups.has(id)) groups.set(id, [])
      groups.get(id)!.push(f)
    }

    for (const members of groups.values()) {
      if (members.length < CLUSTER_MIN_POINTS) continue
      const memberFC = featureCollection(members)
      const hull = convex(memberFC)
      if (!hull) continue
      const buffered = turfBuffer(hull, ZONE_BUFFER_KM, { units: 'kilometers' })
      if (!buffered) continue
      zones.push({
        tier,
        geometry: buffered.geometry as HeatZone['geometry'],
        memberCount: members.length,
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
      dailyTideRangeFt: computeDailyTideRange(msg.tidePredictions),
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
}

export {}
