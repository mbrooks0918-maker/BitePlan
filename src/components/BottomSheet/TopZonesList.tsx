/**
 * TopZonesList (Step 16 — Half snap section).
 *
 * Shows the top 5 fire / hot scored units in the current map view. Tap a
 * row → the map flies to that unit's centroid and the ZonePopup opens.
 *
 * Reads from `scoredUnits` and respects the bottom-sheet tier filter so
 * the list mirrors what the user has chosen to see on the map.
 */
import { Flame, ArrowUpRight } from 'lucide-react'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { Tier } from '@/types'

const TIER_BG: Record<Tier, string> = {
  fire: 'bg-red-600',
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

const MAX_ROWS = 5

function TopZonesList() {
  const scoredUnits = useBitePlanStore((s) => s.scoredUnits)
  const tierFilter = useBitePlanStore((s) => s.tierFilter)
  const flyToScoredUnit = useBitePlanStore((s) => s.flyToScoredUnit)

  // Build the "top 5" list: filter by user's tier choice, then sort by
  // score desc, then take MAX_ROWS. Cheap — scoredUnits is already capped
  // at 2000 by the worker.
  const filtered = scoredUnits.filter((e) => {
    if (tierFilter === 'all') return true
    if (tierFilter === 'fire+') return e.result.tier === 'fire'
    return e.result.tier === 'fire' || e.result.tier === 'hot'
  })
  const top = [...filtered]
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, MAX_ROWS)

  return (
    <section aria-label="Top scored zones in view" className="mt-2">
      <div className="flex items-center justify-between mb-1.5 px-1">
        <h3 className="text-xs uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <Flame className="size-3.5" /> Top in view
        </h3>
        <span className="text-[10px] text-slate-400">{top.length} of {filtered.length}</span>
      </div>
      {top.length === 0 ? (
        <div className="text-xs text-slate-400 italic px-1 py-2">
          No qualifying zones in current view. Pan or change filters.
        </div>
      ) : (
        <ul className="divide-y divide-slate-800 rounded-md overflow-hidden border border-slate-800">
          {top.map((e, i) => (
            <li key={`${e.unit.id}-${i}`}>
              <button
                type="button"
                onClick={() => flyToScoredUnit(e)}
                className="w-full flex items-center gap-2 px-2 py-2 text-left hover:bg-slate-800/60 active:bg-slate-800 transition-colors min-h-[52px]"
              >
                <span
                  aria-hidden
                  className={
                    'size-7 rounded-md flex items-center justify-center text-[10px] font-bold ' +
                    TIER_BG[e.result.tier] +
                    (e.result.tier === 'driveby' ? ' text-slate-900' : ' text-white')
                  }
                >
                  {e.result.score.toFixed(1)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-100 truncate">
                    {HABITAT_LABEL[e.unit.habitatType]} ·{' '}
                    <span className="text-slate-300">{TIER_LABEL[e.result.tier]}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate tabular-nums">
                    {e.unit.centroid[1].toFixed(4)}, {e.unit.centroid[0].toFixed(4)}
                  </div>
                </div>
                <ArrowUpRight className="size-4 text-slate-400 shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default TopZonesList
