/**
 * BitePlan habitat data fetch.
 *
 * Pulls four files into public/data/:
 *   - seagrass.geojson   (FWC Seagrass Statewide, layer 15)
 *   - oysters.geojson    (FWC Oyster Beds Statewide, layer 17)
 *   - wetlands.geojson   (USFWS National Wetlands Inventory, estuarine + marine only)
 *   - tide_stations.json (the 9 NOAA stations listed in the handoff doc)
 *
 * Each ArcGIS source is fetched with a bbox filter so we only keep features
 * inside the BitePlan coverage area (Mobile Bay → Port St. Joe).
 *
 * Wetlands is special: its WHERE clause filters across a server-side join to
 * the NWI codes table, which is slow on big areas. We split the bbox into a
 * grid of smaller tiles and query each one, so individual requests stay under
 * the per-request timeout.
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

  // ---- write everything ----
  console.log('\nWriting files...')
  const sgBytes = await writeJson('seagrass.geojson', seagrass)
  const oyBytes = await writeJson('oysters.geojson', oysters)
  const wtBytes = await writeJson('wetlands.geojson', wetlands)
  const tsBytes = await writeJson('tide_stations.json', TIDE_STATIONS)

  const fmt = (n: number) => n.toLocaleString('en-US')
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`
  const size = (n: number) => (n >= 1024 * 1024 ? mb(n) : kb(n))

  console.log('\nSummary:')
  console.log(`  seagrass.geojson      ${fmt(seagrass.features.length).padStart(7)} features    ${size(sgBytes)}`)
  console.log(`  oysters.geojson       ${fmt(oysters.features.length).padStart(7)} features    ${size(oyBytes)}`)
  console.log(`  wetlands.geojson      ${fmt(wetlands.features.length).padStart(7)} features    ${size(wtBytes)}`)
  console.log(`  tide_stations.json    ${TIDE_STATIONS.length.toString().padStart(7)} stations    ${size(tsBytes)}`)
}

main().catch((e) => {
  console.error('fetch-data crashed unexpectedly:', e)
  process.exitCode = 1
})
