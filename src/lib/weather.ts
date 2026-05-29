/**
 * NOAA NWS weather (Step 13).
 *
 * Two-step lookup per the handoff doc:
 *   A. /points/{lat},{lon} → grid office + X/Y
 *   B. /gridpoints/{office}/{x},{y}/forecast/hourly → 12+ hours of forecast
 *
 * Cached per (rounded-lat, rounded-lon) with the same SWR pattern as the
 * tide cache: <1h old returns immediately, stale cache is returned while a
 * background refetch updates it, hard failure returns null so the scoring
 * engine degrades to wind=0.
 *
 * NWS is browser-friendly (no API key, CORS-enabled). The User-Agent header
 * is set per their docs; modern browsers may strip custom UA on fetch, which
 * is fine — NWS accepts default browser UA too.
 */

const NWS_USER_AGENT = 'BitePlan (https://biteplan.vercel.app)'
const FRESH_WINDOW_MS = 60 * 60 * 1000 // 1 hour

// --- public types ---------------------------------------------------------

export type WindObservation = {
  speedKt: number
  directionDeg: number
  directionCompass: string
}

export type HourlyPeriod = {
  /** Epoch ms — start of this hour. */
  startMs: number
  /** Epoch ms — end of this hour. */
  endMs: number
  shortForecast: string
  windSpeedKt: number
  windDirectionDeg: number
  windDirectionCompass: string
  precipProbability: number // 0-100
  temperatureF: number
}

export type WeatherSnapshot = {
  current: {
    speedKt: number
    directionDeg: number
    directionCompass: string
    shortForecast: string
    precipProbability: number
    temperatureF: number
  }
  /** Hour-by-hour forecast, sorted ascending by startMs. NWS typically
   *  returns ~156 hours; we keep the full set so projection windows out to
   *  day +7 can sample real per-hour wind where it exists. */
  hourly: HourlyPeriod[]
  fetchedAt: number
}

// --- helpers --------------------------------------------------------------

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
const COMPASS_16_TO_DEG: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5,
  E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5,
  W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
}

function degToCompass(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360
  const idx = Math.round(normalized / 45) % 8
  return COMPASS_8[idx]
}

/**
 * NWS reports wind direction as either a degree number (older payloads) or
 * a 16-point cardinal string like "SSE". Normalize both into { deg, compass }
 * with an 8-point compass label.
 */
function normalizeWindDirection(raw: number | string | null | undefined): {
  deg: number
  compass: string
} {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { deg: raw, compass: degToCompass(raw) }
  }
  if (typeof raw === 'string') {
    const key = raw.toUpperCase().trim()
    if (key in COMPASS_16_TO_DEG) {
      const deg = COMPASS_16_TO_DEG[key]
      return { deg, compass: degToCompass(deg) }
    }
  }
  return { deg: 0, compass: 'N' }
}

/**
 * Parse "12 mph" or "5 to 10 mph" into mph (number). For a range we take
 * the upper bound — a conservative read for fishing context (the gust side
 * is what actually blows you off the water).
 */
function parseWindSpeedMph(raw: string | number | null | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string') return 0
  const matches = raw.match(/\d+(?:\.\d+)?/g)
  if (!matches || matches.length === 0) return 0
  return Number(matches[matches.length - 1])
}

function mphToKnots(mph: number): number {
  return mph * 0.868976
}

function cacheKey(lat: number, lon: number): string {
  return `cache:weather:${lat.toFixed(2)}:${lon.toFixed(2)}`
}

type CacheEntry = { snapshot: WeatherSnapshot; cachedAt: number }

function readCache(key: string): CacheEntry | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as CacheEntry
  } catch {
    return null
  }
}

function writeCache(key: string, entry: CacheEntry): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    // quota / disabled — non-fatal
  }
}

// --- NWS fetch ------------------------------------------------------------

type NwsPointsResp = {
  properties?: {
    forecastHourly?: string
    gridId?: string
    gridX?: number
    gridY?: number
  }
}

type NwsHourlyResp = {
  properties?: {
    periods?: Array<{
      startTime?: string
      endTime?: string
      shortForecast?: string
      windSpeed?: string
      windDirection?: string | number
      probabilityOfPrecipitation?: { value?: number | null } | null
      temperature?: number
    }>
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': NWS_USER_AGENT,
      Accept: 'application/geo+json',
    },
  })
  if (!res.ok) throw new Error(`NWS HTTP ${res.status} for ${url}`)
  return (await res.json()) as T
}

async function fetchFromNws(lat: number, lon: number): Promise<WeatherSnapshot> {
  const pointsUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`
  const points = await fetchJson<NwsPointsResp>(pointsUrl)
  const hourlyUrl = points.properties?.forecastHourly
  if (!hourlyUrl) {
    throw new Error('NWS points response missing forecastHourly URL')
  }
  const hourly = await fetchJson<NwsHourlyResp>(hourlyUrl)
  const periods = hourly.properties?.periods ?? []
  if (periods.length === 0) {
    throw new Error('NWS hourly response had no periods')
  }

  const parsed: HourlyPeriod[] = periods.map((p) => {
    const mph = parseWindSpeedMph(p.windSpeed)
    const windKt = mphToKnots(mph)
    const dir = normalizeWindDirection(p.windDirection)
    return {
      startMs: p.startTime ? new Date(p.startTime).getTime() : 0,
      endMs: p.endTime ? new Date(p.endTime).getTime() : 0,
      shortForecast: p.shortForecast ?? '',
      windSpeedKt: windKt,
      windDirectionDeg: dir.deg,
      windDirectionCompass: dir.compass,
      precipProbability: p.probabilityOfPrecipitation?.value ?? 0,
      temperatureF: typeof p.temperature === 'number' ? p.temperature : 0,
    }
  })

  parsed.sort((a, b) => a.startMs - b.startMs)
  const first = parsed[0]

  return {
    current: {
      speedKt: first.windSpeedKt,
      directionDeg: first.windDirectionDeg,
      directionCompass: first.windDirectionCompass,
      shortForecast: first.shortForecast,
      precipProbability: first.precipProbability,
      temperatureF: first.temperatureF,
    },
    hourly: parsed,
    fetchedAt: Date.now(),
  }
}

// --- public entrypoint ----------------------------------------------------

/**
 * SWR fetch wrapper. Returns the snapshot if available, even when the cache
 * is stale and the background refetch fails. Returns null only when there's
 * no cache AND the network call fails — callers should fall back to wind=0.
 */
export async function fetchWeather(
  lat: number,
  lon: number,
): Promise<WeatherSnapshot | null> {
  const key = cacheKey(lat, lon)
  const cached = readCache(key)
  const now = Date.now()

  if (cached && now - cached.cachedAt < FRESH_WINDOW_MS) {
    return cached.snapshot
  }

  if (cached) {
    // Stale → return cached, refresh in background.
    void (async () => {
      try {
        const fresh = await fetchFromNws(lat, lon)
        writeCache(key, { snapshot: fresh, cachedAt: Date.now() })
      } catch (e) {
        console.warn('[weather] background refresh failed:', e)
      }
    })()
    return cached.snapshot
  }

  try {
    const fresh = await fetchFromNws(lat, lon)
    writeCache(key, { snapshot: fresh, cachedAt: now })
    return fresh
  } catch (e) {
    console.warn('[weather] fetch failed, no cache available:', e)
    return null
  }
}

/**
 * Find the hourly forecast period covering `timeMs`. Returns null if `timeMs`
 * sits beyond the forecast window (caller should fall back to current wind).
 */
export function hourlyAt(snapshot: WeatherSnapshot, timeMs: number): HourlyPeriod | null {
  // Binary search would be nice; the periods array is small (≤ 156 entries),
  // linear scan is fine and clear.
  for (const h of snapshot.hourly) {
    if (h.startMs <= timeMs && timeMs < h.endMs) return h
  }
  return null
}
