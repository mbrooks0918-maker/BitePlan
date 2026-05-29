/**
 * TEMPORARY positioning (matches TideReadout): floats top-left of the map,
 * stacked directly under the tide pill. In Step 16 this readout will move
 * into the bottom sheet's peek state alongside tide.
 *
 * Shows the current wind speed + 8-point compass direction (the same number
 * the scoring engine is using), a short NWS forecast phrase, and a precip
 * chance indicator when probability > 20%. Background tracks wind impact on
 * the scoring rule (calm/light/chop/blown-out).
 */
import { Wind, CloudRain } from 'lucide-react'
import type { ReactNode } from 'react'
import { useBitePlanStore } from '@/store/useBitePlanStore'

const NEUTRAL_BG = 'bg-slate-700/70'

/**
 * Bucket the wind speed onto the same break-points the scoring rule uses
 * (see `src/lib/scoring.ts` wind block). Keeps the pill colour and the score
 * factor visually in lockstep.
 */
function windBg(kt: number): string {
  if (kt < 10) return 'bg-slate-700/70'
  if (kt < 15) return 'bg-amber-700/70'
  if (kt < 20) return 'bg-amber-800/80'
  return 'bg-red-800/80'
}

function WeatherReadout() {
  const weather = useBitePlanStore((s) => s.currentWeather)
  const loading = useBitePlanStore((s) => s.weatherLoading)

  // top-4 is the tide pill row; weather sits one row down (top-20 ≈ 80px =
  // tide pill height + gap).
  const pill = (bg: string, content: ReactNode, sub?: ReactNode) => (
    <div
      className={`fixed top-20 left-16 z-[1000] ${bg} text-white rounded-2xl px-4 py-2 shadow-lg backdrop-blur-sm min-w-[140px]`}
    >
      <div className="flex items-center gap-2 text-sm font-medium tracking-wide">
        <Wind size={14} className="opacity-90" />
        {content}
      </div>
      {sub ? <div className="text-xs opacity-80 mt-0.5">{sub}</div> : null}
    </div>
  )

  if (loading && !weather) return pill(NEUTRAL_BG, 'Loading weather…')
  if (!weather) return pill(NEUTRAL_BG, 'Weather unavailable')

  const { speedKt, directionCompass, shortForecast, precipProbability } = weather.current
  const speedDisplay = `${speedKt.toFixed(0)} kt ${directionCompass}`

  const sub = (
    <span className="flex items-center gap-2">
      <span>{shortForecast || '—'}</span>
      {precipProbability > 20 ? (
        <span className="flex items-center gap-0.5 opacity-90">
          <CloudRain size={11} />
          {Math.round(precipProbability)}%
        </span>
      ) : null}
    </span>
  )

  return pill(windBg(speedKt), speedDisplay, sub)
}

export default WeatherReadout
