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

import { Loader2 } from 'lucide-react'
import { useBitePlanStore } from '@/store/useBitePlanStore'

function ScoringStatus() {
  const inProgress = useBitePlanStore((s) => s.scoringInProgress)
  const haveResults = useBitePlanStore((s) => s.scoredUnits.length > 0)

  // Only show while nothing has been scored yet AND the worker is busy.
  // Once results land we get out of the way; subsequent recomputes are fast.
  if (!inProgress || haveResults) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[1000] bg-slate-900/80 text-slate-100 text-sm px-4 py-2 rounded-full shadow-lg backdrop-blur-sm flex items-center gap-2 pointer-events-none"
    >
      <Loader2 className="size-4 animate-spin" />
      <span>Scoring zones…</span>
    </div>
  )
}

export default ScoringStatus
