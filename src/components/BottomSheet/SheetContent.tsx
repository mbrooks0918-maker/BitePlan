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
import { InstallAppButton, OfflineIndicator } from '@/components/Install/InstallPrompt'

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

/**
 * Settings section (Step 18) — real toggles live here now. Currently
 * exposes On-Water Mode; About / On-Water tutorial / preference options
 * land in a later step.
 */
function SettingsSection() {
  const onWater = useBitePlanStore((s) => s.onWaterMode)
  const setOnWater = useBitePlanStore((s) => s.setOnWaterMode)
  return (
    <section aria-label="Settings" className="mt-4">
      <div className="text-xs uppercase tracking-wider text-slate-400 mb-2 px-1">
        Settings
      </div>
      <div className="rounded-md bg-slate-800/40 border border-slate-800 divide-y divide-slate-800">
        <div className="px-3 py-3 flex items-start justify-between gap-3 min-h-[56px]">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-100">On-Water Mode</div>
            <div className="text-xs text-slate-400 mt-0.5 leading-snug">
              One-thumb sun-readable layout for the kayak: giant tide pill,
              Save Waypoint anchored to GPS.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={onWater}
            onClick={() => setOnWater(!onWater)}
            className={
              'shrink-0 mt-0.5 inline-flex h-6 w-11 items-center rounded-full transition-colors ' +
              (onWater ? 'bg-blue-600' : 'bg-slate-700')
            }
          >
            <span
              aria-hidden
              className={
                'inline-block size-5 rounded-full bg-white transition-transform ' +
                (onWater ? 'translate-x-5' : 'translate-x-0.5')
              }
            />
          </button>
        </div>
      </div>
      {/* Install row — Step 19. Hidden when the app is already installed
          so it doesn't clutter a Settings list that's mostly a stub. */}
      <div className="mt-3">
        <InstallAppButton />
      </div>
    </section>
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
      {/* Step 19: only visible when navigator.onLine === false. Sits in
          the always-visible Peek band so the user knows immediately that
          the engine is running on cached data. */}
      <OfflineIndicator />

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
          <SettingsSection />
          {/* Bottom padding so the last row clears the safe-area inset
              and the scroll feels finished. */}
          <div className="h-4" aria-hidden />
        </div>
      )}
    </div>
  )
}

export default SheetContent
