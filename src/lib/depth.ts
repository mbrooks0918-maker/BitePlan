/**
 * BitePlan depth lookup (Step 13.6).
 *
 * Loads the `public/data/depth_grid.json` produced by the fetch script and
 * exposes two helpers used by the scoring engine:
 *
 *   - `getDepthAtMLLW(lat, lon)`    chart depth at MLLW (ft); null outside coverage
 *   - `getCurrentDepth(lat, lon, tideLevelAboveMLLWFt)`  actual depth right now
 *
 * The grid is row-major from top-left (north-west). Cell size is 500 m
 * across the BitePlan bbox (-88.30, -85.20, 29.70, 30.80) — see the fetch
 * script for the exact extents.
 *
 * Depth values are MLLW-adjusted (NAVD88 + ~0.5 ft panhandle offset, applied
 * at fetch time). Positive = below water at MLLW, negative = land above
 * MLLW at low tide (still potentially fishable at high tide depending on
 * the current tide level).
 *
 * Loaded once per worker session; subsequent calls are O(1) array lookups.
 */

export type DepthGrid = {
  version: 1
  source: string
  bbox: { west: number; east: number; south: number; north: number }
  width: number
  height: number
  cellSizeM: number
  navd88ToMllwFt: number
  /** Row-major depths in feet (MLLW). null for cells outside coverage. */
  depthsFt: (number | null)[]
}

let grid: DepthGrid | null = null
let loadPromise: Promise<void> | null = null

/**
 * Idempotent grid load. Concurrent callers share the same in-flight promise.
 * Logs but does not throw on fetch failure — the depth filter degrades to
 * "no filtering" (every lookup returns null).
 */
export async function initDepthGrid(): Promise<void> {
  if (grid) return
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    try {
      const res = await fetch('/data/depth_grid.json')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const parsed = (await res.json()) as DepthGrid
      if (parsed.version !== 1 || !parsed.width || !parsed.height) {
        throw new Error('depth_grid.json shape unexpected')
      }
      grid = parsed
      console.info(
        `[depth] grid loaded: ${grid.width} × ${grid.height} cells (cellSizeM=${grid.cellSizeM}, navd88ToMllwFt=${grid.navd88ToMllwFt})`,
      )
    } catch (e) {
      console.warn('[depth] grid load failed; lookups will return null:', e)
      grid = null
    }
  })()
  return loadPromise
}

export function isDepthGridReady(): boolean {
  return grid != null
}

export function getDepthGrid(): DepthGrid | null {
  return grid
}

/**
 * Convert lat/lon to (col, row) grid indices. Returns null if the point lies
 * outside the grid's bbox. Row 0 is the northmost row.
 */
function gridIndex(lat: number, lon: number): { col: number; row: number } | null {
  if (!grid) return null
  const { bbox, width, height } = grid
  if (lon < bbox.west || lon >= bbox.east) return null
  if (lat < bbox.south || lat >= bbox.north) return null
  const dLon = (bbox.east - bbox.west) / width
  const dLat = (bbox.north - bbox.south) / height
  const col = Math.floor((lon - bbox.west) / dLon)
  const row = Math.floor((bbox.north - lat) / dLat)
  if (col < 0 || col >= width) return null
  if (row < 0 || row >= height) return null
  return { col, row }
}

/**
 * Look up chart depth at MLLW (ft) for a given lat/lon. Returns null when:
 *  - the grid hasn't loaded
 *  - the point is outside the grid's bbox
 *  - the source DEM had no value at that cell (no-data hole)
 *
 * Land above MLLW reads as a negative value (e.g. -2 ft = 2 ft above MLLW),
 * NOT null — callers that want "is it water at MLLW" should check `>= 0`.
 */
export function getDepthAtMLLW(lat: number, lon: number): number | null {
  if (!grid) return null
  const idx = gridIndex(lat, lon)
  if (!idx) return null
  const v = grid.depthsFt[idx.row * grid.width + idx.col]
  return v == null ? null : v
}

/**
 * Actual water depth (ft) right now = chart depth at MLLW + current tide
 * level above MLLW. Returns null when chart depth is unknown; clamps the
 * minimum at 0 (negative means the cell is dry).
 */
export function getCurrentDepth(
  lat: number,
  lon: number,
  tideLevelAboveMLLWFt: number,
): number | null {
  const mllw = getDepthAtMLLW(lat, lon)
  if (mllw == null) return null
  const current = mllw + tideLevelAboveMLLWFt
  return Math.max(0, current)
}

/**
 * Step 13.6 depth_break detection helper — samples the grid at four
 * cardinal points `offsetM` away from a centre lat/lon and returns the
 * maximum |centre − sample| difference. Returns 0 when the centre or any
 * sample is missing.
 */
export function depthGradientFt(lat: number, lon: number, offsetM: number): {
  centerDepth: number | null
  maxDiff: number
  samples: (number | null)[]
} {
  const centerDepth = getDepthAtMLLW(lat, lon)
  if (centerDepth == null) return { centerDepth: null, maxDiff: 0, samples: [] }
  const dLat = offsetM / 111_000
  const dLon = offsetM / (111_000 * Math.cos((lat * Math.PI) / 180))
  const samples = [
    getDepthAtMLLW(lat + dLat, lon),      // N
    getDepthAtMLLW(lat - dLat, lon),      // S
    getDepthAtMLLW(lat, lon + dLon),      // E
    getDepthAtMLLW(lat, lon - dLon),      // W
  ]
  let maxDiff = 0
  for (const s of samples) {
    if (s == null) continue
    const d = Math.abs(s - centerDepth)
    if (d > maxDiff) maxDiff = d
  }
  return { centerDepth, maxDiff, samples }
}
