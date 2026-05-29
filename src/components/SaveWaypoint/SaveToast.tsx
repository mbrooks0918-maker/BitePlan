/**
 * Step 14 — Save Waypoint toast.
 *
 * Floats at the bottom-centre of the screen above the time strip (Steps 10
 * / 11 / 12) and below any modal layer. Phases:
 *
 *   1. 'toast'   (default after a save fires)
 *      - shows "Saved as '{label}' — tap to rename"
 *      - 4.5s auto-dismiss timer
 *      - tier-color accent on the left border so the user instantly knows
 *        what they saved (fire vs hot vs driveby)
 *      - tap anywhere on the toast → phase becomes 'rename'
 *   2. 'rename'  (tap-target hit before auto-dismiss)
 *      - inline input pre-filled + fully selected
 *      - Enter / checkmark submits via store.renameWaypoint
 *      - Escape / X button cancels (label stays the default — does NOT
 *        delete the waypoint)
 *      - the auto-dismiss timer is suspended in this phase (don't yank
 *        the rename UI out from under a user mid-edit per the spec)
 *
 * Both phases close by clearing `pendingRenameWaypointId` on the store.
 * The store stays as the source of truth — this component just reacts.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { Tier } from '@/types'

const AUTO_DISMISS_MS = 4500

// Border accent per tier — matches the popup header colors in ZonePopup so
// the eye carries the association from popup → toast → pin.
const TIER_ACCENT: Record<Tier, string> = {
  fire: 'border-l-red-500',
  hot: 'border-l-orange-500',
  driveby: 'border-l-yellow-500',
}

type Phase = 'hidden' | 'toast' | 'rename'

function SaveToast() {
  const pendingId = useBitePlanStore((s) => s.pendingRenameWaypointId)
  const waypoints = useBitePlanStore((s) => s.waypoints)
  const renameWaypoint = useBitePlanStore((s) => s.renameWaypoint)
  const clearPendingRename = useBitePlanStore((s) => s.clearPendingRename)

  const pending = pendingId ? waypoints.find((w) => w.id === pendingId) ?? null : null
  const [phase, setPhase] = useState<Phase>('hidden')
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const timerRef = useRef<number | null>(null)

  // When a new pending id appears, open the toast phase and start the
  // dismissal timer. When pending clears (delete, or we cleared it), hide.
  useEffect(() => {
    if (pendingId) {
      setPhase('toast')
    } else {
      setPhase('hidden')
    }
  }, [pendingId])

  // Manage the auto-dismiss timer. Cleared on phase change so 'rename'
  // suspends dismissal until the user explicitly accepts or cancels.
  useEffect(() => {
    if (phase !== 'toast') {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }
    timerRef.current = window.setTimeout(() => {
      clearPendingRename()
    }, AUTO_DISMISS_MS)
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [phase, clearPendingRename])

  // When the rename phase opens, seed the draft from the current label and
  // select the input on focus.
  useEffect(() => {
    if (phase !== 'rename' || !pending) return
    setDraft(pending.label)
    // The next tick is enough for React to mount the input.
    const t = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [phase, pending])

  // Escape key cancels rename without changing the label.
  useEffect(() => {
    if (phase !== 'rename') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        clearPendingRename()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, clearPendingRename])

  // Tap-outside cancels rename (does NOT delete). Excludes taps on the
  // input row itself.
  useEffect(() => {
    if (phase !== 'rename') return
    const onClick = (e: MouseEvent) => {
      const container = document.getElementById('save-waypoint-rename-row')
      if (container && container.contains(e.target as Node)) return
      clearPendingRename()
    }
    // Defer so the tap that opened the rename phase doesn't immediately
    // close it.
    const id = window.setTimeout(() => {
      window.addEventListener('click', onClick)
    }, 0)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('click', onClick)
    }
  }, [phase, clearPendingRename])

  if (phase === 'hidden' || !pending) return null

  const accent = TIER_ACCENT[pending.tier]

  const submit = () => {
    const trimmed = draft.trim()
    // Empty label is rejected — keep the existing label and just close.
    if (trimmed.length > 0 && trimmed !== pending.label) {
      renameWaypoint(pending.id, trimmed)
    }
    clearPendingRename()
  }

  // The wrapper centres the card and sits above the time strip
  // (TimeSlider / DayPickerStrip / TripStrip all live around bottom-0
  // through ~120 px). bottom-32 ≈ 128 px clears them comfortably.
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 bottom-32 z-[1200] w-[min(92vw,28rem)] pointer-events-none"
    >
      {phase === 'toast' ? (
        <button
          type="button"
          onClick={() => setPhase('rename')}
          className={
            'pointer-events-auto w-full text-left bg-slate-900/95 text-slate-100 ' +
            'rounded-lg shadow-2xl backdrop-blur-sm border-l-4 ' +
            'px-4 py-3 transition-all duration-200 hover:bg-slate-800/95 ' +
            accent
          }
        >
          <div className="text-sm">
            Saved as <span className="font-semibold">‘{pending.label}’</span>
          </div>
          <div className="text-xs text-slate-400 mt-0.5">Tap to rename</div>
        </button>
      ) : (
        <div
          id="save-waypoint-rename-row"
          className={
            'pointer-events-auto bg-slate-900/95 text-slate-100 rounded-lg shadow-2xl ' +
            'backdrop-blur-sm border-l-4 px-3 py-3 flex items-center gap-2 ' +
            accent
          }
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            className="flex-1 min-w-0 bg-slate-800 rounded px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
            aria-label="Rename waypoint"
          />
          <button
            type="button"
            onClick={() => clearPendingRename()}
            aria-label="Cancel rename"
            className="size-11 flex items-center justify-center rounded hover:bg-slate-800/70 focus-visible:bg-slate-800/70 focus-visible:outline-none"
          >
            <X className="size-4" />
          </button>
          <button
            type="button"
            onClick={submit}
            aria-label="Save new name"
            className="size-11 flex items-center justify-center rounded bg-emerald-600 hover:bg-emerald-500 text-white focus-visible:outline-none"
          >
            <Check className="size-4" />
          </button>
        </div>
      )}
    </div>
  )
}

export default SaveToast
