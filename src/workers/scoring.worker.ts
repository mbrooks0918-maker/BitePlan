/// <reference lib="webworker" />

/**
 * BitePlan scoring Web Worker.
 *
 * The worker owns:
 *   - the rbush habitat index (loaded once, on first init message)
 *   - derivation of features into scoring units (cached per feature)
 *   - scoring those units against a context built from main-thread state
 *
 * The main thread sends an 'init' message at app start and a 'score' message
 * per recompute, and receives back a scored entry list capped to N.
 *
 * Why a worker? Cold derivation on the Perdido Bay default view takes ~23 s
 * of synchronous work (turf.area / lineString / along over ~44k edge points).
 * Running this on the main thread freezes the page and breaks tile loading.
 * Moving it here keeps the UI responsive — the panel shows "scoring…" while
 * the first pass runs, then updates when the worker reports back.
 */

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
  ScoringContext,
  ScoringResult,
  ScoringUnit,
  Species,
} from '@/types'
import type { TidePrediction } from '@/lib/tides'

// ---- message protocol -----------------------------------------------------

type InitMessage = { type: 'init'; reqId: number }
type ScoreMessage = {
  type: 'score'
  reqId: number
  bounds: Bounds
  currentTime: number // epoch ms (Dates serialize via structured clone but ms keeps things explicit)
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
  totalInView: number
  ms: number
}
export type WorkerToMain = InitCompleteMessage | ScoredResponseMessage

// ---- helpers --------------------------------------------------------------

function computeDailyTideRange(predictions: TidePrediction[]): number {
  if (predictions.length === 0) return 1.0
  const values = predictions.map((p) => p.v)
  return Math.max(...values) - Math.min(...values)
}

// ---- message handler ------------------------------------------------------

self.onmessage = async (e: MessageEvent<MainToWorker>) => {
  const msg = e.data

  if (msg.type === 'init') {
    await initHabitatIndex()
    const reply: InitCompleteMessage = {
      type: 'init-complete',
      reqId: msg.reqId,
      featureCount: 0, // habitat module logs the real count; main thread doesn't need it
    }
    ;(self as DedicatedWorkerGlobalScope).postMessage(reply)
    return
  }

  if (msg.type === 'score') {
    if (!isHabitatIndexReady()) {
      // init hasn't completed yet; respond empty so the caller's request is closed
      const reply: ScoredResponseMessage = {
        type: 'scored',
        reqId: msg.reqId,
        entries: [],
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
    scored.sort((a, b) => b.result.score - a.result.score)

    if (scored.length > msg.maxUnits) {
      console.warn(
        `[scoring/worker] capped at ${msg.maxUnits} units (scored ${scored.length} total in view) — Step 20 will lift this`,
      )
    }
    const capped = scored.slice(0, msg.maxUnits)

    const reply: ScoredResponseMessage = {
      type: 'scored',
      reqId: msg.reqId,
      entries: capped,
      totalInView: scored.length,
      ms: performance.now() - t0,
    }
    ;(self as DedicatedWorkerGlobalScope).postMessage(reply)
    return
  }
}

// Marker export so TS treats this as a module.
export {}
