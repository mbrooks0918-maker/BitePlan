/**
 * WeatherLine (Step 16 — Half snap header).
 *
 * Single-row weather summary that takes the place of the old floating
 * top-left WeatherReadout pill. Format:
 *   "12 kt SE · Partly Cloudy · 75°F"  (+ small precip chip when > 20%)
 *
 * Color-coded by wind impact using the same bands as the original pill so
 * the eye carries the association: slate < 10 kt, amber 10–19, red 20+.
 *
 * The expanded hourly forecast is reserved for a future polish pass; this
 * step just lands the consolidated layout.
 */
import { CloudRain, Wind } from 'lucide-react'
import { useBitePlanStore } from '@/store/useBitePlanStore'

function bgFor(kt: number): string {
  if (kt < 10) return 'bg-slate-800'
  if (kt < 15) return 'bg-amber-900/60'
  if (kt < 20) return 'bg-amber-800/80'
  return 'bg-red-900/70'
}

function WeatherLine() {
  const weather = useBitePlanStore((s) => s.currentWeather)
  const loading = useBitePlanStore((s) => s.weatherLoading)

  if (loading && !weather) {
    return (
      <div className="bg-slate-800 rounded-md px-3 py-2 text-xs text-slate-300 flex items-center gap-2 min-h-[36px]">
        <Wind className="size-3.5" /> Loading weather…
      </div>
    )
  }
  if (!weather) {
    return (
      <div className="bg-slate-800 rounded-md px-3 py-2 text-xs text-slate-300 flex items-center gap-2 min-h-[36px]">
        <Wind className="size-3.5" /> Weather unavailable
      </div>
    )
  }

  const { speedKt, directionCompass, shortForecast, precipProbability, temperatureF } =
    weather.current
  const bg = bgFor(speedKt)
  return (
    <div className={`${bg} rounded-md px-3 py-2 text-xs text-slate-100 flex items-center gap-2 min-h-[36px]`}>
      <Wind className="size-3.5 shrink-0 opacity-90" />
      <span className="font-medium tabular-nums">
        {speedKt.toFixed(0)} kt {directionCompass}
      </span>
      <span className="text-slate-300/90 truncate">· {shortForecast || '—'}</span>
      <span className="ml-auto shrink-0 text-slate-300 tabular-nums">{Math.round(temperatureF)}°F</span>
      {precipProbability > 20 && (
        <span className="flex items-center gap-0.5 text-slate-100 ml-1 shrink-0">
          <CloudRain className="size-3" />
          {Math.round(precipProbability)}%
        </span>
      )}
    </div>
  )
}

export default WeatherLine
