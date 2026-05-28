/**
 * Minimal ambient types for `suncalc` (the package ships no types and we'd
 * rather not pull @types/suncalc just for this). Add fields as needed.
 */
declare module 'suncalc' {
  export function getMoonIllumination(date: Date): {
    /** 0.0 (new moon) to 1.0 (full moon). */
    fraction: number
    /** 0.0 to 1.0 around the lunar cycle. */
    phase: number
    /** Angle of bright limb in radians. */
    angle: number
  }

  export function getTimes(
    date: Date,
    lat: number,
    lon: number,
  ): {
    sunrise: Date
    sunset: Date
    solarNoon: Date
    dawn: Date
    dusk: Date
    nadir: Date
    night: Date
    nightEnd: Date
    [k: string]: Date
  }
}
