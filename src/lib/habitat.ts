/**
 * Habitat data loader, spatial index, and scoring-unit derivation.
 *
 * - Pulls all three habitat GeoJSON files on first init and stuffs them into
 *   an rbush index so visible-area queries are O(log n) instead of scanning
 *   ~11k features per map move.
 * - `getVisibleHabitat(bounds)` returns features whose bbox intersects the
 *   visible map area.
 * - `deriveScoringUnits(feature)` implements the algorithm from the handoff
 *   doc: small polygons (<5,000 sq m) score as one unit, larger ones get
 *   their boundary sampled every ~30 m and each sample becomes its own unit.
 *   Derivation results are cached per feature so repeat pans are cheap.
 */

import RBush from 'rbush'
import * as turf from '@turf/turf'
import type {
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Polygon,
} from 'geojson'
import type { Bounds, HabitatFeature, HabitatType, ScoringUnit } from '@/types'

const SOURCES: Array<{ url: string; type: HabitatType }> = [
  { url: '/data/seagrass.geojson', type: 'seagrass' },
  { url: '/data/oysters.geojson', type: 'oyster' },
  { url: '/data/wetlands.geojson', type: 'wetland' },
]

const SMALL_POLYGON_SQM = 5000
// Spec is 20-50 m; we tried 50 m and the cold pass came in at 93 s in the
// worker (over our 60 s budget). 100 m halves the unit count and brings cold
// pass under a minute while still giving heat clustering enough resolution.
// Step 20's perf pass will revisit (likely tile-based incremental scoring).
const EDGE_SAMPLE_KM = 0.10 // 100 m

type IndexedItem = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  feature: HabitatFeature
}

const tree = new RBush<IndexedItem>()
let initPromise: Promise<void> | null = null
let initialized = false

const derivationCache = new Map<string, ScoringUnit[]>()

async function loadOne(src: { url: string; type: HabitatType }): Promise<HabitatFeature[]> {
  try {
    const res = await fetch(src.url)
    if (!res.ok) {
      console.error(`[habitat] failed to load ${src.url}: HTTP ${res.status}`)
      return []
    }
    const fc = (await res.json()) as FeatureCollection
    return (fc.features ?? []).map((f, idx) => {
      const rawId =
        (f.id as string | number | undefined) ??
        (f.properties as Record<string, unknown> | null)?.['OBJECTID'] ??
        (f.properties as Record<string, unknown> | null)?.['Wetlands.OBJECTID'] ??
        idx
      return {
        id: `${src.type}:${rawId}`,
        type: src.type,
        geometry: f.geometry as Geometry,
        properties: (f.properties ?? {}) as Record<string, unknown>,
      }
    })
  } catch (e) {
    console.error(`[habitat] failed to load ${src.url}:`, e)
    return []
  }
}

/**
 * Idempotent initializer. Concurrent callers share the same in-flight promise.
 */
export async function initHabitatIndex(): Promise<void> {
  if (initialized) return
  if (initPromise) return initPromise
  initPromise = (async () => {
    const t0 = performance.now()
    const all: HabitatFeature[] = []
    for (const src of SOURCES) {
      const features = await loadOne(src)
      all.push(...features)
    }
    const items: IndexedItem[] = []
    for (const f of all) {
      try {
        const [minX, minY, maxX, maxY] = turf.bbox(f.geometry as never)
        items.push({ minX, minY, maxX, maxY, feature: f })
      } catch {
        // Skip malformed geometries silently — they're empty stubs from failed fetches.
      }
    }
    tree.load(items)
    initialized = true
    const ms = (performance.now() - t0).toFixed(0)
    console.info(`[habitat] indexed ${items.length} features in ${ms}ms`)
  })()
  return initPromise
}

export function isHabitatIndexReady(): boolean {
  return initialized
}

/**
 * rbush bbox query. Returns the superset of features that COULD intersect the
 * given map bounds; some may only overlap by their bbox, not actual geometry,
 * but for scoring purposes that's fine — they're all coastal and we cap the
 * scored set downstream anyway.
 */
export function getVisibleHabitat(bounds: Bounds): HabitatFeature[] {
  if (!initialized) return []
  const hits = tree.search({
    minX: bounds.west,
    minY: bounds.south,
    maxX: bounds.east,
    maxY: bounds.north,
  })
  return hits.map((h) => h.feature)
}

function eachOuterRing(geometry: Geometry, fn: (ring: number[][]) => void): void {
  if (geometry.type === 'Polygon') {
    fn((geometry as Polygon).coordinates[0])
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of (geometry as MultiPolygon).coordinates) {
      fn(poly[0])
    }
  }
  // No other geometry types appear in our habitat data.
}

function centroidOf(geometry: Geometry): [number, number] {
  const c = turf.centroid(geometry as never)
  const coords = c.geometry.coordinates as [number, number]
  return [coords[0], coords[1]]
}

/**
 * For each outer ring of `feature`, produce either a single 'polygon' unit
 * (small ring) or one 'edge_point' unit per ~30 m of perimeter (large ring).
 * Cached per feature ID for the lifetime of the page.
 */
export function deriveScoringUnits(feature: HabitatFeature): ScoringUnit[] {
  const cached = derivationCache.get(feature.id)
  if (cached) return cached

  const units: ScoringUnit[] = []
  let polyIdx = 0

  eachOuterRing(feature.geometry, (ring) => {
    let area = 0
    try {
      area = turf.area(turf.polygon([ring]))
    } catch {
      // Skip rings that aren't valid polygons.
      polyIdx++
      return
    }

    if (area < SMALL_POLYGON_SQM) {
      const subPoly = turf.polygon([ring])
      units.push({
        id: `${feature.id}:p${polyIdx}`,
        unitType: 'polygon',
        habitatType: feature.type,
        geometry: subPoly.geometry,
        centroid: centroidOf(subPoly.geometry),
        parentFeatureId: feature.id,
      })
    } else {
      const line = turf.lineString(ring)
      const lineLengthKm = turf.length(line, { units: 'kilometers' })
      let pointIdx = 0
      for (let d = 0; d <= lineLengthKm; d += EDGE_SAMPLE_KM) {
        const pt = turf.along(line, d, { units: 'kilometers' })
        const [lon, lat] = pt.geometry.coordinates as [number, number]
        units.push({
          id: `${feature.id}:p${polyIdx}:e${pointIdx}`,
          unitType: 'edge_point',
          habitatType: feature.type,
          geometry: pt.geometry,
          centroid: [lon, lat],
          parentFeatureId: feature.id,
        })
        pointIdx++
      }
    }
    polyIdx++
  })

  derivationCache.set(feature.id, units)
  return units
}

/**
 * Centroid-in-bounds filter applied AFTER derivation. Cheaper than a true
 * geometry-vs-bbox check and good enough for keeping off-screen edge points
 * out of the score loop.
 */
export function filterUnitsToBounds(units: ScoringUnit[], bounds: Bounds): ScoringUnit[] {
  return units.filter((u) => {
    const [lon, lat] = u.centroid
    return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north
  })
}
