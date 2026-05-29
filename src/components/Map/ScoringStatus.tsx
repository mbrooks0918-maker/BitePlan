/**
 * "Scoring zones…" progress pill.
 *
 * Visible only during the cold-pass scoring (before any scoredUnits land in
 * the store). Without this, the page looks blank for ~45 s on first load
 * because the habitat index loads in ~400 ms (logged) but the full
 * derivation + scoring + clustering pass that produces visible heat zones
 * takes much longer.
 *
 * Auto-hides once results arrive. Repaints if the worker is busy on a later
 * recompute that came back empty (rare — typically only when bounds drift
 * over open water).
 */

import { AlertTriangle, Loader2 } from 'lucide-react'
import { useBitePlanStore } from '@/store/useBitePlanStore'

function ScoringStatus() {
  const inProgress = useBitePlanStore((s) => s.scoringInProgress)
  const haveResults = useBitePlanStore((s) => s.scoredUnits.length > 0)
  const stalled = useBitePlanStore((s) => s.scoringStalled)

  // Step 20 — watchdog tripped: the worker hasn't responded in 90s.
  // Show a tappable warning banner so the user knows to reload instead
  // of staring at a frozen "Scoring zones…" spinner.
  if (stalled) {
    return (
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[1100] bg-amber-900/90 hover:bg-amber-900 text-amber-100 px-4 py-2.5 rounded-2xl shadow-lg backdrop-blur-sm flex items-center gap-3"
      >
        <AlertTriangle className="size-5 shrink-0" />
        <div className="leading-tight text-left">
          <div className="text-sm font-semibold">Scoring stalled</div>
          <div className="text-xs text-amber-200/80">Tap to reload the page</div>
        </div>
      </button>
    )
  }

  // Only show while nothing has been scored yet AND the worker is busy.
  // Once results land we get out of the way; subsequent recomputes are fast.
  if (!inProgress || haveResults) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[1000] bg-slate-900/85 text-slate-100 px-4 py-2.5 rounded-2xl shadow-lg backdrop-blur-sm flex items-center gap-3 pointer-events-none"
    >
      <Loader2 className="size-5 animate-spin shrink-0" />
      <div className="leading-tight">
        <div className="text-sm font-semibold">Scoring zones…</div>
        <div className="text-xs text-slate-400">
          First load can take up to a minute
        </div>
      </div>
    </div>
  )
}

export default ScoringStatus
