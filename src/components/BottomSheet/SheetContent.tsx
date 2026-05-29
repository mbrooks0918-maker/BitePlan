/**
 * SheetContent (Step 16) — composes Peek / Half / Full sections.
 *
 * Layout strategy: every section is always in the DOM (so transitions on
 * the parent's height naturally reveal/hide them). Full-snap-only sections
 * lazily mount once `sheetSnapPoint` has reached 'full' at least once —
 * after that they stay mounted so subsequent expansions feel instant.
 *
 * Section order (top → bottom):
 *
 *   PEEK    : ConditionsPanel (tide pill + score + time indicator)
 *   HALF    : WeatherLine
 *             TimeModePicker (24h | 7day) + the active picker
 *             TopZonesList
 *             TierFilter + SpeciesFilter
 *   FULL    : LayerToggles
 *             WaypointsList
 *             Settings stub
 */
import { useEffect, useState } from 'react'
import { isTripModeActive, useBitePlanStore } from '@/store/useBitePlanStore'
import ConditionsPanel from './ConditionsPanel'
import WeatherLine from './WeatherLine'
import TopZonesList from './TopZonesList'
import TierFilter from './TierFilter'
import SpeciesFilter from './SpeciesFilter'
import LayerToggles from './LayerToggles'
import WaypointsList from './WaypointsList'
import TimeSlider from '@/components/TimeStrip/TimeSlider'
import DayPickerStrip from '@/components/TimeStrip/DayPickerStrip'
import TripStrip from '@/components/Trip/TripStrip'

function ModeToggle() {
  const timeMode = useBitePlanStore((s) => s.timeMode)
  const setTimeMode = useBitePlanStore((s) => s.setTimeMode)
  return (
    <div role="radiogroup" aria-label="Time mode" className="inline-flex bg-slate-800 rounded-full p-0.5">
      <button
        type="button"
        role="radio"
        aria-checked={timeMode === '24h'}
        onClick={() => setTimeMode('24h')}
        className={
          'rounded-full px-3 py-1 text-xs font-medium ' +
          (timeMode === '24h'
            ? 'bg-slate-100 text-slate-900'
            : 'text-slate-300 hover:text-slate-100')
        }
      >
        24-hour
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={timeMode === '7day'}
        onClick={() => setTimeMode('7day')}
        className={
          'rounded-full px-3 py-1 text-xs font-medium ' +
          (timeMode === '7day'
            ? 'bg-slate-100 text-slate-900'
            : 'text-slate-300 hover:text-slate-100')
        }
      >
        7-day
      </button>
    </div>
  )
}

function SheetContent() {
  const snap = useBitePlanStore((s) => s.sheetSnapPoint)
  const timeMode = useBitePlanStore((s) => s.timeMode)
  const tripOverride = useBitePlanStore((s) => s.tripModeOverride)
  const tripActive = isTripModeActive(tripOverride)

  // Lazy-mount the Full sections. Once flipped true they stay mounted.
  const [everOpenedFull, setEverOpenedFull] = useState(snap === 'full')
  useEffect(() => {
    if (snap === 'full' && !everOpenedFull) setEverOpenedFull(true)
  }, [snap, everOpenedFull])

  return (
    <div className="space-y-2">
      {/* PEEK — always visible */}
      <ConditionsPanel />

      {/* HALF — visible when snap ≥ 'half' (the parent height-clip hides
          it at peek). We render unconditionally so the transition reveals
          it smoothly. */}
      <div className="space-y-3 pt-1">
        <WeatherLine />

        {/* Time strip — mode toggle + active picker. Trip Mode replaces
            the day picker entirely while the trip is active (the existing
            routing logic from Steps 11/12). */}
        <section aria-label="Time controls">
          <div className="flex items-center justify-between gap-2 mb-2 px-1">
            <ModeToggle />
            {timeMode === '7day' && tripActive && (
              <span className="text-[10px] uppercase tracking-wider text-amber-300/90">
                Trip Mode active
              </span>
            )}
          </div>
          <div className="bg-slate-800/30 rounded-md border border-slate-800 p-2">
            {timeMode === '24h' ? (
              <TimeSlider />
            ) : tripActive ? (
              <TripStrip />
            ) : (
              <DayPickerStrip />
            )}
          </div>
        </section>

        <TopZonesList />
        <TierFilter />
        <SpeciesFilter />
      </div>

      {/* FULL — only render once user has reached Full at least once. */}
      {everOpenedFull && (
        <div className="space-y-4 pt-2">
          <LayerToggles />
          <WaypointsList />
          <section aria-label="Settings" className="mt-4">
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-2 px-1">
              Settings
            </div>
            <div className="rounded-md bg-slate-800/30 border border-slate-800 px-3 py-3 text-xs text-slate-400">
              Settings: On-Water Mode, About — coming soon.
            </div>
          </section>
          {/* Bottom padding so the last row clears the safe-area inset
              and the scroll feels finished. */}
          <div className="h-4" aria-hidden />
        </div>
      )}
    </div>
  )
}

export default SheetContent
