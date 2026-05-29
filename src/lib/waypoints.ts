/**
 * Step 14 — saved-waypoint persistence.
 *
 * Per the handoff doc's storage-key map, each waypoint lives under
 * `waypoints:{uuid}` in `window.localStorage`. One entry per waypoint so
 * listing, renaming, and deletion all stay O(1) per operation without
 * needing a separate index.
 *
 * On app boot the store calls `listAllWaypoints()` to hydrate its in-memory
 * mirror; from then on the store is the source of truth and persistence is
 * a write-through side-effect.
 */

import type { Waypoint } from '@/types'

const KEY_PREFIX = 'waypoints:'

function makeKey(id: string): string {
  return `${KEY_PREFIX}${id}`
}

/**
 * Enumerate every persisted waypoint. Returns them in ascending createdAt
 * order so map rendering and any future "saved list" UI have a stable
 * order without re-sorting per render.
 */
export function listAllWaypoints(): Waypoint[] {
  const out: Waypoint[] = []
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (!key || !key.startsWith(KEY_PREFIX)) continue
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw) as Waypoint
        // Minimal shape guard — protects against half-written entries from
        // a partial test or old format. Drop silently rather than crash.
        if (
          typeof parsed?.id === 'string' &&
          typeof parsed?.lat === 'number' &&
          typeof parsed?.lon === 'number' &&
          typeof parsed?.label === 'string'
        ) {
          out.push(parsed)
        }
      } catch {
        // skip malformed entry
      }
    }
  } catch (e) {
    console.warn('[waypoints] enumerate failed:', e)
  }
  out.sort((a, b) => a.createdAt - b.createdAt)
  return out
}

/** Write-through persist for one waypoint. Non-throwing — logs and moves on. */
export function persistWaypoint(w: Waypoint): void {
  try {
    window.localStorage.setItem(makeKey(w.id), JSON.stringify(w))
  } catch (e) {
    console.warn(`[waypoints] persist ${w.id} failed:`, e)
  }
}

/** Remove one waypoint from storage. Non-throwing. */
export function removeWaypoint(id: string): void {
  try {
    window.localStorage.removeItem(makeKey(id))
  } catch (e) {
    console.warn(`[waypoints] remove ${id} failed:`, e)
  }
}

/**
 * Generate a fresh UUID for a new waypoint. Uses crypto.randomUUID() which
 * is available in all modern browsers + Node 19+ — no need to ship a
 * polyfill given our target environment.
 */
export function newWaypointId(): string {
  return crypto.randomUUID()
}
