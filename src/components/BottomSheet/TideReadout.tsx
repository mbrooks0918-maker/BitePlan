/**
 * TEMPORARY positioning: floats in the top-left of the map until Step 16,
 * when this component will live inside the proper bottom sheet's peek state.
 *
 * Shows the current tide state (RISING / FALLING / SLACK), when the next
 * hi/lo event hits, and the active nearest-station name.
 */

import { format, parseISO } from 'date-fns'
import type { ReactNode } from 'react'
import { getCurrentTideState, type TideState } from '@/lib/tides'
import { useBitePlanStore } from '@/store/useBitePlanStore'

// State → background utility. Slate is the neutral fallback for slack /
// loading / no-data; teal for rising, amber for falling.
const PILL_BG: Record<TideState, string> = {
  rising: 'bg-teal-900/70',
  falling: 'bg-amber-900/70',
  slack: 'bg-slate-700/70',
}
const NEUTRAL_BG = 'bg-slate-700/70'

function TideReadout() {
  const station = useBitePlanStore((s) => s.currentStation)
  const predictions = useBitePlanStore((s) => s.tidePredictions)
  const loading = useBitePlanStore((s) => s.tideLoading)
  const currentTime = useBitePlanStore((s) => s.currentTime)

  const pill = (bg: string, content: ReactNode) => (
    <div
      // left-16 (= 64px) keeps the pill clear of the Leaflet zoom control
      // that sits at top-left by default.
      className={`fixed top-4 left-16 z-[1000] ${bg} text-white rounded-full px-4 py-2 shadow-lg backdrop-blur-sm`}
    >
      <div className="text-sm font-medium tracking-wide">{content}</div>
      <div className="text-xs opacity-70 mt-0.5">{station.name}</div>
    </div>
  )

  if (loading) return pill(NEUTRAL_BG, 'Loading tide…')
  if (predictions.length === 0) return pill(NEUTRAL_BG, 'Tide unavailable')

  const { state, nextEvent } = getCurrentTideState(predictions, currentTime)
  const bg = PILL_BG[state]

  if (!nextEvent) {
    return pill(bg, 'END OF DAY')
  }

  const eventTime = format(parseISO(nextEvent.t), 'h:mm a')
  const direction = nextEvent.type === 'H' ? 'high' : 'low'

  return pill(
    bg,
    <>
      {state.toUpperCase()} <span aria-hidden>→</span> {eventTime} to {direction}
    </>,
  )
}

export default TideReadout
