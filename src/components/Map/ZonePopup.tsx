/**
 * Zone popup (Step 8) — the trust layer.
 *
 * Slide-up card triggered by tapping a heat zone polygon or an individual
 * scored unit dot. Shows the full score breakdown:
 *   - Tier header in tier color
 *   - Score + time investment + habitat type
 *   - For hot/fire: every fired factor with check icon
 *   - For driveby: every missing factor with X icon (what's holding it back)
 *   - "Lights up" forward projection (placeholder until Step 9)
 *   - Save Waypoint + Directions CTAs
 *
 * Not a Leaflet popup — a standalone React component that sits over the map
 * in a fixed-position overlay. Dismissible four ways: backdrop tap, X button,
 * Escape key, swipe-down on the card.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { format } from 'date-fns'
import { Check, Navigation, X as XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ScoringContext, ScoringFactor, Tier } from '@/types'
import { useBitePlanStore, type ScoredEntry } from '@/store/useBitePlanStore'
import { getMoonIllumination, getSunTimes } from '@/lib/moon'
import { dailyTideRange, getCurrentTideState } from '@/lib/tides'
import { getCachedProjection, type ProjectionResult } from '@/lib/projection'

// Tier → header background + button background. Spec colors from handoff doc.
const TIER_BG: Record<Tier, string> = {
  fire: 'bg-red-500',
  hot: 'bg-orange-500',
  driveby: 'bg-yellow-500',
}
const TIER_LABEL: Record<Tier, string> = {
  fire: 'FIRE',
  hot: 'HOT',
  driveby: 'DRIVE-BY',
}

const HABITAT_LABEL: Record<ScoredEntry['unit']['habitatType'], string> = {
  seagrass: 'Seagrass edge',
  oyster: 'Oyster bed',
  wetland: 'Marsh edge',
}

function formatDelta(d: number): string {
  // Always show sign: +2, +0.5, -1, 0
  if (d > 0) return `+${d}`
  if (d < 0) return `${d}`
  return '0'
}

function FactorLine({
  factor,
  fired,
}: {
  factor: ScoringFactor
  fired: boolean
}) {
  return (
    <li className="flex items-start gap-2 py-1">
      {fired ? (
        <Check className="size-4 shrink-0 mt-0.5 text-emerald-400" />
      ) : (
        <XIcon className="size-4 shrink-0 mt-0.5 text-red-400" />
      )}
      <span className="flex-1 text-slate-200">{factor.description}</span>
      <span className="shrink-0 text-slate-400 tabular-nums text-xs mt-0.5">
        {formatDelta(factor.delta)}
      </span>
    </li>
  )
}

type ProjectionState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'none' }
  | { status: 'result'; data: ProjectionResult }

function formatProjectionLine(p: ProjectionResult): string {
  const dateStr = format(p.when, "EEE MMM d 'at' h:mm a")
  const prefix = p.tier === 'fire' ? 'Lights up' : 'Best window'
  return `${prefix}: ${dateStr} (${p.score}/10) — ${p.reason}`
}

function ZonePopup() {
  const selectedZone = useBitePlanStore((s) => s.selectedZone)
  const selectZone = useBitePlanStore((s) => s.selectZone)
  // Hour-bucket the currentTime so projection re-runs at most once per hour
  // when the popup is open and the user scrubs the time slider across the
  // hour boundary.
  const currentTimeBucket = useBitePlanStore((s) =>
    Math.floor(s.currentTime.getTime() / (60 * 60 * 1000)),
  )
  const [projection, setProjection] = useState<ProjectionState>({ status: 'loading' })
  const titleId = useId()

  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  // Drag-to-dismiss state. We translate the card downward by `dragY` px while
  // the user drags; if they release past the threshold, we dismiss.
  const [dragY, setDragY] = useState(0)
  const dragStartRef = useRef<number | null>(null)
  const DRAG_DISMISS_PX = 80

  // Focus the close button when the popup opens so Esc / Tab cycle have an
  // anchor inside the dialog.
  useEffect(() => {
    if (selectedZone) closeButtonRef.current?.focus()
  }, [selectedZone])

  // Escape key dismisses.
  useEffect(() => {
    if (!selectedZone) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        selectZone(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedZone, selectZone])

  // Kick off forward projection when the popup opens for a new unit, or when
  // the hour bucket changes (e.g. user scrubbed past midnight).
  useEffect(() => {
    if (!selectedZone) return
    let cancelled = false

    setProjection({ status: 'loading' })

    const state = useBitePlanStore.getState()
    const { currentTime, currentStation, tidePredictions, species } = state
    const { state: tideState } = getCurrentTideState(tidePredictions, currentTime)
    const { sunrise, sunset } = getSunTimes(currentTime, currentStation.lat, currentStation.lon)
    const dailyTideRangeFt = dailyTideRange(tidePredictions, currentTime)

    const ctx: ScoringContext = {
      time: currentTime,
      tideState,
      species,
      moonIllumination: getMoonIllumination(currentTime),
      sunrise,
      sunset,
      windSpeedKt: 0, // Step 13 wires this
      dailyTideRangeFt,
      month: currentTime.getMonth() + 1,
      hour: currentTime.getHours(),
    }

    getCachedProjection(selectedZone.unit, ctx, currentStation)
      .then((result) => {
        if (cancelled) return
        if (result === null) {
          setProjection({ status: 'none' })
        } else {
          setProjection({ status: 'result', data: result })
        }
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[ZonePopup] projection failed:', e)
        setProjection({ status: 'error' })
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedZone?.unit.id, currentTimeBucket])

  if (!selectedZone) return null

  const { unit, result } = selectedZone
  const tier = result.tier
  const isLowTier = tier === 'driveby'
  const factorsToShow = isLowTier ? result.missingFactors : result.firedFactors
  const sectionHeading = isLowTier
    ? "Why it's not better right now:"
    : `Why it's ${tier} right now:`

  const onTouchStart = (e: React.TouchEvent) => {
    dragStartRef.current = e.touches[0].clientY
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (dragStartRef.current == null) return
    const dy = e.touches[0].clientY - dragStartRef.current
    if (dy > 0) setDragY(dy)
  }
  const onTouchEnd = () => {
    if (dragY > DRAG_DISMISS_PX) {
      selectZone(null)
    }
    setDragY(0)
    dragStartRef.current = null
  }

  const onDirections = () => {
    const [lon, lat] = unit.centroid
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const onSaveWaypoint = () => {
    // TODO Step 14: persist waypoint via window.storage with captured context.
    console.info('TODO Step 14: save waypoint', unit.id)
  }

  return (
    <div
      role="presentation"
      // Backdrop. z-[1100] sits above Leaflet panes (≤ 1000) and the dev
      // overlays at z-[1000].
      className="fixed inset-0 z-[1100] bg-black/40"
      onClick={() => selectZone(null)}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // The card stops backdrop clicks from bubbling out and dismissing.
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        className="absolute inset-x-0 bottom-0 mx-auto w-full sm:max-w-md bg-slate-900 text-slate-100 rounded-t-2xl shadow-2xl overflow-hidden"
        style={{
          // Drag follows the finger; on release the snapback/dismiss is handled in onTouchEnd.
          transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          transition: dragY > 0 ? 'none' : 'transform 250ms ease-out',
        }}
      >
        {/* Drag handle hint */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1 w-10 rounded-full bg-slate-600" />
        </div>

        {/* Tier header */}
        <header
          className={`flex items-center justify-between px-4 py-3 text-white ${TIER_BG[tier]}`}
        >
          <h2 id={titleId} className="text-lg font-bold tracking-wider">
            {TIER_LABEL[tier]}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close"
            onClick={() => selectZone(null)}
            className="size-11 flex items-center justify-center rounded-full hover:bg-white/15 focus-visible:bg-white/15 focus-visible:outline-none"
          >
            <XIcon className="size-5" />
          </button>
        </header>

        {/* Score + habitat */}
        <section className="px-4 pt-4 pb-3">
          <div className="text-3xl font-semibold tracking-tight">
            Score: {result.score}/10
          </div>
          <div className="mt-1 text-sm text-slate-400">
            Plan to spend {result.timeInvestment}
          </div>
          <div className="mt-3 text-base text-slate-200">
            {HABITAT_LABEL[unit.habitatType]}
          </div>
        </section>

        {/* Why-this-score */}
        <section className="px-4 py-3 border-t border-slate-800">
          <div className="text-xs font-medium uppercase tracking-wider text-slate-400 mb-2">
            {sectionHeading}
          </div>
          {factorsToShow.length === 0 ? (
            <div className="text-sm text-slate-500 italic">
              No factors recorded.
            </div>
          ) : (
            <ul className="space-y-0.5 text-sm">
              {factorsToShow.map((f, i) => (
                <FactorLine key={`${f.category}-${i}`} factor={f} fired={!isLowTier} />
              ))}
            </ul>
          )}
        </section>

        {/* Forward projection */}
        <section className="px-4 py-3 border-t border-slate-800">
          <div className="text-xs font-medium uppercase tracking-wider text-slate-400 mb-1">
            Lights up
          </div>
          {projection.status === 'loading' && (
            <div className="text-sm text-slate-400 italic">
              Computing forward projection…
            </div>
          )}
          {projection.status === 'error' && (
            <div className="text-sm text-slate-500 italic">
              Forward projection unavailable
            </div>
          )}
          {projection.status === 'none' && (
            <div className="text-sm text-slate-500 italic">
              No improvement projected in the next 7 days
            </div>
          )}
          {projection.status === 'result' && (
            <div className="text-sm text-slate-200">
              {formatProjectionLine(projection.data)}
            </div>
          )}
        </section>

        {/* CTAs */}
        <div className="grid grid-cols-2 gap-3 px-4 py-4 pb-[max(env(safe-area-inset-bottom,0),1rem)] border-t border-slate-800">
          <Button
            type="button"
            size="lg"
            onClick={onSaveWaypoint}
            className={`${TIER_BG[tier]} text-white h-12 w-full text-sm font-semibold hover:opacity-90`}
          >
            Save Waypoint
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={onDirections}
            className="h-12 w-full text-sm font-semibold border-slate-600 bg-transparent text-slate-100 hover:bg-slate-800 hover:text-slate-100"
          >
            <Navigation className="size-4" />
            Directions
          </Button>
        </div>
      </div>
    </div>
  )
}

export default ZonePopup
