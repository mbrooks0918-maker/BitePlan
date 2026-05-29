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

/** Step 13.5 — barometric pressure series sourced from the raw NWS
 *  `/gridpoints/{office}/{x},{y}` endpoint. Values come back as a time series
 *  in pascals; we convert to inHg here and keep the original ISO validTime
 *  intervals as { startMs, inHg } samples.
 *
 *  Pressure factor (audit memo A.8) and frontal-phase detection (A.9) both
 *  read this. Empty array when the gridpoint fetch failed or pressure layer
 *  was missing — callers degrade to neutral pressure (30.00 inHg / 0 trend).
 */
export type PressureSample = {
  startMs: number
  endMs: number
  inHg: number
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
  /** Step 13.5 — pressure time series in inHg from the raw gridpoints
   *  endpoint. Sparser than `hourly` (NWS typically reports pressure every
   *  3-6 hours over the same forward window). Empty when the gridpoints
   *  fetch failed. */
  pressureSeries: PressureSample[]
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
    const parsed = JSON.parse(raw) as CacheEntry
    // Defensive shim for Step-13-era cache entries (pre-13.5) that don't
    // carry a pressureSeries field. Without this, every returning user with
    // a fresh-window cache crashes the scoring pass on first reload.
    if (!parsed.snapshot.pressureSeries) {
      parsed.snapshot.pressureSeries = []
    }
    return parsed
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
    forecastGridData?: string
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

type NwsGridValue = { validTime?: string; value?: number | null }
type NwsGridLayer = { uom?: string; values?: NwsGridValue[] }
type NwsGridResp = {
  properties?: {
    pressure?: NwsGridLayer
    // Some NWS offices report under `barometricPressure` instead — fall back
    // to that field if `pressure` is missing.
    barometricPressure?: NwsGridLayer
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

/**
 * Parse an NWS `validTime` interval of the form "2026-05-28T18:00:00+00:00/PT3H"
 * into start/end epoch ms. Returns [0, 0] when malformed.
 */
function parseValidTime(vt: string | undefined): [number, number] {
  if (!vt) return [0, 0]
  const slash = vt.indexOf('/')
  if (slash < 0) return [0, 0]
  const startIso = vt.slice(0, slash)
  const durStr = vt.slice(slash + 1)
  const startMs = new Date(startIso).getTime()
  if (!Number.isFinite(startMs)) return [0, 0]
  // ISO 8601 duration: PnYnMnDTnHnMnS. NWS only ever uses PTnH or PnD here.
  let hours = 0
  const hMatch = durStr.match(/PT(\d+)H/)
  if (hMatch) hours = Number(hMatch[1])
  const dMatch = durStr.match(/P(\d+)D/)
  if (dMatch) hours += Number(dMatch[1]) * 24
  const endMs = startMs + Math.max(1, hours) * 60 * 60 * 1000
  return [startMs, endMs]
}

/**
 * Pull the pressure layer out of a gridpoint response. NWS reports it in
 * pascals on most modern endpoints (`uom: "wmoUnit:Pa"`); convert to inHg.
 * If the layer is missing entirely, return an empty array — callers degrade
 * to neutral pressure.
 */
function extractPressureSeries(grid: NwsGridResp): PressureSample[] {
  const layer = grid.properties?.pressure ?? grid.properties?.barometricPressure
  const values = layer?.values
  if (!values || values.length === 0) return []
  const uom = (layer?.uom ?? '').toLowerCase()
  // Default conversion: Pa → inHg (× 0.00029530). NWS sometimes reports in
  // hPa/mbar — detect and scale up first.
  const toInHg = (v: number): number => {
    if (uom.includes('hpa') || uom.includes('mbar')) return v * 0.02953
    // Pa
    return v * 0.0002953
  }
  const out: PressureSample[] = []
  for (const v of values) {
    if (typeof v.value !== 'number' || !Number.isFinite(v.value)) continue
    const [startMs, endMs] = parseValidTime(v.validTime)
    if (startMs === 0) continue
    out.push({ startMs, endMs, inHg: toInHg(v.value) })
  }
  out.sort((a, b) => a.startMs - b.startMs)
  return out
}

async function fetchFromNws(lat: number, lon: number): Promise<WeatherSnapshot> {
  const pointsUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`
  const points = await fetchJson<NwsPointsResp>(pointsUrl)
  const hourlyUrl = points.properties?.forecastHourly
  const gridUrl = points.properties?.forecastGridData
  if (!hourlyUrl) {
    throw new Error('NWS points response missing forecastHourly URL')
  }

  // Hourly + gridpoints run in parallel. The gridpoints fetch is the slower
  // of the two (larger payload); if it fails for any reason we degrade
  // gracefully to an empty pressureSeries rather than failing the whole
  // snapshot — wind/temp/precip from `hourly` are the primary use case.
  const [hourly, grid] = await Promise.all([
    fetchJson<NwsHourlyResp>(hourlyUrl),
    gridUrl
      ? fetchJson<NwsGridResp>(gridUrl).catch((e) => {
          console.warn('[weather] gridpoints fetch failed (pressure will degrade):', e)
          return null
        })
      : Promise.resolve(null),
  ])

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

  const pressureSeries = grid ? extractPressureSeries(grid) : []

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
    pressureSeries,
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

// --- Step 13.5 pressure / front helpers ----------------------------------

/**
 * Pressure at `timeMs` (inHg). Linear scan of the (sparse) pressure series;
 * returns null when `timeMs` is outside the covered window so callers can
 * fall back to a neutral default.
 */
export function pressureAt(snapshot: WeatherSnapshot, timeMs: number): number | null {
  for (const p of snapshot.pressureSeries) {
    if (p.startMs <= timeMs && timeMs < p.endMs) return p.inHg
  }
  return null
}

/**
 * Forward-looking pressure trend in inHg per 3 h, sampled at `timeMs`. NWS
 * only publishes forecast forward of the snapshot's fetch time, so we proxy
 * "pressure is falling now" as `pressure(t + 3h) − pressure(t)`. Negative =
 * falling.
 *
 * This is the audit memo's pre-frontal bite signal (A.8). When the series
 * doesn't bracket either sample point we return 0 (stable) — neutral.
 */
export function pressureTrendInHgPer3hAt(
  snapshot: WeatherSnapshot,
  timeMs: number,
): number {
  const now = pressureAt(snapshot, timeMs)
  const fwd = pressureAt(snapshot, timeMs + 3 * 60 * 60 * 1000)
  if (now == null || fwd == null) return 0
  return fwd - now
}

/**
 * Classify the frontal-passage phase at `timeMs`.
 *
 * Heuristics (audit memo A.9):
 *  - 'pre'   : pressure dropping fast (> 0.10 inHg in next 6 h) OR forecast
 *              shortForecast contains storm/thunder/rain keywords within 24 h
 *  - 'during': very strong negative trend now (< -0.05 inHg/3h) AND current
 *              shortForecast contains 'thunder' / 'storm' / 'heavy rain'
 *  - 'post'  : 24–36 h after a recent front — heuristically, pressure is
 *              rising (> +0.05 inHg/3h) right after a stretch of low values
 *  - 'stable': default
 *
 * Detection is intentionally rough. We don't have ground-truth front timing
 * — these are forward-looking proxies derived from what NWS publishes.
 */
export function frontalPhaseAt(
  snapshot: WeatherSnapshot,
  timeMs: number,
): 'pre' | 'during' | 'post' | 'stable' {
  const SIX_H = 6 * 60 * 60 * 1000
  const HORIZON_24H = 24 * 60 * 60 * 1000

  const now = pressureAt(snapshot, timeMs)
  const plus6 = pressureAt(snapshot, timeMs + SIX_H)
  const trend3 = pressureTrendInHgPer3hAt(snapshot, timeMs)

  // Storm keywords in current short forecast → during.
  const currentHour = hourlyAt(snapshot, timeMs)
  const currentFc = (currentHour?.shortForecast ?? '').toLowerCase()
  const stormNow =
    /thunder|storm|heavy rain/i.test(currentFc) && trend3 < -0.05
  if (stormNow) return 'during'

  // Pre-frontal: forecast rain/thunder anywhere in next 24h OR pressure
  // dropping fast over the next 6h.
  let rainAhead = false
  for (const h of snapshot.hourly) {
    if (h.startMs >= timeMs && h.startMs < timeMs + HORIZON_24H) {
      if (/rain|shower|thunder|storm/i.test(h.shortForecast)) {
        rainAhead = true
        break
      }
    }
  }
  const fastDrop = now != null && plus6 != null && plus6 - now <= -0.10
  if (rainAhead || fastDrop) return 'pre'

  // Post-frontal: pressure rising (positive trend) after a recent low. We
  // approximate "recent low" by checking if the past 12 hours of the series
  // (where available — usually not, since it's forward-only) contained
  // values noticeably lower than now. Without historical data this collapses
  // to "rising trend now" → 'post'.
  if (trend3 > 0.05) return 'post'

  return 'stable'
}
