import { create } from 'zustand'
import { format as formatDate } from 'date-fns'
import type {
  Bounds,
  DayCondition,
  HeatZone,
  LatLon,
  LocationStatus,
  ScoringContext,
  ScoringResult,
  ScoringUnit,
  Species,
  TimeMode,
  UserLocation,
  Waypoint,
} from '@/types'
import {
  listAllWaypoints,
  newWaypointId,
  persistWaypoint,
  removeWaypoint,
} from '@/lib/waypoints'
import { getNearestStation, type Station } from '@/lib/stations'
import type { NamedAnchor } from '@/lib/anchors'
import {
  assembleTideWindow,
  fetchTidePredictions,
  tideLevelAtFt,
  type TidePrediction,
} from '@/lib/tides'
import {
  fetchWeather,
  frontalPhaseAt,
  pressureAt,
  pressureTrendInHgPer3hAt,
  type HourlyPeriod,
  type PressureSample,
  type WeatherSnapshot,
} from '@/lib/weather'
import type { WorkerToMain } from '@/workers/scoring.worker'

const PERDIDO_BAY: LatLon = { lat: 30.317, lon: -87.436 }
const DEFAULT_ZOOM = 12

// Auto-activation window for Trip Mode (handoff doc, locked):
//   May 30, 2026 → June 14, 2026 inclusive
// The window is intentionally a few days wider than the actual June 1–12
// trip so the picker is already focused on the trip cards before the user
// leaves home (May 30/31) and stays put for a "review the trip" day after
// (June 13/14). Month indexes here are 0-based.
const TRIP_AUTO_START_MS = new Date(2026, 4, 30, 0, 0, 0, 0).getTime() // May 30 00:00 local
const TRIP_AUTO_END_MS = new Date(2026, 5, 15, 0, 0, 0, 0).getTime() // June 15 00:00 local (exclusive)
const TRIP_STORAGE_KEY = 'trip:active' // per handoff doc storage keys

// Step 16 — bottom-sheet snap-point persistence so the user's preferred
// sheet position survives reload.
//
// Step 22 follow-up: added `'handle'` (a ~36px thin tab) as the NEW DEFAULT
// snap point. Fresh installs open with only the drag handle visible so the
// map dominates the screen. `'peek'` remains as a secondary state reachable
// by dragging — it's no longer the auto-default. Existing users with a
// stored 'peek' / 'half' / 'full' keep their preference; only new visitors
// (and post-reset users) land on 'handle'.
const SHEET_SNAP_STORAGE_KEY = 'settings:sheetSnap'
export type SheetSnapPoint = 'handle' | 'peek' | 'half' | 'full'
function loadSheetSnap(): SheetSnapPoint {
  try {
    const raw = window.localStorage.getItem(SHEET_SNAP_STORAGE_KEY)
    if (raw === 'handle' || raw === 'peek' || raw === 'half' || raw === 'full') return raw
  } catch {}
  return 'handle'
}
function saveSheetSnap(s: SheetSnapPoint): void {
  try {
    window.localStorage.setItem(SHEET_SNAP_STORAGE_KEY, s)
  } catch {}
}

// Step 16 — tier filter chips at the Half snap. 'all' shows every scored
// unit; 'fire+' keeps fires only; 'hot+' keeps hot + fire.
export type TierFilter = 'all' | 'fire+' | 'hot+'

// Step 18 — On-Water Mode persistence.
const ONWATER_STORAGE_KEY = 'settings:onWater'
function loadOnWaterMode(): boolean {
  try {
    return window.localStorage.getItem(ONWATER_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}
function saveOnWaterMode(v: boolean): void {
  try {
    if (v) window.localStorage.setItem(ONWATER_STORAGE_KEY, 'true')
    else window.localStorage.removeItem(ONWATER_STORAGE_KEY)
  } catch {}
}
const ONWATER_PROMPT_DISMISS_KEY = 'settings:onWaterPromptDismissed'
function loadOnWaterPromptDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(ONWATER_PROMPT_DISMISS_KEY) === 'true'
  } catch {
    return false
  }
}
function saveOnWaterPromptDismissed(): void {
  try {
    window.sessionStorage.setItem(ONWATER_PROMPT_DISMISS_KEY, 'true')
  } catch {}
}

// Step 13.6 — depth filter mode persistence.
const DEPTH_FILTER_STORAGE_KEY = 'settings:depthFilter'
export type DepthFilterMode = 'strict' | 'tide_aware' | 'tag_only'
function loadDepthFilter(): DepthFilterMode {
  try {
    const raw = window.localStorage.getItem(DEPTH_FILTER_STORAGE_KEY)
    if (raw === 'strict' || raw === 'tide_aware' || raw === 'tag_only') return raw
  } catch {}
  return 'tide_aware'
}
function saveDepthFilter(mode: DepthFilterMode): void {
  try {
    window.localStorage.setItem(DEPTH_FILTER_STORAGE_KEY, mode)
  } catch {}
}

/**
 * Resolves whether Trip Mode is currently active. `override` comes from the
 * Zustand store and reflects user intent (null = follow auto, true = force on,
 * false = force off). When null, the auto-window decides.
 */
export function isTripModeActive(
  override: boolean | null,
  today: Date = new Date(),
): boolean {
  if (override !== null) return override
  const ms = today.getTime()
  return ms >= TRIP_AUTO_START_MS && ms < TRIP_AUTO_END_MS
}

function loadTripOverride(): boolean | null {
  try {
    const raw = window.localStorage.getItem(TRIP_STORAGE_KEY)
    if (raw === null || raw === '') return null
    return raw === 'true'
  } catch {
    return null
  }
}

function saveTripOverride(value: boolean | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(TRIP_STORAGE_KEY)
    } else {
      window.localStorage.setItem(TRIP_STORAGE_KEY, String(value))
    }
  } catch {
    // Storage unavailable; non-fatal.
  }
}
// 2000 leaves headroom over the prior 500 cap so the dev panel and Step 7's
// heat rendering have more than one tier visible. Fires never count toward
// the cap; see the worker's tier-priority slicing.
const MAX_SCORED_UNITS = 2000

// Step 13.6 added 'contours' alongside the original three habitat flags.
// Treated as a habitat-like overlay for UI consistency with the dev panel,
// though it's a depth visibility layer rather than a habitat feature.
export type HabitatKey = 'seagrass' | 'oysters' | 'wetlands' | 'contours'
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

  // NWS weather snapshot for the current map center (rounded for cache hits).
  // null until first fetch resolves, or when the network failed and no cache
  // was available — scoring degrades to wind=0 in that case.
  currentWeather: WeatherSnapshot | null
  weatherLoading: boolean

  // Scoring
  species: Species
  scoredUnits: ScoredEntry[]
  zones: HeatZone[]
  scoringInProgress: boolean
  /** Step 20: true when the worker watchdog fires before a score
   *  response. UI surfaces a "Scoring stalled — try reloading" toast. */
  scoringStalled: boolean
  lastScoringMs: number
  habitatIndexReady: boolean

  // The unit currently shown in the zone popup, or null when the popup is
  // dismissed. Set by clicking a heat zone polygon or an individual dot.
  selectedZone: ScoredEntry | null
  // The named anchor (verified reef / restoration / launch) currently shown
  // in the anchor popup, or null. These are identity pins, not scoring.
  selectedAnchor: NamedAnchor | null

  // Time strip mode + 7-day picker data. dayConditions is the precomputed
  // per-day summary the picker reads; dayCount is parameterized so Step 12
  // (Trip Mode) can render 12 cards from the same plumbing.
  timeMode: TimeMode
  dayConditions: DayCondition[]
  dayConditionsLoading: boolean
  /** User override for Trip Mode. null = follow auto-window; true/false = manual. */
  tripModeOverride: boolean | null

  // Step 13.6 depth integration
  depthFilterMode: DepthFilterMode

  // Step 14 — saved waypoints (persisted in window.localStorage under
  // `waypoints:{uuid}`). The store mirrors the persisted set; persistence
  // is write-through via lib/waypoints.ts.
  waypoints: Waypoint[]
  /** The waypoint currently inside its 4.5s "tap toast to rename" window.
   *  null when no save is pending. The Save flow uses this to know which
   *  waypoint the toast / rename inline should target. */
  pendingRenameWaypointId: string | null
  /** Waypoint shown in the saved-waypoint popup when a map pin is tapped. */
  selectedWaypointId: string | null
  /** Step 15: id of a waypoint the WaypointsList asked the map to fly to.
   *  MapView watches this, calls `map.flyTo(...)`, then clears it. */
  pendingFlyToWaypointId: string | null
  /** Step 16: ad-hoc fly-to target from the TopZonesList (not a saved
   *  waypoint). MapView watches this, calls flyTo, clears. */
  pendingFlyToLatLon: LatLon | null

  // Step 16 bottom-sheet state
  sheetSnapPoint: SheetSnapPoint
  tierFilter: TierFilter

  // Step 17 — GPS / Locate Me state.
  // userLocation is null until the first fix lands; once present, it
  // updates on every watchPosition tick. The UI doesn't pan automatically
  // (battery + UX) — only on explicit "centerMapOnUser" calls and on the
  // very first fix after the user opted in.
  userLocation: UserLocation | null
  locationStatus: LocationStatus
  locationWatchActive: boolean
  /** Set by the geolocation watcher when the user appears to be on the
   *  water (moving > 2 mph for 5+ min inside the coverage bbox). Step 18
   *  reads this to prompt the On-Water Mode toggle. Phase-1 stub. */
  onWaterCandidate: boolean
  /** True after we've automatically centred the map on the user's first
   *  fix in this session, so subsequent fixes don't keep yanking the
   *  view away from wherever the user has panned. */
  hasAutoCenteredOnUser: boolean

  // Step 18 — On-Water Mode.
  /** Whether the one-thumb sun-readable layout is active. Persisted to
   *  `settings:onWater` so the user reopens in the mode they left in. */
  onWaterMode: boolean
  /** True for the rest of the SESSION (sessionStorage) once the user
   *  taps "Not now" on the auto-prompt, so we don't pester them. */
  onWaterAutoPromptDismissed: boolean
  /** Captures the sheet snap point at the moment On-Water Mode is enabled
   *  so we can restore it cleanly on exit. Null when not in On-Water Mode
   *  or when the snap wasn't restored from a prior entry. */
  sheetSnapBeforeOnWater: SheetSnapPoint | null

  setCenter: (center: LatLon) => void
  setZoom: (zoom: number) => void
  setBounds: (bounds: Bounds) => void
  setCurrentTime: (currentTime: Date) => void
  setSpecies: (species: Species) => void
  selectZone: (payload: ScoredEntry | null) => void
  selectAnchor: (payload: NamedAnchor | null) => void
  setTimeMode: (mode: TimeMode) => void
  setTripModeOverride: (value: boolean | null) => void
  setDepthFilterMode: (mode: DepthFilterMode) => void

  /** Step 14: save a waypoint for the given scored entry + scoring context.
   *  Builds the default label, generates an id, persists, and seeds
   *  pendingRenameWaypointId so the toast can offer rename. */
  saveWaypoint: (
    unit: ScoringUnit,
    result: ScoringResult,
    ctx: ScoringContext,
    depthMLLWFt: number | null,
  ) => string
  renameWaypoint: (id: string, newLabel: string) => void
  deleteWaypoint: (id: string) => void
  /** Clears `pendingRenameWaypointId`. The toast calls this on auto-dismiss
   *  or when the rename inline closes. */
  clearPendingRename: () => void
  selectWaypoint: (id: string | null) => void
  /** Step 15: ask the map to fly to a saved waypoint and open its popup.
   *  Sets `pendingFlyToWaypointId` AND `selectedWaypointId` in one update so
   *  the popup is already ready by the time the fly-to settles. */
  flyToWaypoint: (id: string) => void
  /** Cleared by MapView once it has consumed the fly-to. */
  clearPendingFlyTo: () => void
  /** Step 16: ad-hoc fly-to from the TopZonesList. Selects a unit (so the
   *  ZonePopup opens) AND queues the lat/lon for the map. */
  flyToScoredUnit: (entry: ScoredEntry) => void
  setSheetSnapPoint: (snap: SheetSnapPoint) => void
  setTierFilter: (filter: TierFilter) => void

  /** Step 17 — geolocation actions. The lib/geolocation.ts module owns the
   *  navigator.geolocation handle and visibility wiring; these actions are
   *  thin shims that let UI components trigger / read state. */
  setLocationStatus: (status: LocationStatus) => void
  setUserLocation: (loc: UserLocation | null) => void
  setLocationWatchActive: (active: boolean) => void
  setOnWaterCandidate: (v: boolean) => void
  markAutoCentered: () => void
  /** Called when the user explicitly stops tracking. Clears the dot. */
  clearUserLocation: () => void

  /** Step 18 actions. */
  setOnWaterMode: (v: boolean) => void
  dismissOnWaterPrompt: () => void
  toggleHabitat: (key: HabitatKey) => void
  setHabitatLoading: (key: HabitatKey, isLoading: boolean) => void
  updateTideStation: (mapCenter: LatLon) => Promise<void>
  updateWeather: (mapCenter: LatLon) => Promise<void>
  recomputeScoredUnits: () => void
  /**
   * Compute per-day conditions for `dayCount` consecutive days starting at
   * `startDate`. Step 11 calls with (today, 7); Step 12 will call with
   * (June 1, 12).
   */
  recomputeDayConditions: (startDate: Date, dayCount: number) => Promise<void>
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

// Step 20 — worker watchdog. If the worker doesn't respond within 90s
// of a posted score request we surface a banner so the user can reload
// instead of staring at a frozen spinner.
const SCORING_WATCHDOG_MS = 90_000
let watchdogTimer: ReturnType<typeof setTimeout> | null = null
function startScoringWatchdog(): void {
  if (watchdogTimer) clearTimeout(watchdogTimer)
  watchdogTimer = setTimeout(() => {
    console.error(
      `[store] scoring watchdog fired — no worker response in ${SCORING_WATCHDOG_MS}ms`,
    )
    inFlightSignature = null
    useBitePlanStore.setState({ scoringInProgress: false, scoringStalled: true })
  }, SCORING_WATCHDOG_MS)
}
function clearScoringWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}

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
let latestDayConditionsReqId = 0
let inFlightDayConditionsSig: string | null = null

function buildRequestSignature(
  bounds: Bounds,
  currentTime: Date,
  species: Species,
  stationId: string,
  predictionsLen: number,
  depthFilterMode: DepthFilterMode,
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
    depthFilterMode,
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
    clearScoringWatchdog()
    useBitePlanStore.setState({
      scoredUnits: msg.entries,
      zones: msg.zones,
      scoringInProgress: false,
      scoringStalled: false,
      lastScoringMs: msg.ms,
    })
  }
  if (msg.type === 'dayConditions') {
    if (msg.reqId !== latestDayConditionsReqId) return
    inFlightDayConditionsSig = null
    useBitePlanStore.setState({
      dayConditions: msg.results,
      dayConditionsLoading: false,
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

  habitatLayers: { seagrass: false, oysters: false, wetlands: false, contours: false },
  habitatLoading: { seagrass: false, oysters: false, wetlands: false, contours: false },

  currentStation: getNearestStation(PERDIDO_BAY.lat, PERDIDO_BAY.lon),
  tidePredictions: [],
  tideLoading: true,
  currentWeather: null,
  weatherLoading: true,

  species: 'all',
  scoredUnits: [],
  zones: [],
  scoringInProgress: false,
  scoringStalled: false,
  lastScoringMs: 0,
  habitatIndexReady: false,
  selectedZone: null,
  selectedAnchor: null,

  timeMode: '24h',
  dayConditions: [],
  dayConditionsLoading: false,
  tripModeOverride: loadTripOverride(),
  depthFilterMode: loadDepthFilter(),
  // Hydrate the in-memory waypoint mirror from localStorage at store-create
  // time. Subsequent saves write through lib/waypoints.ts.
  waypoints: listAllWaypoints(),
  pendingRenameWaypointId: null,
  selectedWaypointId: null,
  pendingFlyToWaypointId: null,
  pendingFlyToLatLon: null,
  sheetSnapPoint: loadSheetSnap(),
  tierFilter: 'all',
  userLocation: null,
  locationStatus: 'off',
  locationWatchActive: false,
  onWaterCandidate: false,
  hasAutoCenteredOnUser: false,
  onWaterMode: loadOnWaterMode(),
  onWaterAutoPromptDismissed: loadOnWaterPromptDismissed(),
  sheetSnapBeforeOnWater: null,

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
  selectAnchor: (payload) => set({ selectedAnchor: payload }),
  setTimeMode: (mode) => {
    set({ timeMode: mode })
    // Lazy-trigger day-conditions compute the first time the picker is shown
    // (or when the bounds it was last computed against no longer match).
    if (mode === '7day' && get().dayConditions.length === 0 && get().habitatIndexReady) {
      void get().recomputeDayConditions(new Date(), 7)
    }
  },
  setTripModeOverride: (value) => {
    saveTripOverride(value)
    set({ tripModeOverride: value })
    // Recompute will be triggered by the picker components when their
    // (startDate, dayCount) changes — no work here.
  },
  setDepthFilterMode: (mode) => {
    saveDepthFilter(mode)
    set({ depthFilterMode: mode })
    // Filter mode affects which units survive the worker pass — kick a
    // recompute so the dots update immediately.
    get().recomputeScoredUnits()
  },

  saveWaypoint: (unit, result, ctx, depthMLLWFt) => {
    const id = newWaypointId()
    const createdAt = Date.now()
    const scoredAt = ctx.time.getTime()
    // Default label: "Waypoint — Mon DD, h:mm AM/PM" in LOCAL time. Per the
    // handoff doc this matches `date-fns` format string "MMM d, h:mm a".
    const label = `Waypoint — ${formatDate(ctx.time, 'MMM d, h:mm a')}`
    const [lon, lat] = unit.centroid
    const w: Waypoint = {
      id,
      label,
      lat,
      lon,
      createdAt,
      scoredAt,
      habitatType: unit.habitatType,
      tier: result.tier,
      score: result.score,
      tideState: ctx.tideState,
      species: ctx.species,
      // Snapshot the convergence tags as plain { subtype, description }
      // records so the saved entry doesn't drift if the tag type union
      // changes in a future audit. `subtype` mirrors `ConvergenceTag.type`.
      convergenceTags: unit.convergence.map((t) => ({
        subtype: t.type,
        description: t.description,
      })),
      depthMLLWFt,
    }
    persistWaypoint(w)
    set((s) => ({
      waypoints: [...s.waypoints, w],
      pendingRenameWaypointId: id,
    }))
    return id
  },

  renameWaypoint: (id, newLabel) => {
    set((s) => {
      const next = s.waypoints.map((w) => (w.id === id ? { ...w, label: newLabel } : w))
      const found = next.find((w) => w.id === id)
      if (found) persistWaypoint(found)
      return { waypoints: next }
    })
  },

  deleteWaypoint: (id) => {
    removeWaypoint(id)
    set((s) => ({
      waypoints: s.waypoints.filter((w) => w.id !== id),
      // If the just-deleted waypoint was the pending-rename target, clear it
      // so the toast / rename UI doesn't try to act on a missing waypoint.
      pendingRenameWaypointId:
        s.pendingRenameWaypointId === id ? null : s.pendingRenameWaypointId,
    }))
  },

  clearPendingRename: () => set({ pendingRenameWaypointId: null }),
  selectWaypoint: (id) => set({ selectedWaypointId: id }),
  flyToWaypoint: (id) =>
    set({ pendingFlyToWaypointId: id, selectedWaypointId: id }),
  clearPendingFlyTo: () => set({ pendingFlyToWaypointId: null, pendingFlyToLatLon: null }),
  flyToScoredUnit: (entry) => {
    const [lon, lat] = entry.unit.centroid
    set({
      pendingFlyToLatLon: { lat, lon },
      selectedZone: entry,
    })
  },
  setSheetSnapPoint: (snap) => {
    saveSheetSnap(snap)
    set({ sheetSnapPoint: snap })
  },
  setTierFilter: (filter) => set({ tierFilter: filter }),
  setLocationStatus: (status) => set({ locationStatus: status }),
  setUserLocation: (loc) => set({ userLocation: loc }),
  setLocationWatchActive: (active) => set({ locationWatchActive: active }),
  setOnWaterCandidate: (v) => set({ onWaterCandidate: v }),
  markAutoCentered: () => set({ hasAutoCenteredOnUser: true }),
  clearUserLocation: () =>
    set({
      userLocation: null,
      locationStatus: 'off',
      locationWatchActive: false,
      onWaterCandidate: false,
      hasAutoCenteredOnUser: false,
    }),
  setOnWaterMode: (v) => {
    saveOnWaterMode(v)
    if (v) {
      const cur = get()
      // Snapshot the current snap point so we can restore it on exit.
      // Then collapse to peek (the sheet's translateY off-screen rule is
      // applied in BottomSheet.tsx based on onWaterMode).
      set({
        onWaterMode: true,
        sheetSnapBeforeOnWater: cur.sheetSnapPoint,
        sheetSnapPoint: 'peek',
      })
    } else {
      const cur = get()
      const restore = cur.sheetSnapBeforeOnWater ?? 'half'
      set({
        onWaterMode: false,
        sheetSnapPoint: restore,
        sheetSnapBeforeOnWater: null,
      })
      // Mirror to the sheet's snap-storage so a reload keeps the snap
      // the user explicitly restored to.
      saveSheetSnap(restore)
    }
  },
  dismissOnWaterPrompt: () => {
    saveOnWaterPromptDismissed()
    set({ onWaterAutoPromptDismissed: true })
  },

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

  updateWeather: async (mapCenter) => {
    set({ weatherLoading: true })
    try {
      const snapshot = await fetchWeather(mapCenter.lat, mapCenter.lon)
      set({ currentWeather: snapshot, weatherLoading: false })
      // Real wind data → re-score so the wind factor reflects observed value.
      get().recomputeScoredUnits()
    } catch (e) {
      console.error('[store] updateWeather failed:', e)
      set({ weatherLoading: false })
    }
  },

  /**
   * Send the current view + scoring context to the worker. The response
   * arrives asynchronously via the module-scope onmessage handler.
   */
  recomputeScoredUnits: () => {
    const { bounds, currentTime, currentStation, tidePredictions, species, habitatIndexReady, currentWeather } =
      get()
    if (!habitatIndexReady) return
    if (!bounds) return

    // Skip if a request with this exact context is already in flight. This
    // collapses the 3-4 cold-pass triggers (init-complete, tide-fetch-success,
    // initial moveend, invalidateSize moveend) into ONE worker pass.
    const { depthFilterMode } = get()
    const sig = buildRequestSignature(
      bounds,
      currentTime,
      species,
      currentStation.id,
      tidePredictions.length,
      depthFilterMode,
    )
    if (sig === inFlightSignature) return
    inFlightSignature = sig

    const reqId = nextReqId++
    latestScoreReqId = reqId
    set({ scoringInProgress: true })
    startScoringWatchdog()

    // Step 13.5: derive the audit-v2 environmental fields once per request.
    // Per-window context inside the worker (day-conditions, projection) will
    // re-derive these from the same packed arrays we ship below.
    const env = deriveCurrentEnv(currentWeather, currentTime)
    // Step 13.6: interpolated water level above MLLW for the depth filter.
    const tideLevelAboveMLLWFt = tideLevelAtFt(tidePredictions, currentTime)

    scoringWorker.postMessage({
      type: 'score',
      reqId,
      bounds,
      currentTime: currentTime.getTime(),
      stationLat: currentStation.lat,
      stationLon: currentStation.lon,
      tidePredictions,
      species,
      windSpeedKt: currentWeather?.current.speedKt ?? 0,
      windDirectionCompass: currentWeather?.current.directionCompass,
      hourlyWind: currentWeather?.hourly.map(packHourly) ?? [],
      pressureSeries: currentWeather?.pressureSeries.map(packPressure) ?? [],
      waterTempF: env.waterTempF,
      pressureInHg: env.pressureInHg,
      pressureTrendInHgPer3h: env.pressureTrendInHgPer3h,
      frontalPhase: env.frontalPhase,
      airTempF: currentWeather?.current.temperatureF ?? 0,
      tideLevelAboveMLLWFt,
      depthFilterMode,
      maxUnits: MAX_SCORED_UNITS,
    })
  },

  recomputeDayConditions: async (startDate, dayCount) => {
    const { bounds, currentStation, species, habitatIndexReady } = get()
    if (!habitatIndexReady) return
    if (!bounds) return

    // Coalesce on signature: bounds + start day + dayCount + species + station.
    // (Identical signature in flight → skip.)
    const sig = [
      bounds.west.toFixed(4),
      bounds.south.toFixed(4),
      bounds.east.toFixed(4),
      bounds.north.toFixed(4),
      startDate.toDateString(),
      dayCount,
      species,
      currentStation.id,
    ].join('|')
    if (sig === inFlightDayConditionsSig) return
    inFlightDayConditionsSig = sig

    set({ dayConditionsLoading: true })

    // Assemble a wide tide-prediction window: yesterday → startDate+dayCount,
    // so the worker's getCurrentTideState can bracket across day boundaries
    // for the whole computed range. Reuses the SWR cache, so adjacent days
    // fetched by other features (projection, main scoring) cost nothing.
    const dayMs = 24 * 60 * 60 * 1000
    const dayDates: Date[] = []
    for (let d = -1; d <= dayCount; d++) {
      const day = new Date(startDate)
      day.setDate(day.getDate() + d)
      dayDates.push(day)
    }
    const fetched = await Promise.all(
      dayDates.map((d) =>
        fetchTidePredictions(currentStation.id, d).catch(() => [] as TidePrediction[]),
      ),
    )
    const tidePredictions = fetched.flat()

    // Use local-midnight of startDate as the day origin.
    const startMidnight = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate(),
      0, 0, 0, 0,
    )

    const reqId = nextReqId++
    latestDayConditionsReqId = reqId

    const weather = get().currentWeather
    // For day conditions we use TODAY's current env as the carry-forward
    // fallback. The worker re-derives per-window env (water-temp estimate,
    // pressure trend, frontal phase, tide level) when the packed pressure /
    // hourly / tide series cover the window time; otherwise it falls back
    // to these.
    const env = deriveCurrentEnv(weather, startDate)
    const fallbackTideLevelFt = tideLevelAtFt(tidePredictions, startDate)
    const { depthFilterMode: dfm } = get()
    scoringWorker.postMessage({
      type: 'computeDayConditions',
      reqId,
      bounds,
      dayCount,
      startDateMs: startMidnight.getTime(),
      stationLat: currentStation.lat,
      stationLon: currentStation.lon,
      tidePredictions,
      species,
      windSpeedKt: weather?.current.speedKt ?? 0,
      windDirectionCompass: weather?.current.directionCompass,
      hourlyWind: weather?.hourly.map(packHourly) ?? [],
      pressureSeries: weather?.pressureSeries.map(packPressure) ?? [],
      waterTempF: env.waterTempF,
      pressureInHg: env.pressureInHg,
      pressureTrendInHgPer3h: env.pressureTrendInHgPer3h,
      frontalPhase: env.frontalPhase,
      airTempF: weather?.current.temperatureF ?? 0,
      tideLevelAboveMLLWFt: fallbackTideLevelFt,
      depthFilterMode: dfm,
    })
    void dayMs
  },
}))

// Compact form of HourlyPeriod for transmission to the worker. Step 13.5
// keeps temperature + forecast text now too — the worker needs them to derive
// per-window water-temp estimates and per-window frontal-phase signals when
// scoring the 12-day trip dashboard or the projection's 56 future windows.
function packHourly(p: HourlyPeriod) {
  return {
    startMs: p.startMs,
    endMs: p.endMs,
    windSpeedKt: p.windSpeedKt,
    windDirectionCompass: p.windDirectionCompass,
    temperatureF: p.temperatureF,
    shortForecast: p.shortForecast,
    precipProbability: p.precipProbability,
  }
}

// Compact form of PressureSample — identical shape but isolated as a separate
// type so changes to the weather module don't ripple into the worker
// message contract.
function packPressure(s: PressureSample) {
  return { startMs: s.startMs, endMs: s.endMs, inHg: s.inHg }
}

/**
 * Step 13.5 — seasonal lag estimate from air temp → water temp. Used both
 * for the "current" scoring snapshot and per-window in the worker (which
 * imports this helper indirectly via its own packed copy).
 *
 * TODO: replace with NDBC station #42012 buoy data in a future step for
 * true water temp.
 */
export function estimateWaterTempF(airTempF: number, month: number): number {
  if (!Number.isFinite(airTempF) || airTempF === 0) return 0
  // Spring (Mar-May): water lags ~3°F behind air.
  if (month >= 3 && month <= 5) return airTempF - 3
  // Summer (Jun-Aug): ~2°F behind.
  if (month >= 6 && month <= 8) return airTempF - 2
  // Fall (Sep-Nov): air cools faster than water → water runs warmer.
  if (month >= 9 && month <= 11) return airTempF + 2
  // Winter (Dec-Feb): water holds warmth longest.
  return airTempF + 5
}

/**
 * Step 13.5 — derive scoring-context environmental fields from a weather
 * snapshot at the current scoring time. Returns the four new ScoringContext
 * fields needed by the audit-v2 scoring rules. When weather is null we hand
 * back neutral defaults so the rules degrade gracefully.
 */
export function deriveCurrentEnv(
  weather: WeatherSnapshot | null,
  atTime: Date,
): {
  waterTempF: number
  pressureInHg: number
  pressureTrendInHgPer3h: number
  frontalPhase: 'pre' | 'during' | 'post' | 'stable'
} {
  if (!weather) {
    return {
      waterTempF: 0,
      pressureInHg: 30.0,
      pressureTrendInHgPer3h: 0,
      frontalPhase: 'stable',
    }
  }
  const tMs = atTime.getTime()
  const month = atTime.getMonth() + 1
  const airTempF = weather.current.temperatureF
  const pressureInHg = pressureAt(weather, tMs) ?? 30.0
  const trend = pressureTrendInHgPer3hAt(weather, tMs)
  const phase = frontalPhaseAt(weather, tMs)
  return {
    waterTempF: estimateWaterTempF(airTempF, month),
    pressureInHg,
    pressureTrendInHgPer3h: trend,
    frontalPhase: phase,
  }
}
