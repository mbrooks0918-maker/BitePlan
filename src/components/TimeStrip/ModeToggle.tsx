/**
 * TEMPORARY placement (Step 11):
 *
 * Small two-button segmented control toggling the time strip between the
 * 24-hour slider (Step 10) and the 7-day picker (Step 11). Will live inside
 * the bottom sheet once Step 16 lands.
 */

import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { TimeMode } from '@/types'

const OPTIONS: Array<{ value: TimeMode; label: string }> = [
  { value: '24h', label: '24-hour' },
  { value: '7day', label: '7-day' },
]

function ModeToggle() {
  const timeMode = useBitePlanStore((s) => s.timeMode)
  const setTimeMode = useBitePlanStore((s) => s.setTimeMode)

  return (
    <div
      role="tablist"
      aria-label="Time strip mode"
      className="inline-flex rounded-full bg-slate-800/80 p-1 backdrop-blur-sm"
    >
      {OPTIONS.map((opt) => {
        const active = opt.value === timeMode
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setTimeMode(opt.value)}
            className={
              active
                ? 'rounded-full bg-slate-100 text-slate-900 px-3 py-1 text-xs font-semibold'
                : 'rounded-full text-slate-400 hover:text-slate-200 px-3 py-1 text-xs font-medium'
            }
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export default ModeToggle
