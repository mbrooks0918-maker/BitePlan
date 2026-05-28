import { parseISO } from 'date-fns'

export type TidePrediction = {
  /** ISO local-time, e.g. "2026-05-27T14:35". No timezone offset; NOAA returns
   *  local time when time_zone=lst_ldt and we keep it that way to match how the
   *  scoring engine and UI will reason about wall-clock time. */
  t: string
  /** Predicted water level, feet (units=english). */
  v: number
  /** NOAA event type: 'H' = high water, 'L' = low water. */
  type: 'H' | 'L'
}

/**
 * A point on the smooth 6-minute tide curve. Same time + water-level shape
 * as TidePrediction but no event classification — the curve is purely for
 * visual rendering behind the slider.
 */
export type TideCurvePoint = {
  t: string
  v: number
}

const FRESH_WINDOW_MS = 60 * 60 * 1000 // 1 hour

// --- date helpers ----------------------------------------------------------

function formatYYYYMMDD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function cacheKey(stationId: string, date: Date): string {
  return `cache:tide:${stationId}:${formatYYYYMMDD(date)}`
}

function curveCacheKey(stationId: string, date: Date): string {
  return `cache:tidecurve:${stationId}:${formatYYYYMMDD(date)}`
}

// --- local cache (window.localStorage) -------------------------------------

type CacheEntry<T> = {
  predictions: T
  cachedAt: number // epoch ms
}

function readCache<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as CacheEntry<T>
  } catch {
    return null
  }
}

function writeCache<T>(key: string, entry: CacheEntry<T>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    // Quota errors or disabled storage — non-fatal, just skip caching.
  }
}

// --- NOAA fetch ------------------------------------------------------------

async function fetchFromNoaa(stationId: string, date: Date): Promise<TidePrediction[]> {
  const ymd = formatYYYYMMDD(date)
  const params = new URLSearchParams({
    product: 'predictions',
    application: 'BitePlan',
    begin_date: ymd,
    end_date: ymd,
    datum: 'MLLW',
    station: stationId,
    time_zone: 'lst_ldt',
    units: 'english',
    interval: 'hilo',
    format: 'json',
  })
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${params}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`)
  const body = (await res.json()) as {
    predictions?: Array<{ t: string; v: string; type: 'H' | 'L' }>
    error?: { message?: string }
  }
  if (body.error) throw new Error(`NOAA error: ${body.error.message ?? 'unknown'}`)

  return (body.predictions ?? []).map((p) => ({
    // NOAA returns "YYYY-MM-DD HH:MM" — replace space with 'T' so parseISO
    // accepts it and reads it as local time (no offset).
    t: p.t.replace(' ', 'T'),
    v: parseFloat(p.v),
    type: p.type,
  }))
}

/**
 * Stale-while-revalidate fetch per the handoff doc.
 *
 *   - cache <1h old → return immediately, no network call
 *   - cache stale   → return stale data, kick off a silent background refetch
 *   - no cache      → fetch fresh; on failure return [] and log the error
 */
export async function fetchTidePredictions(
  stationId: string,
  date: Date,
): Promise<TidePrediction[]> {
  const key = cacheKey(stationId, date)
  const cached = readCache<TidePrediction[]>(key)
  const now = Date.now()

  if (cached && now - cached.cachedAt < FRESH_WINDOW_MS) {
    return cached.predictions
  }

  if (cached) {
    // Background revalidate — don't block the caller.
    void (async () => {
      try {
        const fresh = await fetchFromNoaa(stationId, date)
        writeCache(key, { predictions: fresh, cachedAt: Date.now() })
      } catch (e) {
        console.warn('[tides] background refetch failed:', e)
      }
    })()
    return cached.predictions
  }

  try {
    const fresh = await fetchFromNoaa(stationId, date)
    writeCache(key, { predictions: fresh, cachedAt: now })
    return fresh
  } catch (e) {
    console.error('[tides] fetch failed and no cache available:', e)
    return []
  }
}

// --- smooth 6-minute curve fetch -------------------------------------------

async function fetchCurveFromNoaa(
  stationId: string,
  date: Date,
): Promise<TideCurvePoint[]> {
  const ymd = formatYYYYMMDD(date)
  const params = new URLSearchParams({
    product: 'predictions',
    application: 'BitePlan',
    begin_date: ymd,
    end_date: ymd,
    datum: 'MLLW',
    station: stationId,
    time_zone: 'lst_ldt',
    units: 'english',
    interval: '6',
    format: 'json',
  })
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${params}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`)
  const body = (await res.json()) as {
    predictions?: Array<{ t: string; v: string }>
    error?: { message?: string }
  }
  if (body.error) throw new Error(`NOAA error: ${body.error.message ?? 'unknown'}`)

  return (body.predictions ?? []).map((p) => ({
    t: p.t.replace(' ', 'T'),
    v: parseFloat(p.v),
  }))
}

/**
 * Same SWR pattern as fetchTidePredictions, but pulls the smooth ~240-point
 * 6-minute curve (NOAA `interval=6`) used by the time slider's background
 * tide chart.
 */
export async function fetchTideCurve(
  stationId: string,
  date: Date,
): Promise<TideCurvePoint[]> {
  const key = curveCacheKey(stationId, date)
  const cached = readCache<TideCurvePoint[]>(key)
  const now = Date.now()

  if (cached && now - cached.cachedAt < FRESH_WINDOW_MS) {
    return cached.predictions
  }

  if (cached) {
    void (async () => {
      try {
        const fresh = await fetchCurveFromNoaa(stationId, date)
        writeCache(key, { predictions: fresh, cachedAt: Date.now() })
      } catch (e) {
        console.warn('[tides] curve background refetch failed:', e)
      }
    })()
    return cached.predictions
  }

  try {
    const fresh = await fetchCurveFromNoaa(stationId, date)
    writeCache(key, { predictions: fresh, cachedAt: now })
    return fresh
  } catch (e) {
    console.error('[tides] curve fetch failed and no cache available:', e)
    return []
  }
}

// --- multi-day window assembly --------------------------------------------

/**
 * Gulf-coast tides are largely diurnal, and at subordinate NOAA stations
 * (e.g. Nix Point) a single calendar day may publish only one hi/lo event.
 * That breaks getCurrentTideState's bracketing — the prev and/or next event
 * sits on yesterday or tomorrow.
 *
 * This helper fetches yesterday + today + tomorrow in parallel and returns a
 * single time-sorted event list, so callers can bracket across day boundaries
 * without doing the orchestration themselves. All three fetches reuse the
 * SWR cache (cache:tide:{stationId}:{YYYYMMDD}) — repeat calls within an hour
 * cost nothing.
 *
 * Any failed day degrades to [] for that day instead of throwing.
 */
export async function assembleTideWindow(
  stationId: string,
  around: Date,
): Promise<TidePrediction[]> {
  const dayMs = 24 * 60 * 60 * 1000
  const yesterday = new Date(around.getTime() - dayMs)
  const today = around
  const tomorrow = new Date(around.getTime() + dayMs)

  const [y, t, tm] = await Promise.all([
    fetchTidePredictions(stationId, yesterday).catch(() => [] as TidePrediction[]),
    fetchTidePredictions(stationId, today).catch(() => [] as TidePrediction[]),
    fetchTidePredictions(stationId, tomorrow).catch(() => [] as TidePrediction[]),
  ])

  return [...y, ...t, ...tm].sort(
    (a, b) => parseISO(a.t).getTime() - parseISO(b.t).getTime(),
  )
}

/**
 * Local tide swing — the magnitude between the previous and next hi/lo
 * events around `around`. Used for the "daily tide range" scoring rule. This
 * is a slight reinterpretation of the rule (the handoff said "daily" range)
 * but better matches its intent ("are tides moving energetically right now?")
 * and works on Gulf diurnal days where a calendar day may only publish one
 * event.
 *
 * Falls back to max−min over all `predictions` when bracketing isn't possible,
 * and to 1.0 (moderate) when there are no usable events.
 */
export function dailyTideRange(predictions: TidePrediction[], around: Date): number {
  if (predictions.length === 0) return 1.0

  const aroundMs = around.getTime()
  const sorted = predictions
    .map((p) => ({ p, ms: parseISO(p.t).getTime() }))
    .sort((a, b) => a.ms - b.ms)

  const prev = [...sorted].reverse().find((e) => e.ms <= aroundMs) ?? null
  const next = sorted.find((e) => e.ms > aroundMs) ?? null

  if (prev && next) return Math.abs(prev.p.v - next.p.v)

  if (predictions.length >= 2) {
    const vs = predictions.map((p) => p.v)
    return Math.max(...vs) - Math.min(...vs)
  }
  return 1.0
}

// --- synthesised curve (for subordinate stations) -------------------------

const SEMI_DIURNAL_HALF_PERIOD_MS = 6.21 * 60 * 60 * 1000

function isoLocal(t: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Build a smooth water-level curve out of the day's hi/lo events using cosine
 * interpolation between consecutive events. Used as a fallback when NOAA's
 * `interval=6` smooth curve isn't available (subordinate tide-table stations
 * like Nix Point have hi/lo offsets only, not full primary observations).
 *
 * Approximation only — fine for the slider's background reference.
 */
export function synthesizeCurveFromHilo(
  hilo: TidePrediction[],
  dayStart: Date,
): TideCurvePoint[] {
  if (hilo.length === 0) return []

  type Evt = { t: number; v: number; type: 'H' | 'L' }
  const events: Evt[] = hilo
    .map((p) => ({ t: parseISO(p.t).getTime(), v: p.v, type: p.type }))
    .sort((a, b) => a.t - b.t)

  // Reasonable default values for opposite-type synthetic events when only
  // one polarity is observed.
  const highs = events.filter((e) => e.type === 'H').map((e) => e.v)
  const lows = events.filter((e) => e.type === 'L').map((e) => e.v)
  const avgH = highs.length > 0 ? highs.reduce((a, b) => a + b, 0) / highs.length : 1
  const avgL = lows.length > 0 ? lows.reduce((a, b) => a + b, 0) / lows.length : 0
  // If we only saw one polarity, fall back to a ~1 ft swing from it.
  const synthH = highs.length > 0 ? avgH : avgL + 1
  const synthL = lows.length > 0 ? avgL : avgH - 1

  // Extend events backward and forward by ~half-period chunks so every minute
  // of the day has a bounding pair to interpolate between.
  const dayBeginMs = dayStart.getTime()
  const dayEndMs = dayBeginMs + 24 * 60 * 60 * 1000
  const extended: Evt[] = [...events]
  while (extended[0].t > dayBeginMs - SEMI_DIURNAL_HALF_PERIOD_MS) {
    const first = extended[0]
    const newType = first.type === 'H' ? 'L' : 'H'
    extended.unshift({
      t: first.t - SEMI_DIURNAL_HALF_PERIOD_MS,
      v: newType === 'H' ? synthH : synthL,
      type: newType,
    })
  }
  while (extended[extended.length - 1].t < dayEndMs + SEMI_DIURNAL_HALF_PERIOD_MS) {
    const last = extended[extended.length - 1]
    const newType = last.type === 'H' ? 'L' : 'H'
    extended.push({
      t: last.t + SEMI_DIURNAL_HALF_PERIOD_MS,
      v: newType === 'H' ? synthH : synthL,
      type: newType,
    })
  }

  // Walk the day in 6-min steps; for each step, find the bounding pair and
  // cosine-interpolate so the curve looks like an organic tidal wave.
  const points: TideCurvePoint[] = []
  for (let i = 0; i <= 240; i++) {
    const t = dayBeginMs + i * 6 * 60 * 1000
    let prev = extended[0]
    let next = extended[extended.length - 1]
    for (let j = 0; j < extended.length - 1; j++) {
      if (extended[j].t <= t && t <= extended[j + 1].t) {
        prev = extended[j]
        next = extended[j + 1]
        break
      }
    }
    const span = next.t - prev.t
    const ratio = span === 0 ? 0 : (t - prev.t) / span
    const cosRatio = (1 - Math.cos(Math.PI * ratio)) / 2
    const v = prev.v + (next.v - prev.v) * cosRatio
    points.push({ t: isoLocal(t), v })
  }
  return points
}

// --- current tide state ----------------------------------------------------

export type TideState = 'rising' | 'falling' | 'slack'

export type TideStateInfo = {
  state: TideState
  /** The upcoming high/low event, or null if all today's events are in the past. */
  nextEvent: TidePrediction | null
  /** Minutes from `now` to `nextEvent.t`. 0 when nextEvent is null. */
  minutesToNext: number
}

/**
 * Classify the current tide using cross-day bracketing.
 *
 * Caller must pass a multi-day merged event list (use `assembleTideWindow`),
 * so the prev and next events can sit on yesterday / today / tomorrow. This
 * matters on Gulf diurnal days where a calendar day may publish only one
 * hi/lo event — without a wider window, the function couldn't tell whether
 * the tide is rising or falling on either side of that single event.
 *
 * - Within 20 min of either bracketing event → 'slack'.
 * - Otherwise the tide is heading toward `nextEvent`:
 *     nextEvent.type === 'H' → 'rising'
 *     nextEvent.type === 'L' → 'falling'.
 */
export function getCurrentTideState(
  predictions: TidePrediction[],
  now: Date,
): TideStateInfo {
  if (predictions.length === 0) {
    return { state: 'slack', nextEvent: null, minutesToNext: 0 }
  }

  const nowMs = now.getTime()
  const events = predictions
    .map((p) => ({ p, ms: parseISO(p.t).getTime() }))
    .sort((a, b) => a.ms - b.ms)

  // prev = most recent event at-or-before now, anywhere in the window
  // next = first event strictly after now, anywhere in the window
  const prev = [...events].reverse().find((e) => e.ms <= nowMs) ?? null
  const next = events.find((e) => e.ms > nowMs) ?? null

  if (!next) {
    // No future event in the window. Best we can do is report slack.
    return { state: 'slack', nextEvent: null, minutesToNext: 0 }
  }

  const minutesToNext = Math.round((next.ms - nowMs) / 60_000)
  const minutesSincePrev =
    prev != null ? Math.round((nowMs - prev.ms) / 60_000) : Number.POSITIVE_INFINITY

  if (minutesToNext <= 20 || minutesSincePrev <= 20) {
    return { state: 'slack', nextEvent: next.p, minutesToNext }
  }

  const state: TideState = next.p.type === 'H' ? 'rising' : 'falling'
  return { state, nextEvent: next.p, minutesToNext }
}
