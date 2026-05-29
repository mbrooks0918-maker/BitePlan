/**
 * Saved Waypoints list (Step 15).
 *
 * Companion to the map-pin view: a scrollable, sortable list of every
 * saved waypoint. Tap a row → map flies to that pin + opens its popup.
 * Two-tap inline delete on each row mirrors the SavedWaypointPopup
 * pattern so muscle-memory is consistent.
 *
 * TEMPORARY placement — moves into BottomSheet Full snap-point in Step 16.
 *
 * Floats above the time strip in the bottom-right corner with internal
 * scroll. Collapsed-by-default so it doesn't crowd the map view until the
 * user opens it. Once it lives inside the bottom sheet, the collapse
 * behaviour becomes the sheet's peek/half/full snap.
 */
import { useEffect, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Bookmark, ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { Tier, Waypoint } from '@/types'

// Left-edge accent bar per saved tier. Matches the bookmark marker stroke
// + the SaveToast accent so the eye can carry "this is a hot one" across
// the toast → pin → list surfaces.
const TIER_BAR: Record<Tier, string> = {
  fire: 'bg-red-500',
  hot: 'bg-orange-500',
  driveby: 'bg-yellow-500',
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

function Row({
  wp,
  onSelect,
  onDeleteConfirmed,
}: {
  wp: Waypoint
  onSelect: (id: string) => void
  onDeleteConfirmed: (id: string) => void
}) {
  const [armingDelete, setArmingDelete] = useState(false)
  // Auto-disarm the delete confirmation after 2s so a wandering tap can't
  // leave the icon armed indefinitely.
  useEffect(() => {
    if (!armingDelete) return
    const t = window.setTimeout(() => setArmingDelete(false), 2000)
    return () => window.clearTimeout(t)
  }, [armingDelete])

  const onRowClick = () => {
    // If the delete is armed, a row tap should disarm it (not fly-to).
    if (armingDelete) {
      setArmingDelete(false)
      return
    }
    onSelect(wp.id)
  }
  const onDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (armingDelete) {
      onDeleteConfirmed(wp.id)
    } else {
      setArmingDelete(true)
    }
  }

  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onRowClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onRowClick()
        }
      }}
      className="flex items-stretch min-h-[64px] cursor-pointer transition-colors hover:bg-slate-800/50 active:bg-slate-800 group"
    >
      {/* Tier accent bar. 4px wide, stretches the full row height. */}
      <div aria-hidden className={`w-1 shrink-0 ${TIER_BAR[wp.tier]}`} />
      <div className="flex-1 min-w-0 py-2 pl-3 pr-2">
        <div className="text-sm font-semibold text-slate-100 truncate" title={wp.label}>
          {wp.label}
        </div>
        <div className="text-xs text-slate-400 mt-0.5 truncate">
          {HABITAT_LABEL[wp.habitatType]} · saved {formatDistanceToNow(wp.createdAt, { addSuffix: true })}
        </div>
        <div className="text-xs text-slate-500 mt-0.5 truncate">
          {wp.score.toFixed(1)}/10 · {TIDE_LABEL[wp.tideState]}
        </div>
      </div>
      <button
        type="button"
        onClick={onDeleteClick}
        aria-label={armingDelete ? 'Tap again to confirm delete' : 'Delete waypoint'}
        title={armingDelete ? 'Tap again to confirm' : 'Delete'}
        className={
          'shrink-0 w-12 flex items-center justify-center transition-colors ' +
          (armingDelete
            ? 'bg-red-900/40 text-red-300 hover:bg-red-900/60'
            : 'text-slate-500 hover:text-red-400 hover:bg-slate-800')
        }
      >
        <span className="relative flex items-center justify-center">
          <Trash2 className="size-4" />
          {armingDelete && (
            <span className="absolute -top-2 -right-2 text-[10px] font-bold text-red-300">
              ?
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

function WaypointsList() {
  const waypoints = useBitePlanStore((s) => s.waypoints)
  const deleteWaypoint = useBitePlanStore((s) => s.deleteWaypoint)
  const flyToWaypoint = useBitePlanStore((s) => s.flyToWaypoint)

  const [expanded, setExpanded] = useState(false)
  const listRef = useRef<HTMLUListElement | null>(null)

  // Most-recent first per the spec; the store stores ascending so we sort
  // a fresh copy here (cheap — typically dozens of waypoints).
  const sorted = [...waypoints].sort((a, b) => b.createdAt - a.createdAt)
  const count = sorted.length

  return (
    <div
      // bottom-32 clears the time strip (TimeSlider / DayPickerStrip /
      // TripStrip all sit in the bottom ~120 px). Width capped so the list
      // can't dominate small screens.
      className="fixed bottom-32 right-4 z-[1050] w-[min(92vw,20rem)] pointer-events-auto"
    >
      <div className="bg-slate-900/95 text-slate-100 rounded-lg shadow-2xl border border-slate-700/60 backdrop-blur-sm overflow-hidden">
        {/* Header — always visible; doubles as the expand/collapse toggle. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="saved-waypoints-list"
          className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Bookmark className="size-4 text-slate-300" />
            <span className="text-sm font-medium">Saved Waypoints</span>
            <span className="text-xs text-slate-400">({count})</span>
          </div>
          {expanded ? (
            <ChevronDown className="size-4 text-slate-400" />
          ) : (
            <ChevronUp className="size-4 text-slate-400" />
          )}
        </button>

        {expanded && (
          <div
            // Cap the panel to 60vh so it never overlaps the entire map,
            // and let the inner list scroll within.
            className="border-t border-slate-700/60"
            style={{ maxHeight: '60vh' }}
          >
            {count === 0 ? (
              <div className="flex flex-col items-center justify-center text-center px-6 py-10">
                <Bookmark className="size-7 text-slate-600 mb-3" />
                <p className="text-sm text-slate-300 leading-snug">
                  No saved waypoints yet.
                </p>
                <p className="text-xs text-slate-500 mt-1 leading-snug">
                  Tap any zone, then ‘Save Waypoint’ to bookmark a spot.
                </p>
              </div>
            ) : (
              <ul
                id="saved-waypoints-list"
                ref={listRef}
                className="overflow-y-auto divide-y divide-slate-700/60"
                style={{ maxHeight: 'calc(60vh - 0px)' }}
              >
                {sorted.map((wp) => (
                  <Row
                    key={wp.id}
                    wp={wp}
                    onSelect={flyToWaypoint}
                    onDeleteConfirmed={deleteWaypoint}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default WaypointsList
