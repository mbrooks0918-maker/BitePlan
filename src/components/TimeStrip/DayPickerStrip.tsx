/**
 * Wraps DayPicker in the same fixed-bottom strip chrome as TimeSlider so the
 * 24h / 7-day toggle swaps content cleanly. TEMPORARY placement (Step 11) —
 * Step 16's bottom sheet will host both modes.
 */

import DayPicker from './DayPicker'
import ModeToggle from './ModeToggle'

function DayPickerStrip() {
  return (
    <div
      // Mirrors TimeSlider's container so the visual position doesn't jump
      // when the user toggles modes.
      className="fixed bottom-3 inset-x-3 sm:inset-x-6 z-[1000] bg-slate-900/85 backdrop-blur-sm rounded-2xl shadow-xl px-4 pt-3 pb-3"
    >
      <div className="flex items-center justify-between mb-2">
        <ModeToggle />
        <div className="text-xs text-slate-400">Next 7 days</div>
      </div>
      <DayPicker />
    </div>
  )
}

export default DayPickerStrip
