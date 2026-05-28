/**
 * 7-day day picker (Step 11).
 *
 * Horizontal row of cards, one per day. Each card shows the day's
 * Conditions Score, fire-zone count, and best 3-hour window. Tapping a card
 * jumps the map to that day at the best window's start time, which triggers
 * the standard recompute path.
 *
 * Built generically so Step 12 (Trip Mode) can reuse the same card layout
 * with `dayCount=12` and a different start date — only the parent decides
 * which range to show.
 *
 * TEMPORARY placement: lives in the bottom strip alongside the slider until
 * Step 16's bottom sheet absorbs both.
 */

import { useEffect, useMemo } from 'react'
import { format, parseISO, startOfDay } from 'date-fns'
import { Flame, Loader2 } from 'lucide-react'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { DayCondition } from '@/types'

const TIER_TEXT = {
  fire: 'text-red-400',
  hot: 'text-orange-400',
  driveby: 'text-yellow-400',
} as const

function tierFor(score: number): 'fire' | 'hot' | 'driveby' {
  if (score >= 8) return 'fire'
  if (score >= 5) return 'hot'
  return 'driveby'
}

function formatWindow(startMs: number): string {
  // 3-hour window, e.g. "6–9 AM" / "12–3 PM". Compact so the card stays small.
  const start = new Date(startMs)
  const end = new Date(startMs + 3 * 60 * 60 * 1000)
  const sH = start.getHours()
  const eH = end.getHours() === 0 ? 24 : end.getHours()
  const period = (h: number) => (h === 0 || h === 24 ? 'AM' : h < 12 ? 'AM' : 'PM')
  const display = (h: number) => {
    if (h === 0 || h === 24) return '12'
    if (h > 12) return String(h - 12)
    return String(h)
  }
  const sPeriod = period(sH)
  const ePeriod = period(eH === 24 ? 24 : eH)
  return sPeriod === ePeriod
    ? `${display(sH)}–${display(eH)} ${ePeriod}`
    : `${display(sH)}${sPeriod} – ${display(eH)}${ePeriod}`
}

function DayCard({
  cond,
  isToday,
  isSelected,
  onSelect,
}: {
  cond: DayCondition
  isToday: boolean
  isSelected: boolean
  onSelect: () => void
}) {
  const date = parseISO(cond.date)
  const tier = tierFor(cond.bestWindowScore)
  return (
    <button
      type="button"
      onClick={onSelect}
      // shrink-0 keeps the card width fixed inside the scroll container.
      className={
        'shrink-0 w-24 min-h-[88px] rounded-xl px-2 py-2 flex flex-col items-center justify-between snap-start text-center transition-colors ' +
        (isSelected
          ? 'bg-slate-700 ring-2 ring-teal-400'
          : 'bg-slate-800/80 hover:bg-slate-700/80')
      }
    >
      <div className="leading-tight">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">
          {isToday ? 'Today' : format(date, 'EEE')}
        </div>
        <div className="text-[10px] text-slate-400">{format(date, 'MMM d')}</div>
      </div>
      <div className={`text-2xl font-bold tabular-nums ${TIER_TEXT[tier]}`}>
        {cond.conditionsScore}
      </div>
      <div className="flex items-center gap-1 text-[10px] text-slate-400">
        {cond.fireZoneCount > 0 && (
          <span className="flex items-center gap-0.5 text-red-400">
            <Flame className="size-3" />
            {cond.fireZoneCount}
          </span>
        )}
        <span className="truncate">{formatWindow(cond.bestWindowStartMs)}</span>
      </div>
    </button>
  )
}

type DayPickerProps = {
  /** Midnight of the first day to render. */
  startDate: Date
  /** Number of consecutive day cards to show. 7 in the generic picker, 12 in Trip Mode. */
  dayCount: number
}

function DayPicker({ startDate, dayCount }: DayPickerProps) {
  const dayConditions = useBitePlanStore((s) => s.dayConditions)
  const loading = useBitePlanStore((s) => s.dayConditionsLoading)
  const setCurrentTime = useBitePlanStore((s) => s.setCurrentTime)
  const currentTime = useBitePlanStore((s) => s.currentTime)
  const recomputeDayConditions = useBitePlanStore((s) => s.recomputeDayConditions)
  const bounds = useBitePlanStore((s) => s.bounds)
  const habitatIndexReady = useBitePlanStore((s) => s.habitatIndexReady)

  // Recompute when the visible bounds change or the range parameters shift
  // (e.g. user flipped Trip Mode and dayCount jumped from 7 to 12). The
  // store's signature dedup skips identical re-requests.
  const startKey = startDate.toDateString()
  useEffect(() => {
    if (!habitatIndexReady || !bounds) return
    void recomputeDayConditions(startDate, dayCount)
  }, [habitatIndexReady, bounds, recomputeDayConditions, startKey, dayCount, startDate])

  const today = useMemo(() => startOfDay(new Date()), [])
  const todayMs = today.getTime()
  const currentDayKey = format(currentTime, 'yyyy-MM-dd')

  return (
    <div className="relative">
      {loading && dayConditions.length === 0 ? (
        <div className="flex items-center gap-2 px-2 py-4 text-sm text-slate-400">
          <Loader2 className="size-4 animate-spin" />
          Computing day conditions…
        </div>
      ) : dayConditions.length === 0 ? (
        <div className="px-2 py-4 text-sm text-slate-500 italic">
          No conditions data yet.
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto snap-x snap-mandatory pb-1 -mx-1 px-1">
          {dayConditions.map((cond) => {
            const condDate = parseISO(cond.date)
            const isToday = condDate.getTime() === todayMs
            const isSelected = cond.date === currentDayKey
            return (
              <DayCard
                key={cond.date}
                cond={cond}
                isToday={isToday}
                isSelected={isSelected}
                onSelect={() => {
                  // Jump the map's time to the best window's start. The slider
                  // (when toggled back) will pick this up automatically.
                  setCurrentTime(new Date(cond.bestWindowStartMs))
                }}
              />
            )
          })}
        </div>
      )}
      {/* Hour-axis hints aren't useful here, but a tiny "tap to jump" hint
       *  helps first-time users. */}
      <div className="mt-1 text-[10px] text-slate-500 text-center">
        Tap a day to jump the map to its best window
      </div>
    </div>
  )
}

export default DayPicker
