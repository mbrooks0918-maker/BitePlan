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

// --- local cache (window.localStorage) -------------------------------------

type CacheEntry = {
  predictions: TidePrediction[]
  cachedAt: number // epoch ms
}

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
  const cached = readCache(key)
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
 * Classify the current tide.
 *
 * - Within 20 min of any hi/lo (just passed or imminent) → 'slack'
 * - Otherwise, the tide is moving toward the next event:
 *     next.type === 'H' → 'rising'
 *     next.type === 'L' → 'falling'
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

  const next = events.find((e) => e.ms > nowMs) ?? null
  if (!next) {
    return { state: 'slack', nextEvent: null, minutesToNext: 0 }
  }

  const minutesToNext = Math.round((next.ms - nowMs) / 60_000)

  const prev = [...events].reverse().find((e) => e.ms <= nowMs) ?? null
  const minutesSincePrev =
    prev != null ? Math.round((nowMs - prev.ms) / 60_000) : Number.POSITIVE_INFINITY

  if (minutesToNext <= 20 || minutesSincePrev <= 20) {
    return { state: 'slack', nextEvent: next.p, minutesToNext }
  }

  const state: TideState = next.p.type === 'H' ? 'rising' : 'falling'
  return { state, nextEvent: next.p, minutesToNext }
}
