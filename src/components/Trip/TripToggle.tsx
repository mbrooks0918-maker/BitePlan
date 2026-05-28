/**
 * Manual Trip Mode toggle (Step 12).
 *
 * Trip Mode auto-activates between May 30 and June 14, 2026 (the dates
 * around Matt's Perdido Key trip). Outside that window the button is OFF by
 * default; clicking flips between explicit-on and explicit-off, both of
 * which override the auto-window. The store persists this override to
 * localStorage so the choice survives a reload.
 */

import { Tent } from 'lucide-react'
import { isTripModeActive, useBitePlanStore } from '@/store/useBitePlanStore'

function TripToggle() {
  const override = useBitePlanStore((s) => s.tripModeOverride)
  const setOverride = useBitePlanStore((s) => s.setTripModeOverride)

  // Resolve the *effective* current state — auto if no override has been
  // set, otherwise the explicit value. Clicking flips this effective state.
  const active = isTripModeActive(override)

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => setOverride(!active)}
      title={
        override === null
          ? `Trip Mode (auto): ${active ? 'on' : 'off'}`
          : `Trip Mode (manual): ${active ? 'on' : 'off'}`
      }
      className={
        active
          ? 'inline-flex items-center gap-1.5 rounded-full bg-amber-600/90 hover:bg-amber-600 text-white px-3 py-1 text-xs font-semibold'
          : 'inline-flex items-center gap-1.5 rounded-full bg-slate-700/70 hover:bg-slate-700 text-slate-200 px-3 py-1 text-xs font-medium'
      }
    >
      <Tent className="size-3.5" />
      Trip Mode
    </button>
  )
}

export default TripToggle
