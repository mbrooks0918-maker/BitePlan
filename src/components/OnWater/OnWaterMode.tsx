/**
 * On-Water Mode (Step 18) — one-thumb sun-readable UI for actually being
 * out on the kayak. Mounted by MapView; only renders its overlays when
 * `store.onWaterMode === true`. The bottom sheet, time strip, filter
 * chips, etc. are all hidden by the existing components reading
 * `onWaterMode`.
 *
 * Three overlays compose the layout:
 *
 *   - Top-left:  Exit X button + giant tide pill (tappable to expand)
 *   - Top-right: the existing LocateButton (size-bumped via its own
 *                onWaterMode check)
 *   - Bottom-right: giant Save Waypoint button anchored to GPS
 *
 * Plus an auto-prompt card that appears at the top of the screen when
 * the geolocation manager flips `onWaterCandidate` true while we're NOT
 * already in On-Water Mode (and the prompt hasn't been session-dismissed).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { BookmarkPlus, X as XIcon } from 'lucide-react'
import { getCurrentTideState, type TideState } from '@/lib/tides'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { ScoringContext, Tier } from '@/types'
import type { ScoredEntry } from '@/store/useBitePlanStore'
import { deriveCurrentEnv } from '@/store/useBitePlanStore'
import { dailyTideRange, tideLevelAtFt } from '@/lib/tides'
import { getMoonIllumination, getSunTimes } from '@/lib/moon'
import { getDepthAtMLLW, initDepthGrid } from '@/lib/depth'

// Tier-color tide-pill background. Same palette the TideReadout used,
// scaled up for sun-readability.
const TIDE_BG: Record<TideState, string> = {
  rising: 'bg-teal-900/80',
  falling: 'bg-amber-900/80',
  slack: 'bg-slate-900/80',
}
const TIER_CHIP: Record<Tier, string> = {
  fire: 'bg-red-600 text-white',
  hot: 'bg-orange-500 text-white',
  driveby: 'bg-yellow-500 text-slate-900',
}

// Haversine distance in metres — used to pick the nearest scored unit to
// the user's current GPS position for "synthesised" Save Waypoint data.
function distMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

const NEAREST_LOOKUP_RADIUS_M = 50

// ---- Exit X button ------------------------------------------------------
function OnWaterExitButton() {
  const setOnWaterMode = useBitePlanStore((s) => s.setOnWaterMode)
  return (
    <button
      type="button"
      aria-label="Exit On-Water Mode"
      onClick={() => setOnWaterMode(false)}
      className={
        'fixed top-4 left-4 z-[1100] size-12 rounded-full ' +
        'bg-slate-900/70 hover:bg-slate-900/90 text-slate-100 ' +
        'shadow-lg backdrop-blur-sm flex items-center justify-center ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400'
      }
    >
      <XIcon className="size-5" aria-hidden />
    </button>
  )
}

// ---- Giant tide pill ---------------------------------------------------
function OnWaterTidePill() {
  const station = useBitePlanStore((s) => s.currentStation)
  const predictions = useBitePlanStore((s) => s.tidePredictions)
  const tideLoading = useBitePlanStore((s) => s.tideLoading)
  const currentTime = useBitePlanStore((s) => s.currentTime)
  const scoredUnits = useBitePlanStore((s) => s.scoredUnits)
  const [expanded, setExpanded] = useState(false)

  let bg = 'bg-slate-900/80'
  let stateText = '—'
  let subText = ''
  let nextEvent: { t: string; type: 'H' | 'L' } | null = null
  if (tideLoading) {
    subText = 'Loading…'
  } else if (predictions.length === 0) {
    stateText = '—'
    subText = 'Tide unavailable'
  } else {
    const { state, nextEvent: ne } = getCurrentTideState(predictions, currentTime)
    bg = TIDE_BG[state]
    stateText = state.toUpperCase()
    if (ne) {
      nextEvent = { t: ne.t, type: ne.type }
      const eventDate = parseISO(ne.t)
      const sameDay =
        eventDate.getFullYear() === currentTime.getFullYear() &&
        eventDate.getMonth() === currentTime.getMonth() &&
        eventDate.getDate() === currentTime.getDate()
      const fmt = sameDay
        ? format(eventDate, 'h:mm a')
        : format(eventDate, 'EEE h:mm a')
      const dir = ne.type === 'H' ? 'HIGH' : 'LOW'
      subText = `→ ${fmt} ${dir}`
    } else {
      subText = '· END OF DAY'
    }
  }

  // Conditions score — the top in-view unit's tier and rounded score.
  let score = '—'
  let scoreClass = 'bg-slate-700 text-slate-300'
  if (scoredUnits.length > 0) {
    let top: ScoredEntry = scoredUnits[0]
    for (const e of scoredUnits) if (e.result.score > top.result.score) top = e
    score = String(Math.max(1, Math.min(10, Math.round(top.result.score))))
    scoreClass = TIER_CHIP[top.result.tier as Tier]
  }

  // Expanded view: next 4 hi/lo events around current time.
  const upcomingEvents = useMemo(() => {
    if (!nextEvent) return []
    const nowMs = currentTime.getTime()
    return predictions
      .map((p) => ({ ...p, ms: parseISO(p.t).getTime() }))
      .filter((p) => p.ms >= nowMs - 6 * 60 * 60 * 1000)
      .sort((a, b) => a.ms - b.ms)
      .slice(0, 4)
  }, [predictions, currentTime, nextEvent])

  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`Tide ${stateText} ${subText}`}
      onClick={() => setExpanded((v) => !v)}
      className={
        'fixed top-4 left-20 z-[1090] max-w-[min(75vw,420px)] text-left ' +
        `${bg} text-white rounded-2xl px-5 py-4 shadow-2xl backdrop-blur-md ` +
        'drop-shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ' +
        'transition-all'
      }
      style={{ textShadow: '0 1px 4px rgba(0, 0, 0, 0.85)' }}
    >
      <div className="text-4xl font-extrabold tracking-wider leading-none">
        {stateText}
      </div>
      <div className="mt-1 text-xl font-bold leading-tight">{subText}</div>
      <div className="mt-2 flex items-center gap-2">
        <span className={`${scoreClass} rounded-md px-2 py-0.5 text-sm font-bold tabular-nums`}>
          Score {score}/10
        </span>
        <span className="text-xs text-white/70">{station.name}</span>
      </div>
      {expanded && upcomingEvents.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/20 space-y-1">
          {upcomingEvents.map((p, i) => {
            const d = parseISO(p.t)
            return (
              <div key={`${p.t}-${i}`} className="flex items-center justify-between text-sm font-semibold">
                <span>{format(d, 'EEE h:mm a')}</span>
                <span className="text-white/80">
                  {p.type === 'H' ? 'HIGH' : 'LOW'}
                  <span className="ml-2 text-xs text-white/60 tabular-nums">
                    {p.v.toFixed(1)} ft
                  </span>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </button>
  )
}

// ---- Bottom-right giant Save Waypoint button ---------------------------
function OnWaterSaveButton() {
  const userLocation = useBitePlanStore((s) => s.userLocation)
  const scoredUnits = useBitePlanStore((s) => s.scoredUnits)
  const saveWaypoint = useBitePlanStore((s) => s.saveWaypoint)
  const [toast, setToast] = useState<string | null>(null)

  // Kick the main thread's depth grid lookup table once on mount so we can
  // snapshot depth on the saved waypoint. Same trick the regular Save
  // flow uses in ZonePopup.
  useEffect(() => {
    void initDepthGrid()
  }, [])

  const onSave = useCallback(() => {
    if (!userLocation) {
      setToast(
        'No GPS fix — can\'t save current location. Stand still for a fresh fix or tap a zone manually.',
      )
      window.setTimeout(() => setToast(null), 4500)
      return
    }

    // Find the nearest scored unit within 50m. We use it ONLY for metadata
    // (habitat, tier, convergence tags) — the waypoint's lat/lon is always
    // the GPS fix, not the unit's centroid.
    let nearest: ScoredEntry | null = null
    let nearestDist = Infinity
    for (const e of scoredUnits) {
      const [lon, lat] = e.unit.centroid
      const d = distMeters(userLocation.lat, userLocation.lon, lat, lon)
      if (d < nearestDist && d <= NEAREST_LOOKUP_RADIUS_M) {
        nearestDist = d
        nearest = e
      }
    }

    // Synthesise the ScoringUnit + ScoringResult the saveWaypoint action
    // expects. When we have a nearby scored unit we borrow its habitat
    // and convergence tags; otherwise we fall back to a driveby-tier
    // marsh-edge placeholder anchored at the GPS lat/lon.
    const fallbackUnit = nearest?.unit ?? {
      id: `onwater:${userLocation.timestamp}`,
      unitType: 'edge_point' as const,
      habitatType: 'wetland' as const,
      geometry: { type: 'Point' as const, coordinates: [userLocation.lon, userLocation.lat] },
      centroid: [userLocation.lon, userLocation.lat] as [number, number],
      parentFeatureId: 'onwater',
      convergence: [],
    }
    const fallbackResult = nearest?.result ?? {
      score: 4,
      tier: 'driveby' as const,
      timeInvestment: '5-10 minutes',
      firedFactors: [],
      missingFactors: [],
      projectedNextFire: null,
    }

    // Override centroid to GPS so the saved pin lands where the user
    // actually is — not on the nearby scored unit.
    const gpsUnit = {
      ...fallbackUnit,
      centroid: [userLocation.lon, userLocation.lat] as [number, number],
    }

    // Build the ScoringContext snapshot, matching ZonePopup's onSave path
    // so saved-waypoint metadata is consistent across both entry points.
    const state = useBitePlanStore.getState()
    const { currentTime, currentStation, tidePredictions, species, currentWeather, depthFilterMode } = state
    const { state: tideState } = getCurrentTideState(tidePredictions, currentTime)
    const { sunrise, sunset } = getSunTimes(currentTime, currentStation.lat, currentStation.lon)
    const env = deriveCurrentEnv(currentWeather, currentTime)
    const ctx: ScoringContext = {
      time: currentTime,
      tideState,
      species,
      moonIllumination: getMoonIllumination(currentTime),
      sunrise,
      sunset,
      windSpeedKt: currentWeather?.current.speedKt ?? 0,
      windDirectionCompass: currentWeather?.current.directionCompass,
      dailyTideRangeFt: dailyTideRange(tidePredictions, currentTime),
      month: currentTime.getMonth() + 1,
      hour: currentTime.getHours(),
      waterTempF: env.waterTempF,
      pressureInHg: env.pressureInHg,
      pressureTrendInHgPer3h: env.pressureTrendInHgPer3h,
      frontalPhase: env.frontalPhase,
      tideLevelAboveMLLWFt: tideLevelAtFt(tidePredictions, currentTime),
      depthFilterMode,
    }
    const depth = getDepthAtMLLW(userLocation.lat, userLocation.lon)
    saveWaypoint(gpsUnit, fallbackResult, ctx, depth)
    // SaveToast handles the toast; nothing more for us to do.
  }, [userLocation, scoredUnits, saveWaypoint])

  return (
    <>
      <button
        type="button"
        aria-label="Save waypoint at my location"
        onClick={onSave}
        className={
          'fixed bottom-6 right-6 z-[1090] size-[72px] rounded-full ' +
          'bg-emerald-600 hover:bg-emerald-500 text-white ' +
          'shadow-2xl backdrop-blur-sm flex items-center justify-center ' +
          'drop-shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ' +
          'active:scale-95 transition-transform'
        }
      >
        <BookmarkPlus className="size-8" aria-hidden />
      </button>
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={
            'fixed bottom-32 left-1/2 -translate-x-1/2 z-[1200] max-w-[min(92vw,28rem)] ' +
            'bg-slate-900/95 text-slate-100 rounded-md shadow-2xl border-l-4 border-l-amber-500 ' +
            'px-4 py-3 text-sm'
          }
        >
          {toast}
        </div>
      )}
    </>
  )
}

// ---- Auto-prompt card --------------------------------------------------
function OnWaterAutoPrompt() {
  const candidate = useBitePlanStore((s) => s.onWaterCandidate)
  const dismissed = useBitePlanStore((s) => s.onWaterAutoPromptDismissed)
  const onWater = useBitePlanStore((s) => s.onWaterMode)
  const setOnWaterMode = useBitePlanStore((s) => s.setOnWaterMode)
  const dismiss = useBitePlanStore((s) => s.dismissOnWaterPrompt)

  // Auto-dismiss the card after 30s if neither button is tapped.
  useEffect(() => {
    if (!candidate || dismissed || onWater) return
    const t = window.setTimeout(() => dismiss(), 30_000)
    return () => window.clearTimeout(t)
  }, [candidate, dismissed, onWater, dismiss])

  if (!candidate || dismissed || onWater) return null

  return (
    <div
      role="dialog"
      aria-label="Switch to On-Water Mode?"
      className={
        'fixed inset-x-0 top-4 z-[1200] mx-auto w-[min(92vw,28rem)] ' +
        'bg-slate-900/95 text-slate-100 rounded-xl shadow-2xl border border-slate-700/60 ' +
        'backdrop-blur-sm px-4 py-3'
      }
    >
      <div className="text-sm font-medium mb-2">
        Looks like you’re on the water. Switch to On-Water Mode?
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setOnWaterMode(true)}
          className="flex-1 min-h-[40px] rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold"
        >
          Yes, switch
        </button>
        <button
          type="button"
          onClick={() => dismiss()}
          className="flex-1 min-h-[40px] rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
        >
          Not now
        </button>
      </div>
    </div>
  )
}

// ---- Composite root ----------------------------------------------------
function OnWaterMode() {
  const active = useBitePlanStore((s) => s.onWaterMode)
  // Auto-prompt renders independently of `active` (it asks the user to
  // enter the mode). The overlays only render when active.
  return (
    <>
      <OnWaterAutoPrompt />
      {active && (
        <>
          <OnWaterExitButton />
          <OnWaterTidePill />
          <OnWaterSaveButton />
        </>
      )}
    </>
  )
}

export default OnWaterMode
