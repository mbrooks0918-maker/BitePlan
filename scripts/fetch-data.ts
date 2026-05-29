/**
 * BitePlan habitat + depth data fetch.
 *
 * Pulls into public/data/:
 *   - seagrass.geojson      (FWC Seagrass Statewide, layer 15)
 *   - oysters.geojson       (FWC Oyster Beds Statewide, layer 17)
 *   - wetlands.geojson      (USFWS National Wetlands Inventory)
 *   - tide_stations.json    (the 9 NOAA stations listed in the handoff doc)
 *   - depth_grid.json       (Step 13.6 — NOAA NGDC DEM, ~500 m grid, MLLW-adjusted)
 *   - depth_contours.geojson(Step 13.6 — marching-squares contours at 2/4/6/10/15 ft)
 *
 * Each ArcGIS source is fetched with a bbox filter so we only keep features
 * inside the BitePlan coverage area (Mobile Bay → Port St. Joe).
 *
 * Wetlands is special: its WHERE clause filters across a server-side join to
 * the NWI codes table, which is slow on big areas. We split the bbox into a
 * grid of smaller tiles and query each one, so individual requests stay under
 * the per-request timeout.
 *
 * Depth is special: the spec originally listed GulfDataAtlas/EstuarineBathymetry_30m
 * but that service is decommissioned ("service not started"). We swap to
 * `DEM_mosaics/DEM_all/ImageServer` — the NOAA NGDC composite DEM that
 * blends 1/3 arc-sec NCEI tiles (Pensacola Bay area), 1-arc-sec Northern Gulf
 * Coast, and 1-arc-sec Coastal Relief Model. Vertical datum is NAVD 88
 * across all source DEMs, so we apply a fixed +0.5 ft panhandle offset to
 * approximate MLLW. Documented in code; replace with per-station tidal datum
 * conversion in a future step.
 *
 * Failure handling per the handoff doc:
 *   - per-request retry once on network error
 *   - if a source still fails, log clearly and write an empty FeatureCollection
 *     so the app can still load
 *   - one source failing does NOT abort the others
 *
 * Run with: npm run fetch-data
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromArrayBuffer } from 'geotiff'

// --- coverage area (handoff doc) -------------------------------------------

const BBOX = {
  west: -88.30,
  east: -85.20,
  south: 29.70,
  north: 30.80,
}

// --- output dir ------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, '..', 'public', 'data')

// --- source endpoints ------------------------------------------------------

// FWC Seagrass Statewide. The handoff doc links to the hub item; the
// underlying MapServer is layer 15 of the Open_Data/Seagrass_Statewide service.
const SEAGRASS_URL =
  'https://gis.myfwc.com/hosting/rest/services/Open_Data/Seagrass_Statewide/MapServer/15'

// FWC Oyster Beds Statewide (URL from the handoff doc verbatim).
const OYSTERS_URL =
  'https://gis.myfwc.com/hosting/rest/services/Open_Data/Oyster_Beds_Statewide/MapServer/17'

// USFWS National Wetlands Inventory. The handoff doc lists fws.gov as the
// host, but that returns 403; the actual public service is hosted at
// fwspublicservices.wim.usgs.gov.
const WETLANDS_URL =
  'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0'

// NOAA NGDC composite DEM (Step 13.6). The originally-specified service
// (GulfDataAtlas/EstuarineBathymetry_30m) has been decommissioned — empty
// folder + "service not started" on the named MapServer. The DEM_all
// ImageServer below blends multiple high-res DEMs and covers our full bbox.
const DEM_URL =
  'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_all/ImageServer'

// Depth fetch knobs.
const DEPTH_TILE_PX = 512                  // export request size per tile (~ServerImage max)
const DEPTH_GRID_M = 500                   // target output cell size in metres
const NAVD88_TO_MLLW_FT = 0.5              // panhandle approximation; varies by station
const CONTOUR_INTERVALS_FT = [2, 4, 6, 10, 15]
const M_PER_FT = 0.3048

// --- knobs -----------------------------------------------------------------

const PAGE_SIZE = 1000              // ArcGIS server max per page is usually 1000-2000
const REQUEST_TIMEOUT_MS = 90_000   // generous; wetlands joined queries are slow

// --- shared types ----------------------------------------------------------

type Feature = { type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }
type FeatureCollection = { type: 'FeatureCollection'; features: Feature[] }
const emptyFC = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] })

type Bbox = { west: number; east: number; south: number; north: number }

// --- helpers ---------------------------------------------------------------

// Hard-timeout fetch + JSON parse. Throws on timeout, non-2xx, or invalid JSON.
async function fetchJsonWithTimeout(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// One retry on transient failure before bubbling the error up.
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const msg = (e as Error).message
    console.warn(`  [${label}] first attempt failed (${msg}). Retrying once...`)
    await new Promise((r) => setTimeout(r, 1500))
    return await fn()
  }
}

// Split a bbox into a cols x rows grid of smaller bboxes.
function tileBbox(area: Bbox, cols: number, rows: number): Bbox[] {
  const dx = (area.east - area.west) / cols
  const dy = (area.north - area.south) / rows
  const tiles: Bbox[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        west: area.west + c * dx,
        east: area.west + (c + 1) * dx,
        south: area.south + r * dy,
        north: area.south + (r + 1) * dy,
      })
    }
  }
  return tiles
}

// Run one ArcGIS REST /query against a bbox, paginating until the server
// stops reporting "exceededTransferLimit" / returns a short page.
async function fetchPaged(
  baseUrl: string,
  area: Bbox,
  opts: { where?: string; outFields?: string } = {},
): Promise<Feature[]> {
  const where = opts.where ?? '1=1'
  const outFields = opts.outFields ?? '*'
  const all: Feature[] = []
  let offset = 0

  while (true) {
    const params = new URLSearchParams({
      geometry: `${area.west},${area.south},${area.east},${area.north}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      where,
      outFields,
      returnGeometry: 'true',
      outSR: '4326',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      f: 'geojson',
    })
    const url = `${baseUrl}/query?${params}`

    const data = await fetchJsonWithTimeout(url)
    if (data?.error) throw new Error(`server error: ${JSON.stringify(data.error)}`)

    const batch: Feature[] = Array.isArray(data?.features) ? data.features : []
    all.push(...batch)

    const more =
      data?.properties?.exceededTransferLimit === true ||
      data?.exceededTransferLimit === true ||
      batch.length === PAGE_SIZE

    if (!more || batch.length === 0) break
    offset += batch.length
  }

  return all
}

// Wrap an entire source so that if it explodes, we log + stub empty rather
// than aborting the script. Returns the FeatureCollection either way.
async function fetchSource(
  label: string,
  fn: () => Promise<FeatureCollection>,
): Promise<FeatureCollection> {
  console.log(`\n[${label}] starting...`)
  const t0 = Date.now()
  try {
    const fc = await fn()
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`[${label}] done — ${fc.features.length} features in ${secs}s`)
    return fc
  } catch (e) {
    console.error(
      `[${label}] FAILED — stubbing empty FeatureCollection. Error: ${(e as Error).message}`,
    )
    return emptyFC()
  }
}

async function writeJson(filename: string, body: unknown): Promise<number> {
  const path = resolve(DATA_DIR, filename)
  const text = JSON.stringify(body)
  await writeFile(path, text, 'utf8')
  return text.length
}

// --- depth raster fetch (Step 13.6) ---------------------------------------

/**
 * Convert NAVD88 elevation in meters → MLLW depth in feet.
 *
 *  - Elevation > 0    → above water; depth = -above-water → we clamp to 0.
 *  - Elevation < 0    → underwater; depth = |elevation_m| * 3.28084
 *  - + panhandle offset to roughly bring the value into MLLW (NAVD88 is
 *    ~0.5 ft below MLLW around Perdido / Pensacola — varies by station).
 *
 *  Returns NaN if the input is missing / sentinel.
 */
function navd88ToMllwDepthFt(elevMeters: number): number {
  if (!Number.isFinite(elevMeters) || elevMeters < -1e30) return NaN
  // Convert elevation to depth: depth = -elevation, then to feet.
  const depthFt = -elevMeters / M_PER_FT
  // Apply the panhandle NAVD88→MLLW offset. Documented approximation.
  return depthFt + NAVD88_TO_MLLW_FT
}

/**
 * Compute pixel dimensions for an export request that yields roughly
 * `cellSizeM` cells. Uses a simple cos-lat correction for longitude.
 */
function pxFor(bbox: Bbox, cellSizeM: number): { width: number; height: number } {
  const midLat = (bbox.north + bbox.south) / 2
  const dLatM = (bbox.north - bbox.south) * 111_000
  const dLonM = (bbox.east - bbox.west) * 111_000 * Math.cos((midLat * Math.PI) / 180)
  return {
    width: Math.max(1, Math.round(dLonM / cellSizeM)),
    height: Math.max(1, Math.round(dLatM / cellSizeM)),
  }
}

/**
 * Tile the bbox into pieces that, at our target grid resolution, fit under
 * DEPTH_TILE_PX × DEPTH_TILE_PX pixels per request. Returns one row-major
 * grid of metadata describing each tile + its pixel extents.
 */
function tileBboxForDem(bbox: Bbox, cellSizeM: number, maxPx: number): {
  tiles: { bbox: Bbox; width: number; height: number; row: number; col: number }[]
  cols: number
  rows: number
  totalWidth: number
  totalHeight: number
} {
  const total = pxFor(bbox, cellSizeM)
  const cols = Math.ceil(total.width / maxPx)
  const rows = Math.ceil(total.height / maxPx)
  const dLon = (bbox.east - bbox.west) / cols
  const dLat = (bbox.north - bbox.south) / rows
  const tiles = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tileBox: Bbox = {
        west: bbox.west + c * dLon,
        east: bbox.west + (c + 1) * dLon,
        south: bbox.north - (r + 1) * dLat, // row 0 = top
        north: bbox.north - r * dLat,
      }
      const px = pxFor(tileBox, cellSizeM)
      tiles.push({ bbox: tileBox, width: px.width, height: px.height, row: r, col: c })
    }
  }
  return { tiles, cols, rows, totalWidth: total.width, totalHeight: total.height }
}

/**
 * Fetch one tile of float32 elevation data from the NOAA DEM ImageServer.
 * Returns the raw Float32Array (length = width*height) and the served bbox.
 */
async function fetchDepthTile(
  bbox: Bbox,
  width: number,
  height: number,
): Promise<{ data: Float32Array; bbox: Bbox; width: number; height: number }> {
  const params = new URLSearchParams({
    bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    bboxSR: '4326',
    size: `${width},${height}`,
    imageSR: '4326',
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  })
  const url = `${DEM_URL}/exportImage?${params}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
    const img = await tiff.getImage()
    const rasters = await img.readRasters()
    const data = rasters[0] as Float32Array
    return { data, bbox, width: img.getWidth(), height: img.getHeight() }
  } finally {
    clearTimeout(timer)
  }
}

type DepthGrid = {
  version: 1
  source: string
  bbox: Bbox
  width: number
  height: number
  cellSizeM: number
  navd88ToMllwFt: number
  /** Row-major depths in feet (MLLW). NaN encoded as `null` so JSON parses
   *  cleanly. Cells above MLLW (i.e. land at low tide) have negative depth. */
  depthsFt: (number | null)[]
}

/**
 * Pull the full BitePlan bbox in tiles, stitch into one row-major grid, and
 * convert to MLLW-feet depth.
 */
async function fetchDepthGrid(bbox: Bbox): Promise<DepthGrid> {
  const plan = tileBboxForDem(bbox, DEPTH_GRID_M, DEPTH_TILE_PX)
  console.log(
    `  depth: ${plan.cols}×${plan.rows} tiles → ${plan.totalWidth}×${plan.totalHeight} px output`,
  )
  const W = plan.totalWidth
  const H = plan.totalHeight
  const depthsFt: (number | null)[] = new Array(W * H).fill(null)

  // Tiles are uniform-stride in pixel space; per-tile width/height carry the
  // exact pixel extent. We compute each tile's top-left pixel offset by
  // accumulating along its row + col.
  const tileWidths: number[] = []
  const tileHeights: number[] = []
  // First-row tile heights = each row's height (rows are evenly split)
  for (let c = 0; c < plan.cols; c++) tileWidths.push(plan.tiles[c].width)
  for (let r = 0; r < plan.rows; r++) tileHeights.push(plan.tiles[r * plan.cols].width === 0 ? 0 : plan.tiles[r * plan.cols].height)

  const xOffsets: number[] = [0]
  for (let c = 1; c < plan.cols; c++) xOffsets.push(xOffsets[c - 1] + tileWidths[c - 1])
  const yOffsets: number[] = [0]
  for (let r = 1; r < plan.rows; r++) yOffsets.push(yOffsets[r - 1] + tileHeights[r - 1])

  for (let i = 0; i < plan.tiles.length; i++) {
    const t = plan.tiles[i]
    const t0 = Date.now()
    try {
      const result = await withRetry(`depth tile ${i + 1}/${plan.tiles.length}`, () =>
        fetchDepthTile(t.bbox, t.width, t.height),
      )
      const px0 = xOffsets[t.col]
      const py0 = yOffsets[t.row]
      // Copy + convert. Image rows come top→bottom, matches our output grid.
      for (let y = 0; y < result.height; y++) {
        for (let x = 0; x < result.width; x++) {
          const v = result.data[y * result.width + x]
          const depthFt = navd88ToMllwDepthFt(v)
          const outIdx = (py0 + y) * W + (px0 + x)
          depthsFt[outIdx] = Number.isFinite(depthFt) ? Number(depthFt.toFixed(2)) : null
        }
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`  [depth tile ${i + 1}/${plan.tiles.length}] r${t.row}c${t.col} ${t.width}×${t.height} (${secs}s)`)
    } catch (e) {
      console.error(`  [depth tile ${i + 1}/${plan.tiles.length}] failed: ${(e as Error).message} — leaving cells null`)
    }
  }

  return {
    version: 1,
    source: DEM_URL,
    bbox,
    width: W,
    height: H,
    cellSizeM: DEPTH_GRID_M,
    navd88ToMllwFt: NAVD88_TO_MLLW_FT,
    depthsFt,
  }
}

// --- marching-squares contour extraction ---------------------------------

type ContourFeature = {
  type: 'Feature'
  properties: { depth_ft: number }
  geometry: { type: 'LineString'; coordinates: [number, number][] }
}

/**
 * Marching squares contour extractor. For each grid cell we look at the 4
 * corner depth values; if the iso-depth level crosses any of the cell's
 * edges, we emit short line segments connecting the crossing points. Then we
 * stitch coincident segment endpoints into longer LineStrings.
 *
 * Cells with any null corners are skipped (no data → no contour). The
 * stitching pass is O(segment count) using an endpoint-keyed hash map, so
 * even at our 500 m grid this finishes in under a second.
 */
function extractContours(grid: DepthGrid, intervals: number[]): ContourFeature[] {
  const features: ContourFeature[] = []
  const { width: W, height: H, depthsFt, bbox } = grid
  const dLon = (bbox.east - bbox.west) / W
  const dLat = (bbox.north - bbox.south) / H
  // Convert (col, row) pixel-centre to (lon, lat). Row 0 = top = north.
  const px2ll = (x: number, y: number): [number, number] => [
    bbox.west + (x + 0.5) * dLon,
    bbox.north - (y + 0.5) * dLat,
  ]

  for (const level of intervals) {
    type Seg = [[number, number], [number, number]]
    const segs: Seg[] = []
    for (let r = 0; r < H - 1; r++) {
      for (let c = 0; c < W - 1; c++) {
        const tl = depthsFt[r * W + c]
        const tr = depthsFt[r * W + c + 1]
        const bl = depthsFt[(r + 1) * W + c]
        const br = depthsFt[(r + 1) * W + c + 1]
        if (tl == null || tr == null || bl == null || br == null) continue

        // Lerp helper: where along an edge from a→b does the iso-value cross?
        const lerp = (a: number, b: number): number => {
          const denom = b - a
          if (Math.abs(denom) < 1e-9) return 0.5
          return (level - a) / denom
        }

        // Bit-pack which corners are below the level (1 = below)
        const code =
          (tl < level ? 1 : 0) |
          (tr < level ? 2 : 0) |
          (br < level ? 4 : 0) |
          (bl < level ? 8 : 0)
        if (code === 0 || code === 15) continue

        // Edge crossings: top, right, bottom, left
        // We compute interpolated pixel-fractional positions for each.
        const top: [number, number] = [c + lerp(tl, tr), r]
        const right: [number, number] = [c + 1, r + lerp(tr, br)]
        const bot: [number, number] = [c + lerp(bl, br), r + 1]
        const left: [number, number] = [c, r + lerp(tl, bl)]

        // Marching-squares case table — emit 1 or 2 segments per cell. We
        // pick the "all crossings = isoline" pattern for ambiguous saddles.
        switch (code) {
          case 1: case 14: segs.push([left, top]); break
          case 2: case 13: segs.push([top, right]); break
          case 3: case 12: segs.push([left, right]); break
          case 4: case 11: segs.push([right, bot]); break
          case 5:          segs.push([left, top]); segs.push([right, bot]); break
          case 6: case 9:  segs.push([top, bot]); break
          case 7: case 8:  segs.push([left, bot]); break
          case 10:         segs.push([left, bot]); segs.push([top, right]); break
        }
      }
    }

    // Stitch segments into LineStrings. Hash endpoints by quantized
    // pixel-fractional coords so coincident points join cleanly.
    const key = (p: [number, number]) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`
    const adj = new Map<string, Seg[]>()
    for (const s of segs) {
      const ka = key(s[0])
      const kb = key(s[1])
      if (!adj.has(ka)) adj.set(ka, [])
      if (!adj.has(kb)) adj.set(kb, [])
      adj.get(ka)!.push(s)
      adj.get(kb)!.push(s)
    }
    const visited = new Set<Seg>()
    const linesPx: [number, number][][] = []
    for (const start of segs) {
      if (visited.has(start)) continue
      visited.add(start)
      const line: [number, number][] = [start[0], start[1]]
      // Walk forward.
      let tail: [number, number] = start[1]
      while (true) {
        const k = key(tail)
        const cands = adj.get(k) ?? []
        const next = cands.find((c) => !visited.has(c))
        if (!next) break
        visited.add(next)
        const other = key(next[0]) === k ? next[1] : next[0]
        line.push(other)
        tail = other
      }
      // Walk backward.
      let head: [number, number] = start[0]
      while (true) {
        const k = key(head)
        const cands = adj.get(k) ?? []
        const next = cands.find((c) => !visited.has(c))
        if (!next) break
        visited.add(next)
        const other = key(next[0]) === k ? next[1] : next[0]
        line.unshift(other)
        head = other
      }
      if (line.length >= 2) linesPx.push(line)
    }

    for (const line of linesPx) {
      const coords: [number, number][] = line.map(([x, y]) => px2ll(x, y))
      features.push({
        type: 'Feature',
        properties: { depth_ft: level },
        geometry: { type: 'LineString', coordinates: coords },
      })
    }
  }
  return features
}

// --- tide stations (static metadata from handoff doc) ---------------------

const TIDE_STATIONS = [
  { id: '8735180', name: 'Dauphin Island, AL',          lat: 30.250, lon: -88.075 },
  { id: '8737048', name: 'Mobile State Docks, AL',      lat: 30.708, lon: -88.043 },
  { id: '8736897', name: 'Bon Secour, AL',              lat: 30.328, lon: -87.730 },
  { id: '8729962', name: 'Nix Point, Perdido Bay, FL',  lat: 30.413, lon: -87.448 },
  { id: '8729840', name: 'Pensacola, FL',               lat: 30.404, lon: -87.211 },
  { id: '8729214', name: 'Navarre Beach, FL',           lat: 30.376, lon: -86.866 },
  { id: '8729108', name: 'Destin, FL',                  lat: 30.393, lon: -86.514 },
  { id: '8729108', name: 'Panama City, FL',             lat: 30.152, lon: -85.667 },
  { id: '8728690', name: 'Apalachicola, FL',            lat: 29.727, lon: -84.981 },
]

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })

  console.log('BitePlan habitat fetch')
  console.log(`Bbox: W ${BBOX.west}, E ${BBOX.east}, S ${BBOX.south}, N ${BBOX.north}`)

  // ---- FWC seagrass ----
  // Bbox-only paginated query. Bbox filter alone is fast on this layer.
  const seagrass = await fetchSource('seagrass', async () => {
    const features = await withRetry('seagrass', () => fetchPaged(SEAGRASS_URL, BBOX))
    return { type: 'FeatureCollection', features }
  })

  // ---- FWC oysters ----
  const oysters = await fetchSource('oysters', async () => {
    const features = await withRetry('oysters', () => fetchPaged(OYSTERS_URL, BBOX))
    return { type: 'FeatureCollection', features }
  })

  // ---- USFWS wetlands ----
  // Filter to estuarine/marine wetland types per the handoff doc. The WHERE
  // operates across a server-side join to a code table, so we tile the bbox
  // into smaller pieces (each request returns within the timeout) and limit
  // outFields to keep payload manageable.
  const wetlands = await fetchSource('wetlands', async () => {
    const where =
      "Wetlands.WETLAND_TYPE IN ('Estuarine and Marine Wetland','Estuarine and Marine Deepwater')"
    const outFields = 'Wetlands.OBJECTID,Wetlands.WETLAND_TYPE,Wetlands.ATTRIBUTE,Wetlands.ACRES'
    const tiles = tileBbox(BBOX, 4, 2)
    console.log(`  splitting bbox into ${tiles.length} tiles for the slow joined WHERE...`)

    const all: Feature[] = []
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i]
      const label = `wetlands tile ${i + 1}/${tiles.length}`
      const t0 = Date.now()
      try {
        const features = await withRetry(label, () =>
          fetchPaged(WETLANDS_URL, t, { where, outFields }),
        )
        const secs = ((Date.now() - t0) / 1000).toFixed(1)
        console.log(`  [${label}] +${features.length} features (${secs}s)`)
        all.push(...features)
      } catch (e) {
        // Skip just this tile; don't fail the whole source.
        console.error(`  [${label}] failed after retry: ${(e as Error).message} — skipping tile`)
      }
    }

    return { type: 'FeatureCollection', features: all }
  })

  // ---- NOAA NGDC composite DEM → depth grid + contours ----
  const depthGrid = await fetchSource('depth', async () => {
    const grid = await fetchDepthGrid(BBOX)
    // Coverage stats
    let valid = 0
    for (const v of grid.depthsFt) if (v != null) valid++
    const coveragePct = ((valid / grid.depthsFt.length) * 100).toFixed(1)
    console.log(
      `  depth grid: ${valid.toLocaleString('en-US')} valid cells / ${grid.depthsFt.length.toLocaleString('en-US')} (${coveragePct}% coverage)`,
    )
    // Re-cast as a FeatureCollection so fetchSource's typed wrapper can hand
    // it back. We'll re-extract the real DepthGrid below.
    ;(grid as unknown as { features: unknown[] }).features = grid.depthsFt as unknown as unknown[]
    return grid as unknown as FeatureCollection
  })
  // Unwrap back to the original DepthGrid shape
  const depthGridReal = depthGrid as unknown as DepthGrid & { features?: unknown }
  if (depthGridReal.features) delete depthGridReal.features

  // Marching squares on the loaded grid. Skip when fetch failed entirely.
  const contoursFc = await fetchSource('depth contours', async () => {
    if (!depthGridReal.depthsFt || depthGridReal.depthsFt.every((v) => v == null)) {
      throw new Error('no depth data — skipping contour extraction')
    }
    const t0 = Date.now()
    const features = extractContours(depthGridReal, CONTOUR_INTERVALS_FT)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(
      `  contours: ${features.length} LineStrings extracted in ${secs}s (intervals: ${CONTOUR_INTERVALS_FT.join(', ')} ft)`,
    )
    return { type: 'FeatureCollection', features: features as unknown as Feature[] }
  })

  // ---- write everything ----
  console.log('\nWriting files...')
  const sgBytes = await writeJson('seagrass.geojson', seagrass)
  const oyBytes = await writeJson('oysters.geojson', oysters)
  const wtBytes = await writeJson('wetlands.geojson', wetlands)
  const tsBytes = await writeJson('tide_stations.json', TIDE_STATIONS)
  const dgBytes = await writeJson('depth_grid.json', depthGridReal)
  const ctBytes = await writeJson('depth_contours.geojson', contoursFc)

  const fmt = (n: number) => n.toLocaleString('en-US')
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`
  const size = (n: number) => (n >= 1024 * 1024 ? mb(n) : kb(n))

  console.log('\nSummary:')
  console.log(`  seagrass.geojson         ${fmt(seagrass.features.length).padStart(7)} features    ${size(sgBytes)}`)
  console.log(`  oysters.geojson          ${fmt(oysters.features.length).padStart(7)} features    ${size(oyBytes)}`)
  console.log(`  wetlands.geojson         ${fmt(wetlands.features.length).padStart(7)} features    ${size(wtBytes)}`)
  console.log(`  tide_stations.json       ${TIDE_STATIONS.length.toString().padStart(7)} stations    ${size(tsBytes)}`)
  console.log(`  depth_grid.json          ${fmt(depthGridReal.width ?? 0)} × ${fmt(depthGridReal.height ?? 0)} cells    ${size(dgBytes)}`)
  console.log(`  depth_contours.geojson   ${fmt(contoursFc.features.length).padStart(7)} lines       ${size(ctBytes)}`)
}

main().catch((e) => {
  console.error('fetch-data crashed unexpectedly:', e)
  process.exitCode = 1
})
