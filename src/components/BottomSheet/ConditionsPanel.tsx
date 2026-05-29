/**
 * ConditionsPanel (Step 16 — Peek strip).
 *
 * Always-visible compact row at the very top of the bottom sheet. Three
 * slots, single row:
 *
 *   1. Tide state pill: "FALLING → 2:14 to LOW" (stationName below)
 *   2. Conditions score: a 1-10 chip color-coded by the top in-view unit's
 *      tier. Pulled from the live `scoredUnits` array so it reflects the
 *      current pan + time + filter state.
 *   3. Time indicator: a thin horizontal bar showing where in the 24h cycle
 *      `currentTime` sits. Decorative — the slider controls live in Half.
 *
 * Reads directly from the store (no props) so it can re-render
 * independently when only one of its sub-pieces changes.
 */
import { format, parseISO } from 'date-fns'
import { getCurrentTideState, type TideState } from '@/lib/tides'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { Tier } from '@/types'

const TIDE_PILL_BG: Record<TideState, string> = {
  rising: 'bg-teal-700',
  falling: 'bg-amber-700',
  slack: 'bg-slate-700',
}
const NEUTRAL_BG = 'bg-slate-700'
const TIER_CHIP: Record<Tier, string> = {
  fire: 'bg-red-600 text-white',
  hot: 'bg-orange-500 text-white',
  driveby: 'bg-yellow-500 text-slate-900',
}

function ConditionsPanel() {
  const station = useBitePlanStore((s) => s.currentStation)
  const predictions = useBitePlanStore((s) => s.tidePredictions)
  const tideLoading = useBitePlanStore((s) => s.tideLoading)
  const currentTime = useBitePlanStore((s) => s.currentTime)
  const scoredUnits = useBitePlanStore((s) => s.scoredUnits)

  // ----- tide pill ------------------------------------------------------
  let tideBg = NEUTRAL_BG
  let tideText: React.ReactNode
  if (tideLoading) {
    tideText = 'Loading tide…'
  } else if (predictions.length === 0) {
    tideText = 'Tide unavailable'
  } else {
    const { state, nextEvent } = getCurrentTideState(predictions, currentTime)
    tideBg = TIDE_PILL_BG[state]
    if (!nextEvent) {
      tideText = `${state.toUpperCase()} · END OF DAY`
    } else {
      const eventDate = parseISO(nextEvent.t)
      const sameDay =
        eventDate.getFullYear() === currentTime.getFullYear() &&
        eventDate.getMonth() === currentTime.getMonth() &&
        eventDate.getDate() === currentTime.getDate()
      const fmt = sameDay
        ? format(eventDate, 'h:mm a')
        : format(eventDate, 'EEE h:mm a')
      const dir = nextEvent.type === 'H' ? 'HIGH' : 'LOW'
      tideText = (
        <>
          {state.toUpperCase()} <span aria-hidden>→</span> {fmt} {dir}
        </>
      )
    }
  }

  // ----- conditions score ----------------------------------------------
  // Top in-view unit's tier — the most relevant "what's the best spot in
  // the current view right now" reading. Rounds to integer 1-10 with the
  // same convention the day-conditions handler uses.
  let scoreText = '—'
  let scoreClass = 'bg-slate-700 text-slate-300'
  if (scoredUnits.length > 0) {
    let top = scoredUnits[0]
    for (const e of scoredUnits) {
      if (e.result.score > top.result.score) top = e
    }
    const rounded = Math.max(1, Math.min(10, Math.round(top.result.score)))
    scoreText = String(rounded)
    scoreClass = TIER_CHIP[top.result.tier]
  }

  // ----- time-of-day indicator ------------------------------------------
  // Percentage of the day elapsed (0–100). The thin bar gives at-a-glance
  // "where are we now" relative to the 24h cycle.
  const minutesOfDay = currentTime.getHours() * 60 + currentTime.getMinutes()
  const dayPct = (minutesOfDay / (24 * 60)) * 100
  const timeLabel = format(currentTime, 'h:mm a')

  return (
    <section
      aria-label="Current conditions"
      className="flex items-center gap-3 px-1 py-2"
    >
      {/* Tide pill */}
      <div
        className={`flex-1 min-w-0 ${tideBg} text-white rounded-full px-3 py-1.5 text-xs font-medium shadow-sm`}
      >
        <div className="truncate">{tideText}</div>
        <div className="text-[10px] text-white/70 truncate">{station.name}</div>
      </div>

      {/* Conditions score chip */}
      <div
        className={`shrink-0 ${scoreClass} rounded-md px-2.5 py-1.5 text-center font-semibold leading-tight`}
        title="Best unit score in current view"
      >
        <div className="text-base tabular-nums">{scoreText}</div>
        <div className="text-[9px] opacity-80 uppercase tracking-wider">/10</div>
      </div>

      {/* 24h indicator */}
      <div className="shrink-0 w-24" aria-label={`Current time ${timeLabel}`}>
        <div className="text-[10px] text-slate-400 mb-1 text-right tabular-nums">{timeLabel}</div>
        <div className="relative h-1 bg-slate-700 rounded-full overflow-hidden">
          <div
            aria-hidden
            className="absolute top-0 bottom-0 w-0.5 bg-emerald-400"
            style={{ left: `${dayPct}%` }}
          />
        </div>
      </div>
    </section>
  )
}

export default ConditionsPanel
