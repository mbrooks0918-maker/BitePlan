/**
 * SpeciesFilter (Step 16) — segmented chips at the Half snap.
 *
 * Bound to the existing `species` state. Changing it triggers a recompute
 * via `setSpecies` + the standard moveend / setCurrentTime debouncing in
 * the store. The scoring engine consumes `ctx.species` and switches into
 * the species-differentiated tide matrix from the Step 13.5 audit memo.
 */
import { Fish } from 'lucide-react'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { Species } from '@/types'

type Option = { value: Species; label: string }
const OPTIONS: Option[] = [
  { value: 'all', label: 'All' },
  { value: 'redfish', label: 'Redfish' },
  { value: 'trout', label: 'Trout' },
  { value: 'flounder', label: 'Flounder' },
]

function SpeciesFilter() {
  const value = useBitePlanStore((s) => s.species)
  const setSpecies = useBitePlanStore((s) => s.setSpecies)
  const recompute = useBitePlanStore((s) => s.recomputeScoredUnits)

  return (
    <section aria-label="Species filter" className="mt-3">
      <div className="text-xs uppercase tracking-wider text-slate-400 mb-1.5 px-1 flex items-center gap-1.5">
        <Fish className="size-3.5" /> Species
      </div>
      <div role="radiogroup" className="flex gap-1.5 flex-wrap">
        {OPTIONS.map((opt) => {
          const selected = value === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                // setSpecies itself just sets the state; we follow up with
                // a recompute so the dots redraw against the audit's
                // species-differentiated rules.
                setSpecies(opt.value)
                recompute()
              }}
              className={
                'min-h-[40px] rounded-full px-3 text-xs font-medium transition-colors ' +
                (selected
                  ? 'bg-slate-100 text-slate-900'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700')
              }
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}

export default SpeciesFilter
