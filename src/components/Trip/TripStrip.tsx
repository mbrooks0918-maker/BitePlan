/**
 * Trip Mode strip (Step 12 → embedded in BottomSheet at Step 16).
 *
 * When Trip Mode is active, the multi-day view swaps from the generic
 * "next 7 days from today" picker to a focused 12-card forecast covering
 * the Jun 1–12, 2026 Perdido Key kayak-fishing trip. Reuses the Step 11
 * DayPicker verbatim — only the (startDate, dayCount) parameters differ,
 * plus an informational banner above the cards.
 *
 * Step 16: removed the floating placement + the ModeToggle / TripToggle
 * row (those moved into SheetContent and LayerToggles respectively).
 */

import { useMemo } from 'react'
import { Tent } from 'lucide-react'
import DayPicker from '@/components/TimeStrip/DayPicker'

// Hardcoded per the handoff doc's "Trip Mode (locked behavior)" section.
// 2026, month 5 = June (0-indexed); midnight local on June 1.
const TRIP_START = new Date(2026, 5, 1, 0, 0, 0, 0)
const TRIP_DAY_COUNT = 12

function TripStrip() {
  const startDate = useMemo(() => TRIP_START, [])

  return (
    <div className="relative w-full">
      {/* Trip Mode banner — informational, sits above the cards */}
      <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber-500/15 ring-1 ring-amber-500/30 px-3 py-1.5">
        <Tent className="size-4 text-amber-400 shrink-0" />
        <div className="leading-tight">
          <div className="text-sm font-semibold text-amber-200">
            Trip Mode: Jun 1–12
          </div>
          <div className="text-[10px] text-amber-200/70">
            Perdido Key · 12-day kayak fishing forecast
          </div>
        </div>
      </div>

      <DayPicker startDate={startDate} dayCount={TRIP_DAY_COUNT} />
    </div>
  )
}

export default TripStrip
