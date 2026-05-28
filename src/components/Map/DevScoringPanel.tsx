/**
 * TEMPORARY dev-only panel showing scoring engine output.
 *
 * Floats in the bottom-right corner of the map so we can verify the engine
 * works without the heat-zone visual layer (that lands in Step 7). This panel
 * will be removed once the rendered zones make this readout redundant.
 */

import { Card } from '@/components/ui/card'
import { useBitePlanStore } from '@/store/useBitePlanStore'

const TIER_COLOR = {
  fire: 'text-red-400',
  hot: 'text-orange-400',
  driveby: 'text-yellow-400',
} as const

function DevScoringPanel() {
  const scoredUnits = useBitePlanStore((s) => s.scoredUnits)
  const scoringInProgress = useBitePlanStore((s) => s.scoringInProgress)
  const lastScoringMs = useBitePlanStore((s) => s.lastScoringMs)

  const counts = {
    fire: scoredUnits.filter((e) => e.result.tier === 'fire').length,
    hot: scoredUnits.filter((e) => e.result.tier === 'hot').length,
    driveby: scoredUnits.filter((e) => e.result.tier === 'driveby').length,
  }
  const top = scoredUnits[0]

  return (
    <Card
      size="sm"
      className="fixed bottom-4 right-4 z-[1000] w-72 px-3 py-3 gap-2 text-xs"
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Scoring (dev)
        </div>
        <div className="text-[10px] text-muted-foreground">
          {scoringInProgress ? 'scoring…' : `${lastScoringMs.toFixed(0)} ms`}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className={`text-base font-semibold ${TIER_COLOR.fire}`}>{counts.fire}</div>
          <div className="text-[10px] text-muted-foreground">fire</div>
        </div>
        <div>
          <div className={`text-base font-semibold ${TIER_COLOR.hot}`}>{counts.hot}</div>
          <div className="text-[10px] text-muted-foreground">hot</div>
        </div>
        <div>
          <div className={`text-base font-semibold ${TIER_COLOR.driveby}`}>
            {counts.driveby}
          </div>
          <div className="text-[10px] text-muted-foreground">drive-by</div>
        </div>
      </div>

      <div className="text-[10px] text-muted-foreground">
        {scoredUnits.length} units scored in view
      </div>

      {top ? (
        <div className="border-t border-foreground/10 pt-2 space-y-1">
          <div className="flex items-baseline justify-between">
            <span className="capitalize text-foreground">{top.unit.habitatType}</span>
            <span className={`font-semibold ${TIER_COLOR[top.result.tier]}`}>
              {top.result.score.toFixed(1)}/10 · {top.result.tier}
            </span>
          </div>
          <ul className="space-y-0.5 text-foreground/80">
            {top.result.firedFactors.slice(0, 3).map((f, i) => (
              <li key={i} className="flex gap-1">
                <span className="text-emerald-400">+{f.delta}</span>
                <span className="truncate">{f.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="border-t border-foreground/10 pt-2 text-muted-foreground">
          No units in view yet
        </div>
      )}
    </Card>
  )
}

export default DevScoringPanel
