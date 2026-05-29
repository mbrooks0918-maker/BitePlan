/**
 * Step 14 — saved-waypoint popup.
 *
 * Mirrors ZonePopup's slide-up dialog shape but renders the SAVED snapshot
 * instead of a live score. Intentionally simpler:
 *
 *   - Header: the user's label + "Saved Waypoint" subheader
 *   - Body: when saved, conditions (tier / score / tide state), habitat,
 *           depth at MLLW (or "unknown" if out of coverage), species
 *           filter at save time, and the convergence tags that fired
 *   - Actions: Directions (Google Maps deep link) + Delete with two-tap
 *     confirmation (first tap turns the button red and changes copy;
 *     second tap actually deletes)
 *
 * Saved waypoints are NEVER re-scored here — a future step can layer
 * "compare to live" on top. The promise to the user is "remember what was
 * true at the moment of saving"; live conditions belong to a different
 * surface.
 */
import { useEffect, useRef, useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import { Bookmark, Navigation, Trash2, X as XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { Tier } from '@/types'

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

const HABITAT_LABEL = {
  seagrass: 'Seagrass edge',
  oyster: 'Oyster bed',
  wetland: 'Marsh edge',
} as const

const TIDE_LABEL = {
  rising: 'Rising tide',
  falling: 'Falling tide',
  slack: 'Slack tide',
} as const

function SavedWaypointPopup() {
  const selectedId = useBitePlanStore((s) => s.selectedWaypointId)
  const waypoints = useBitePlanStore((s) => s.waypoints)
  const selectWaypoint = useBitePlanStore((s) => s.selectWaypoint)
  const deleteWaypoint = useBitePlanStore((s) => s.deleteWaypoint)

  const wp = selectedId ? waypoints.find((w) => w.id === selectedId) ?? null : null

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (wp) closeButtonRef.current?.focus()
    // Reset the delete-confirm state whenever the popup re-targets a
    // different waypoint.
    setConfirmingDelete(false)
  }, [wp?.id])

  // Esc closes (mirrors ZonePopup behaviour).
  useEffect(() => {
    if (!wp) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        selectWaypoint(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wp, selectWaypoint])

  if (!wp) return null

  const onDirections = () => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${wp.lat},${wp.lon}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const onDeleteFirstTap = () => {
    setConfirmingDelete(true)
    // Auto-revert the confirmation after a few seconds so a wandering tap
    // doesn't leave the button armed indefinitely.
    window.setTimeout(() => setConfirmingDelete(false), 4000)
  }
  const onDeleteConfirm = () => {
    deleteWaypoint(wp.id)
    selectWaypoint(null)
  }

  const savedAgo = formatDistanceToNow(new Date(wp.createdAt), { addSuffix: true })
  const savedAt = format(new Date(wp.createdAt), "MMM d, yyyy 'at' h:mm a")
  const scoredAtSameDay =
    new Date(wp.scoredAt).toDateString() === new Date(wp.createdAt).toDateString()
  const scoredAt = scoredAtSameDay
    ? format(new Date(wp.scoredAt), 'h:mm a')
    : format(new Date(wp.scoredAt), "MMM d 'at' h:mm a")

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[1100] bg-black/40"
      onClick={() => selectWaypoint(null)}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-x-0 bottom-0 mx-auto w-full sm:max-w-md bg-slate-900 text-slate-100 rounded-t-2xl shadow-2xl overflow-hidden"
      >
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1 w-10 rounded-full bg-slate-600" />
        </div>

        {/* Header: tier-colored bar (matches ZonePopup) with the user's
            label and a "Saved Waypoint" sub-tag. */}
        <header className={`flex items-center justify-between px-4 py-3 text-white ${TIER_BG[wp.tier]}`}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider opacity-90">
              <Bookmark className="size-3.5" />
              Saved Waypoint
            </div>
            <h2 className="text-lg font-semibold tracking-tight truncate" title={wp.label}>
              {wp.label}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close"
            onClick={() => selectWaypoint(null)}
            className="size-11 flex items-center justify-center rounded-full hover:bg-white/15 focus-visible:bg-white/15 focus-visible:outline-none shrink-0"
          >
            <XIcon className="size-5" />
          </button>
        </header>

        {/* When + tier-score summary */}
        <section className="px-4 pt-4 pb-3">
          <div className="text-sm text-slate-300">
            Saved {savedAgo}
            <span className="text-slate-400"> · {savedAt}</span>
          </div>
          <div className="mt-2 text-base text-slate-200">
            Was <span className="font-semibold tracking-wider">{TIER_LABEL[wp.tier]}</span>{' '}
            at score {wp.score.toFixed(1)}/10
          </div>
          <div className="text-sm text-slate-400 mt-0.5">
            {TIDE_LABEL[wp.tideState]} · scored {scoredAt}
          </div>
        </section>

        {/* Habitat + depth + species */}
        <section className="px-4 py-3 border-t border-slate-800 text-sm space-y-1.5">
          <div className="text-slate-200">
            {HABITAT_LABEL[wp.habitatType]}
          </div>
          <div className="text-slate-400">
            Depth at MLLW:{' '}
            {wp.depthMLLWFt == null
              ? 'unknown'
              : wp.depthMLLWFt < 0
                ? `${Math.abs(wp.depthMLLWFt).toFixed(1)} ft above MLLW`
                : `${wp.depthMLLWFt.toFixed(1)} ft`}
          </div>
          {wp.species !== 'all' && (
            <div className="text-slate-400">
              Species filter at save:{' '}
              <span className="text-slate-200 capitalize">{wp.species}</span>
            </div>
          )}
        </section>

        {/* Convergence tags at save time — the "why I saved this" recall */}
        {wp.convergenceTags.length > 0 && (
          <section className="px-4 py-3 border-t border-slate-800">
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-1.5">
              Structural features at save
            </div>
            <ul className="space-y-0.5 text-sm text-slate-200">
              {wp.convergenceTags.map((t, i) => (
                <li key={`${t.subtype}-${i}`}>{t.description}</li>
              ))}
            </ul>
          </section>
        )}

        {/* CTAs: Delete (two-tap confirm) + Directions */}
        <div className="grid grid-cols-2 gap-3 px-4 py-4 pb-[max(env(safe-area-inset-bottom,0),1rem)] border-t border-slate-800">
          {confirmingDelete ? (
            <Button
              type="button"
              size="lg"
              onClick={onDeleteConfirm}
              className="bg-red-600 hover:bg-red-500 text-white h-12 w-full text-sm font-semibold"
            >
              <Trash2 className="size-4" />
              Tap again to confirm
            </Button>
          ) : (
            <Button
              type="button"
              size="lg"
              variant="outline"
              onClick={onDeleteFirstTap}
              className="h-12 w-full text-sm font-semibold border-red-700/60 bg-transparent text-red-300 hover:bg-red-900/40 hover:text-red-200"
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          )}
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

export default SavedWaypointPopup
