/**
 * Wraps DayPicker for the 7-day mode. Embedded inside the BottomSheet's
 * Half snap (Step 16). The mode toggle and Trip toggle now live in
 * SheetContent / LayerToggles respectively.
 */

import { useMemo } from 'react'
import { startOfDay } from 'date-fns'
import DayPicker from './DayPicker'

function DayPickerStrip() {
  const startDate = useMemo(() => startOfDay(new Date()), [])
  return (
    <div className="relative w-full">
      <div className="flex items-center justify-end mb-2">
        <div className="text-xs text-slate-400">Next 7 days</div>
      </div>
      <DayPicker startDate={startDate} dayCount={7} />
    </div>
  )
}

export default DayPickerStrip
