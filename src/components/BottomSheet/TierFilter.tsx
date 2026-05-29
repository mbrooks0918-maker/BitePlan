/**
 * TierFilter (Step 16) — segmented chips at the Half snap.
 *
 * Hides scored units below the chosen threshold. Drives both the
 * TopZonesList rendering AND the map's ScoredZones layer (which reads
 * `tierFilter` from the store).
 */
import { Flame } from 'lucide-react'
import { useBitePlanStore, type TierFilter as TierFilterValue } from '@/store/useBitePlanStore'

type Option = {
  value: TierFilterValue
  label: string
  icon?: string
}
const OPTIONS: Option[] = [
  { value: 'all', label: 'All' },
  { value: 'fire+', label: 'Fire+', icon: '🔥' },
  { value: 'hot+', label: 'Hot+', icon: '🟠' },
]

function TierFilter() {
  const value = useBitePlanStore((s) => s.tierFilter)
  const set = useBitePlanStore((s) => s.setTierFilter)

  return (
    <section aria-label="Tier filter" className="mt-3">
      <div className="text-xs uppercase tracking-wider text-slate-400 mb-1.5 px-1 flex items-center gap-1.5">
        <Flame className="size-3.5" /> Tier
      </div>
      <div role="radiogroup" className="flex gap-1.5">
        {OPTIONS.map((opt) => {
          const selected = value === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => set(opt.value)}
              className={
                'flex-1 min-h-[40px] rounded-full px-3 text-xs font-medium transition-colors ' +
                (selected
                  ? 'bg-slate-100 text-slate-900'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700')
              }
            >
              {opt.icon ? <span className="mr-1" aria-hidden>{opt.icon}</span> : null}
              {opt.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}

export default TierFilter
