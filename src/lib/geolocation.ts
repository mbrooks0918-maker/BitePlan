/**
 * Geolocation manager (Step 17).
 *
 * Owns the single `navigator.geolocation.watchPosition` handle for the
 * session, plus the document `visibilitychange` listener that pauses /
 * resumes tracking when the tab goes background. The store holds the
 * USER-FACING state (status, last fix); this module is just the bridge
 * to the browser API.
 *
 * Key behavioural notes from the handoff doc + Step 17 spec:
 *
 *  - "Locate me" is OPT-IN. Nothing here runs until the user taps the
 *    button. We never auto-call getCurrentPosition on load.
 *  - The watch is **off** unless the user explicitly turned it on. A
 *    permission previously granted does NOT auto-start tracking — battery
 *    courtesy.
 *  - First fix after the user opts in auto-centres the map exactly once;
 *    subsequent fixes update the dot but don't pan.
 *  - Backgrounding the tab for > 60 s pauses watchPosition; foregrounding
 *    resumes it (if status was 'on' at the time of backgrounding).
 *
 * Module-scope state is intentional: only one watch can exist at a time,
 * and the visibility listener should be installed once for the lifetime
 * of the page.
 */
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { UserLocation } from '@/types'

const WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 5_000,
}

// Backgrounding for less than this isn't worth tearing down the watch
// (the user likely just flipped to another app to check the tide). Past
// this we pause and resume on visibility return.
const BACKGROUND_PAUSE_MS = 60_000

// On-water candidate heuristic knobs (stub — Step 18 consumes the flag).
const ONWATER_SPEED_MPH = 2
const ONWATER_SUSTAIN_MS = 5 * 60 * 1000
const COVERAGE_BBOX = { west: -88.30, east: -85.20, south: 29.70, north: 30.80 }

let watchId: number | null = null
let backgroundedAt: number | null = null
let backgroundPauseTimer: number | null = null
let visibilityListenerInstalled = false
// Tracks consecutive on-water-likely positions so we only flip the flag
// once the user has been moving consistently for ONWATER_SUSTAIN_MS.
let onWaterStreakStartMs: number | null = null
// Toast handle owned by the LocateButton via the store — exposed here so
// error paths can fire a brief banner.
type ToastFn = (msg: string) => void
let toastFn: ToastFn | null = null

/** Used by LocateButton to register a toast emitter. */
export function setLocateToastEmitter(fn: ToastFn | null): void {
  toastFn = fn
}

function showToast(msg: string): void {
  if (toastFn) toastFn(msg)
  else console.warn(`[geo] ${msg}`)
}

/**
 * Convert a browser `GeolocationPosition` into our UserLocation shape.
 * Stripping coercion fields keeps the store payload serialisable.
 */
function toUserLocation(p: GeolocationPosition): UserLocation {
  return {
    lat: p.coords.latitude,
    lon: p.coords.longitude,
    accuracyM: Math.round(p.coords.accuracy),
    timestamp: p.timestamp,
  }
}

/**
 * Detect "user appears to be on the water" so Step 18 can offer the
 * On-Water Mode prompt. Heuristic: average speed > 2 mph over the last
 * sustained window, AND the user is inside the coverage bbox.
 *
 * For Phase 1 we approximate "sustained" by tracking the timestamp of the
 * earliest qualifying position in a current "streak" — once the streak is
 * 5+ minutes old, the flag flips on. Any drop below the speed threshold
 * resets the streak.
 *
 * speed comes from the GeolocationCoords.speed field (m/s) when the
 * device provides it; otherwise we compute from the last two positions.
 */
function updateOnWaterCandidate(
  prev: UserLocation | null,
  next: UserLocation,
  rawSpeedMs: number | null,
): void {
  const state = useBitePlanStore.getState()
  const inBbox =
    next.lon >= COVERAGE_BBOX.west &&
    next.lon <= COVERAGE_BBOX.east &&
    next.lat >= COVERAGE_BBOX.south &&
    next.lat <= COVERAGE_BBOX.north
  if (!inBbox) {
    onWaterStreakStartMs = null
    if (state.onWaterCandidate) state.setOnWaterCandidate(false)
    return
  }

  let speedMph = rawSpeedMs != null && rawSpeedMs >= 0 ? rawSpeedMs * 2.23694 : 0
  if (speedMph === 0 && prev) {
    const dt = (next.timestamp - prev.timestamp) / 1000 // s
    if (dt > 0) {
      const R = 6_371_000
      const toRad = (d: number) => (d * Math.PI) / 180
      const dLat = toRad(next.lat - prev.lat)
      const dLon = toRad(next.lon - prev.lon)
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(prev.lat)) * Math.cos(toRad(next.lat)) * Math.sin(dLon / 2) ** 2
      const distM = 2 * R * Math.asin(Math.sqrt(a))
      speedMph = (distM / dt) * 2.23694
    }
  }

  if (speedMph >= ONWATER_SPEED_MPH) {
    if (onWaterStreakStartMs == null) onWaterStreakStartMs = next.timestamp
    if (next.timestamp - onWaterStreakStartMs >= ONWATER_SUSTAIN_MS) {
      if (!state.onWaterCandidate) state.setOnWaterCandidate(true)
    }
  } else {
    onWaterStreakStartMs = null
    if (state.onWaterCandidate) state.setOnWaterCandidate(false)
  }
}

function handlePosition(p: GeolocationPosition): void {
  const state = useBitePlanStore.getState()
  const prev = state.userLocation
  const loc = toUserLocation(p)
  state.setUserLocation(loc)
  if (state.locationStatus !== 'on') state.setLocationStatus('on')
  updateOnWaterCandidate(prev, loc, p.coords.speed)
}

function handleError(e: GeolocationPositionError): void {
  const state = useBitePlanStore.getState()
  if (e.code === e.PERMISSION_DENIED) {
    state.setLocationStatus('denied')
    state.setLocationWatchActive(false)
    showToast('Location access denied. Enable in browser settings to use Locate Me.')
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId)
      watchId = null
    }
    return
  }
  // POSITION_UNAVAILABLE / TIMEOUT — keep the watch alive if we already have
  // a fix (the next tick may recover); otherwise surface error state.
  if (state.userLocation == null) {
    state.setLocationStatus('error')
    state.setLocationWatchActive(false)
    showToast("Couldn't get GPS fix. Try again outdoors.")
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId)
      watchId = null
    }
  } else {
    console.warn('[geo] transient error (keeping existing fix):', e.message)
  }
}

function ensureVisibilityListener(): void {
  if (visibilityListenerInstalled) return
  visibilityListenerInstalled = true
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function onVisibilityChange(): void {
  const state = useBitePlanStore.getState()
  if (document.visibilityState === 'hidden') {
    if (watchId == null) return
    // Mark the time; only ACT after BACKGROUND_PAUSE_MS so a quick tab
    // flip doesn't tear down the watch (and trigger an expensive re-fix
    // on return).
    backgroundedAt = Date.now()
    if (backgroundPauseTimer != null) window.clearTimeout(backgroundPauseTimer)
    backgroundPauseTimer = window.setTimeout(() => {
      if (document.visibilityState !== 'hidden') return
      if (watchId != null) {
        navigator.geolocation.clearWatch(watchId)
        watchId = null
        // Don't change locationStatus — we want to resume seamlessly.
        state.setLocationWatchActive(false)
      }
    }, BACKGROUND_PAUSE_MS)
  } else {
    // Returning to foreground.
    if (backgroundPauseTimer != null) {
      window.clearTimeout(backgroundPauseTimer)
      backgroundPauseTimer = null
    }
    backgroundedAt = null
    // If we paused while backgrounded AND the user was tracking, restart.
    if (watchId == null && state.locationStatus === 'on') {
      startWatch()
    }
  }
}

function startWatch(): void {
  if (watchId != null) return
  if (!('geolocation' in navigator)) {
    showToast('Geolocation not supported in this browser.')
    useBitePlanStore.getState().setLocationStatus('error')
    return
  }
  watchId = navigator.geolocation.watchPosition(
    handlePosition,
    handleError,
    WATCH_OPTIONS,
  )
  useBitePlanStore.getState().setLocationWatchActive(true)
  ensureVisibilityListener()
}

/**
 * Entry point for the LocateButton's "off → on" tap. Triggers the browser
 * permission prompt + initial fix, then arms watchPosition for continuous
 * tracking.
 */
export function requestLocation(): void {
  const state = useBitePlanStore.getState()
  if (state.locationStatus === 'on') return
  if (!('geolocation' in navigator)) {
    showToast('Geolocation not supported in this browser.')
    state.setLocationStatus('error')
    return
  }
  state.setLocationStatus('requesting')
  navigator.geolocation.getCurrentPosition(
    (p) => {
      handlePosition(p)
      startWatch()
    },
    handleError,
    WATCH_OPTIONS,
  )
}

/** Entry point for "on → off" tap (or when explicitly stopping). */
export function stopLocationTracking(): void {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId)
    watchId = null
  }
  if (backgroundPauseTimer != null) {
    window.clearTimeout(backgroundPauseTimer)
    backgroundPauseTimer = null
  }
  backgroundedAt = null
  onWaterStreakStartMs = null
  useBitePlanStore.getState().clearUserLocation()
}

/**
 * Returns true when the user's view is already centred on the fix
 * (within ~10 m). The LocateButton uses this to decide whether to pan
 * or to toggle tracking off on the second tap.
 */
export function isViewCenteredOnUser(
  viewCenter: { lat: number; lon: number },
  loc: UserLocation,
): boolean {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(loc.lat - viewCenter.lat)
  const dLon = toRad(loc.lon - viewCenter.lon)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(viewCenter.lat)) * Math.cos(toRad(loc.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a)) <= 10
}

/**
 * Permissions API probe — called once on app mount. Sets the store's
 * `locationStatus` to 'denied' when the user has previously denied (so
 * the button can render the denied state immediately), but does NOT
 * auto-start tracking on 'granted' (battery courtesy per spec).
 */
export async function probePermissionsOnMount(): Promise<void> {
  if (!('permissions' in navigator) || !navigator.permissions?.query) return
  try {
    const perm = await navigator.permissions.query({ name: 'geolocation' as PermissionName })
    if (perm.state === 'denied') {
      useBitePlanStore.getState().setLocationStatus('denied')
    }
    // Re-check if the user changes the setting at the OS / browser level
    // while the page is open.
    perm.onchange = () => {
      if (perm.state === 'denied') {
        stopLocationTracking()
        useBitePlanStore.getState().setLocationStatus('denied')
      }
    }
  } catch {
    // Permissions API can throw on Safari iOS for 'geolocation' — silent.
  }
  void backgroundedAt
}
