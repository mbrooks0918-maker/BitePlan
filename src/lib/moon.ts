import SunCalc from 'suncalc'

/**
 * Moon illumination fraction as a number 0.0 (new moon) to 1.0 (full moon).
 * Used by the scoring engine's moon-phase rule.
 */
export function getMoonIllumination(date: Date): number {
  return SunCalc.getMoonIllumination(date).fraction
}

/**
 * Sunrise and sunset times for `date` at `lat`/`lon` (in degrees).
 * Used by the scoring engine's time-of-day rule.
 */
export function getSunTimes(
  date: Date,
  lat: number,
  lon: number,
): { sunrise: Date; sunset: Date } {
  const t = SunCalc.getTimes(date, lat, lon)
  return { sunrise: t.sunrise, sunset: t.sunset }
}
