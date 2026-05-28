import { create } from 'zustand'
import type {
  Bounds,
  HeatZone,
  LatLon,
  ScoringResult,
  ScoringUnit,
  Species,
} from '@/types'
import { getNearestStation, type Station } from '@/lib/stations'
import { assembleTideWindow, type TidePrediction } from '@/lib/tides'
import type { WorkerToMain } from '@/workers/scoring.worker'

const PERDIDO_BAY: LatLon = { lat: 30.317, lon: -87.436 }
const DEFAULT_ZOOM = 12
// 2000 leaves headroom over the prior 500 cap so the dev panel and Step 7's
// heat rendering have more than one tier visible. Fires never count toward
// the cap; see the worker's tier-priority slicing.
const MAX_SCORED_UNITS = 2000

export type HabitatKey = 'seagrass' | 'oysters' | 'wetlands'
export type HabitatFlags = Record<HabitatKey, boolean>

export type ScoredEntry = { unit: ScoringUnit; result: ScoringResult }

type BitePlanState = {
  center: LatLon
  zoom: number
  bounds: Bounds | null
  currentTime: Date

  habitatLayers: HabitatFlags
  habitatLoading: HabitatFlags

  currentStation: Station
  tidePredictions: TidePrediction[]
  tideLoading: boolean

  // Scoring
  species: Species
  scoredUnits: ScoredEntry[]
  zones: HeatZone[]
  scoringInProgress: boolean
  lastScoringMs: number
  habitatIndexReady: boolean

  // The unit currently shown in the zone popup, or null when the popup is
  // dismissed. Set by clicking a heat zone polygon or an individual dot.
  selectedZone: ScoredEntry | null

  setCenter: (center: LatLon) => void
  setZoom: (zoom: number) => void
  setBounds: (bounds: Bounds) => void
  setCurrentTime: (currentTime: Date) => void
  setSpecies: (species: Species) => void
  selectZone: (payload: ScoredEntry | null) => void
  toggleHabitat: (key: HabitatKey) => void
  setHabitatLoading: (key: HabitatKey, isLoading: boolean) => void
  updateTideStation: (mapCenter: LatLon) => Promise<void>
  recomputeScoredUnits: () => void
}

// --- Web Worker setup ------------------------------------------------------

// Created at module scope so React Strict Mode's double-mount can't spawn two.
// Vite handles the new Worker(new URL(...)) pattern natively in dev and build.
const scoringWorker = new Worker(
  new URL('../workers/scoring.worker.ts', import.meta.url),
  { type: 'module' },
)

// Monotonic request ID. The store keeps the latest reqId in memory so stale
// responses from rapid pans get ignored without state thrash.
let nextReqId = 1
let latestScoreReqId = 0

// Debounce timer for setCurrentTime → recompute. See setCurrentTime below.
let timeRecomputeTimeout: ReturnType<typeof setTimeout> | null = null
function scheduleTimeRecompute(fn: () => void): void {
  if (timeRecomputeTimeout) clearTimeout(timeRecomputeTimeout)
  timeRecomputeTimeout = setTimeout(() => {
    timeRecomputeTimeout = null
    fn()
  }, 100)
}

// Signature of the in-flight score request. Used to skip redundant recomputes
// fired during initial load — the worker init-complete callback, the mount-
// time updateTideStation, the map's initial moveend, and invalidateSize's
// follow-up moveend all fire in the first ~half-second with identical context,
// and without this they queue four ~10 s passes in the worker (~40 s wait).
// Cleared on response so a later genuine recompute (e.g. user pans away and
// back) still goes through.
let inFlightSignature: string | null = null

function buildRequestSignature(
  bounds: Bounds,
  currentTime: Date,
  species: Species,
  stationId: string,
  predictionsLen: number,
): string {
  return [
    bounds.west.toFixed(4),
    bounds.south.toFixed(4),
    bounds.east.toFixed(4),
    bounds.north.toFixed(4),
    currentTime.getTime(),
    species,
    stationId,
    predictionsLen,
  ].join('|')
}

// Kick off worker init immediately. The first 'score' message can be sent
// concurrently — the worker will respond empty until init resolves, then the
// next recompute (debounced 200ms after the next moveend or fired manually
// once the store sees habitatIndexReady) will return real data.
const INIT_REQ_ID = nextReqId++
scoringWorker.postMessage({ type: 'init', reqId: INIT_REQ_ID })

scoringWorker.onmessage = (e: MessageEvent<WorkerToMain>) => {
  const msg = e.data
  if (msg.type === 'init-complete') {
    useBitePlanStore.setState({ habitatIndexReady: true })
    // Trigger an initial recompute now that the worker is ready.
    useBitePlanStore.getState().recomputeScoredUnits()
    return
  }
  if (msg.type === 'scored') {
    // Drop responses to old requests. Without this, a slow cold-pass response
    // could clobber the result of a fresher pan that completed first.
    if (msg.reqId !== latestScoreReqId) return
    inFlightSignature = null
    useBitePlanStore.setState({
      scoredUnits: msg.entries,
      zones: msg.zones,
      scoringInProgress: false,
      lastScoringMs: msg.ms,
    })
  }
}

// Dev-only handle for preview debugging. Stripped in production by Vite.
if (import.meta.env.DEV) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__store = () => useBitePlanStore.getState()
}

export const useBitePlanStore = create<BitePlanState>((set, get) => ({
  center: PERDIDO_BAY,
  zoom: DEFAULT_ZOOM,
  bounds: null,
  currentTime: new Date(),

  habitatLayers: { seagrass: false, oysters: false, wetlands: false },
  habitatLoading: { seagrass: false, oysters: false, wetlands: false },

  currentStation: getNearestStation(PERDIDO_BAY.lat, PERDIDO_BAY.lon),
  tidePredictions: [],
  tideLoading: true,

  species: 'all',
  scoredUnits: [],
  zones: [],
  scoringInProgress: false,
  lastScoringMs: 0,
  habitatIndexReady: false,
  selectedZone: null,

  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),
  setBounds: (bounds) => set({ bounds }),
  setCurrentTime: (currentTime) => {
    set({ currentTime })
    // Debounce the rescore: during slider drags this can fire 30+ times a
    // second, which would queue dozens of worker passes. 100 ms is "live
    // enough" for visual feedback while bounding total work.
    scheduleTimeRecompute(() => get().recomputeScoredUnits())
  },
  setSpecies: (species) => set({ species }),
  selectZone: (payload) => set({ selectedZone: payload }),

  toggleHabitat: (key) =>
    set((s) => ({ habitatLayers: { ...s.habitatLayers, [key]: !s.habitatLayers[key] } })),
  setHabitatLoading: (key, isLoading) =>
    set((s) => ({ habitatLoading: { ...s.habitatLoading, [key]: isLoading } })),

  updateTideStation: async (mapCenter) => {
    const station = getNearestStation(mapCenter.lat, mapCenter.lon)
    const cur = get().currentStation
    if (cur.id === station.id && get().tidePredictions.length > 0) {
      return
    }
    set({ currentStation: station, tideLoading: true })
    try {
      // Multi-day window (yesterday + today + tomorrow) so the tide pill and
      // scoring can bracket across day boundaries — Gulf diurnal days often
      // publish only one hi/lo per calendar day.
      const predictions = await assembleTideWindow(station.id, new Date())
      set({ tidePredictions: predictions, tideLoading: false })
      get().recomputeScoredUnits()
    } catch (e) {
      console.error('[store] updateTideStation failed:', e)
      set({ tidePredictions: [], tideLoading: false })
    }
  },

  /**
   * Send the current view + scoring context to the worker. The response
   * arrives asynchronously via the module-scope onmessage handler.
   */
  recomputeScoredUnits: () => {
    const { bounds, currentTime, currentStation, tidePredictions, species, habitatIndexReady } =
      get()
    if (!habitatIndexReady) return
    if (!bounds) return

    // Skip if a request with this exact context is already in flight. This
    // collapses the 3-4 cold-pass triggers (init-complete, tide-fetch-success,
    // initial moveend, invalidateSize moveend) into ONE worker pass.
    const sig = buildRequestSignature(
      bounds,
      currentTime,
      species,
      currentStation.id,
      tidePredictions.length,
    )
    if (sig === inFlightSignature) return
    inFlightSignature = sig

    const reqId = nextReqId++
    latestScoreReqId = reqId
    set({ scoringInProgress: true })

    scoringWorker.postMessage({
      type: 'score',
      reqId,
      bounds,
      currentTime: currentTime.getTime(),
      stationLat: currentStation.lat,
      stationLon: currentStation.lon,
      tidePredictions,
      species,
      windSpeedKt: 0, // Step 13 wires this from NWS
      maxUnits: MAX_SCORED_UNITS,
    })
  },
}))
