/**
 * Convergence detection (Step 12.5).
 *
 * Implements the "convergence over coverage" scoring philosophy: structural
 * features (points/spits, creek mouths, habitat transitions) are detected
 * from habitat geometry ONCE at index time and attached to each scoring
 * unit. Without at least one of these tags, the scoring engine caps the
 * unit at driveby tier no matter how good the conditions look.
 *
 * Detection is intentionally one-shot and front-loaded: it can spend tens of
 * seconds during the cold pass, because every subsequent recompute reads
 * pre-tagged units in microseconds.
 */

import RBush from 'rbush'
import type { Geometry, MultiPolygon, Polygon } from 'geojson'
import type { ConvergenceTag, HabitatFeature, HabitatType } from '@/types'

// ---- detection knobs -----------------------------------------------------

// Point / spit detection — tuned tighter after the first pass tagged most
// coastline as a point. Real fishery points are sharp inflections, not
// every gentle bend.
const POINT_MIN_EDGE_M = 40            // skip jitter edges shorter than this
const POINT_WEAK_TURN_DEG = 45         // left turn ≥ 45° (interior < 135°)
const POINT_MODERATE_TURN_DEG = 75     // left turn ≥ 75° (interior < 105°)
const POINT_STRONG_TURN_DEG = 105      // left turn ≥ 105° (interior < 75°)
const POINT_TAG_RADIUS_M = 25

// Creek / drainage mouth detection (wetland-only) — tighter so we get
// actual narrow drainages, not soft inlets.
const CREEK_PINCH_M = 45               // pinch width threshold
const CREEK_MIN_BOUNDARY_GAP = 12      // vertices apart along the ring
const CREEK_MAX_RING_VERTICES = 400    // skip giant rings to keep it fast
const CREEK_TAG_RADIUS_M = 25
// Pinch-width thresholds for creek-mouth strength (anything ≤ STRONG_M is
// strong, ≤ MODERATE_M is moderate, otherwise weak up to CREEK_PINCH_M).
const CREEK_MODERATE_M = 25
const CREEK_STRONG_M = 12

// Habitat transition detection (cross-habitat adjacency). Initial 50 m and
// then 12 m both tagged almost every coastal unit as a transition because
// Perdido Bay habitats overlap densely. 5 m means the other habitat's
// edge is essentially overlapping the queried unit's centroid — a true
// seam, not just neighborhood adjacency.
const TRANSITION_RADIUS_M = 5

// ---- conversions ---------------------------------------------------------

const DEG_PER_M_LAT = 1 / 111_000

function degPerMeterLon(latDeg: number): number {
  return 1 / (111_000 * Math.cos((latDeg * Math.PI) / 180))
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const la1 = toRad(a[1])
  const la2 = toRad(b[1])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

// ---- detection types -----------------------------------------------------

type DetectedPoint = { lon: number; lat: number; strength: 'weak' | 'moderate' | 'strong'; habitatType: HabitatType }
type DetectedMouth = { lon: number; lat: number; strength: 'weak' | 'moderate' | 'strong'; widthM: number }

type IndexedPoint = { minX: number; minY: number; maxX: number; maxY: number; tag: DetectedPoint }
type IndexedMouth = { minX: number; minY: number; maxX: number; maxY: number; tag: DetectedMouth }

// ---- detection helpers ---------------------------------------------------

function eachOuterRing(geom: Geometry, fn: (ring: number[][]) => void): void {
  if (geom.type === 'Polygon') fn((geom as Polygon).coordinates[0])
  else if (geom.type === 'MultiPolygon') {
    for (const poly of (geom as MultiPolygon).coordinates) fn(poly[0])
  }
}

/**
 * Walk a CCW outer ring and emit one detected point per significant convex
 * (left-turn) inflection. The vertex location IS the detected point.
 *
 * Math note: GeoJSON outer rings are CCW. At a convex inflection (the polygon
 * "sticking out"), the turn angle from edge-A to edge-B is a POSITIVE left
 * turn. Larger left turns = sharper points. We skip edges shorter than
 * POINT_MIN_EDGE_M so digitization jitter doesn't get tagged.
 */
function detectPointsOnRing(ring: number[][], habitatType: HabitatType): DetectedPoint[] {
  const out: DetectedPoint[] = []
  const n = ring.length - 1 // closed ring duplicates first point
  if (n < 4) return out

  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n]
    const curr = ring[i]
    const next = ring[(i + 1) % n]

    const dA = haversineMeters(prev as [number, number], curr as [number, number])
    const dB = haversineMeters(curr as [number, number], next as [number, number])
    if (dA < POINT_MIN_EDGE_M || dB < POINT_MIN_EDGE_M) continue

    // Edge vectors in degree-space — fine for angle math since both are local.
    const ax = curr[0] - prev[0]
    const ay = curr[1] - prev[1]
    const bx = next[0] - curr[0]
    const by = next[1] - curr[1]

    const cross = ax * by - ay * bx
    const dot = ax * bx + ay * by
    // atan2(cross, dot) ∈ [-π, π]. Positive ⇒ left turn (convex on CCW ring).
    const turnRad = Math.atan2(cross, dot)
    const turnDeg = (turnRad * 180) / Math.PI

    if (turnDeg < POINT_WEAK_TURN_DEG) continue

    const strength =
      turnDeg >= POINT_STRONG_TURN_DEG
        ? 'strong'
        : turnDeg >= POINT_MODERATE_TURN_DEG
          ? 'moderate'
          : 'weak'

    out.push({ lon: curr[0], lat: curr[1], strength, habitatType })
  }
  return out
}

/**
 * Find narrow pinch points on a wetland polygon's outer ring — locations
 * where the ring nearly touches itself. These are the fishery-relevant
 * "creek mouths" / drainage mouths: where a wetland necks down before
 * opening into the bay.
 *
 * Approach: for each ring vertex, find a non-adjacent vertex within
 * CREEK_PINCH_M meters. If the two are far apart along the boundary but
 * close in space, the gap between them is a pinch. The midpoint is the
 * tagged mouth location, and the gap width controls strength.
 *
 * Uses an rbush within the ring to avoid O(n²) on long rings. Still skipped
 * entirely if the ring is bigger than CREEK_MAX_RING_VERTICES.
 */
function detectCreekMouthsOnRing(ring: number[][]): DetectedMouth[] {
  const out: DetectedMouth[] = []
  const n = ring.length - 1
  if (n > CREEK_MAX_RING_VERTICES) return out
  if (n < 12) return out

  // Build a small rbush over the ring's vertices for fast spatial lookups.
  const tree = new RBush<{ minX: number; minY: number; maxX: number; maxY: number; i: number }>()
  // Approximate the pinch radius in degrees at this latitude.
  const sampleLat = ring[0][1]
  const dLat = CREEK_PINCH_M * DEG_PER_M_LAT
  const dLon = CREEK_PINCH_M * degPerMeterLon(sampleLat)
  tree.load(
    ring.slice(0, n).map((p, idx) => ({
      minX: p[0], maxX: p[0], minY: p[1], maxY: p[1], i: idx,
    })),
  )

  // Track seen mouths so we don't emit duplicates from both ends of a pinch.
  const seen = new Set<string>()

  for (let i = 0; i < n; i++) {
    const v = ring[i]
    const hits = tree.search({
      minX: v[0] - dLon, maxX: v[0] + dLon,
      minY: v[1] - dLat, maxY: v[1] + dLat,
    })
    for (const h of hits) {
      const j = h.i
      // Require a meaningful boundary gap and a unique pair.
      const gap = Math.min(Math.abs(i - j), n - Math.abs(i - j))
      if (gap < CREEK_MIN_BOUNDARY_GAP) continue
      const pairKey = i < j ? `${i}-${j}` : `${j}-${i}`
      if (seen.has(pairKey)) continue
      seen.add(pairKey)

      const widthM = haversineMeters(v as [number, number], ring[j] as [number, number])
      if (widthM > CREEK_PINCH_M) continue

      const midLon = (v[0] + ring[j][0]) / 2
      const midLat = (v[1] + ring[j][1]) / 2
      const strength: 'weak' | 'moderate' | 'strong' =
        widthM <= CREEK_STRONG_M ? 'strong' : widthM <= CREEK_MODERATE_M ? 'moderate' : 'weak'

      out.push({ lon: midLon, lat: midLat, strength, widthM })
    }
  }
  return out
}

// ---- public detection entrypoint -----------------------------------------

/**
 * Inputs: the loaded habitat features. Builds detection indices for point
 * tags and creek-mouth tags. Returns a tagger function that, given a unit's
 * centroid + habitat type + a habitat-tree querier, returns the list of
 * convergence tags applicable at that point.
 */
export type HabitatTreeQuery = (
  centroid: [number, number],
  radiusM: number,
  excludeType: HabitatType,
) => HabitatType[]

export type ConvergenceContext = {
  pointStats: { features: number; tags: number }
  mouthStats: { features: number; tags: number }
  tagUnit: (
    centroid: [number, number],
    habitatType: HabitatType,
    query: HabitatTreeQuery,
  ) => ConvergenceTag[]
}

export function buildConvergenceContext(features: HabitatFeature[]): ConvergenceContext {
  const pointTree = new RBush<IndexedPoint>()
  const mouthTree = new RBush<IndexedMouth>()

  let pointCount = 0
  let pointFeatures = 0
  let mouthCount = 0
  let mouthFeatures = 0

  for (const f of features) {
    let foundPoint = false
    let foundMouth = false
    eachOuterRing(f.geometry, (ring) => {
      const points = detectPointsOnRing(ring, f.type)
      if (points.length > 0) foundPoint = true
      for (const p of points) {
        const dLat = POINT_TAG_RADIUS_M * DEG_PER_M_LAT
        const dLon = POINT_TAG_RADIUS_M * degPerMeterLon(p.lat)
        pointTree.insert({
          minX: p.lon - dLon, maxX: p.lon + dLon,
          minY: p.lat - dLat, maxY: p.lat + dLat,
          tag: p,
        })
        pointCount++
      }
      if (f.type === 'wetland') {
        const mouths = detectCreekMouthsOnRing(ring)
        if (mouths.length > 0) foundMouth = true
        for (const m of mouths) {
          const dLat = CREEK_TAG_RADIUS_M * DEG_PER_M_LAT
          const dLon = CREEK_TAG_RADIUS_M * degPerMeterLon(m.lat)
          mouthTree.insert({
            minX: m.lon - dLon, maxX: m.lon + dLon,
            minY: m.lat - dLat, maxY: m.lat + dLat,
            tag: m,
          })
          mouthCount++
        }
      }
    })
    if (foundPoint) pointFeatures++
    if (foundMouth) mouthFeatures++
  }

  function tagUnit(
    centroid: [number, number],
    habitatType: HabitatType,
    query: HabitatTreeQuery,
  ): ConvergenceTag[] {
    const [lon, lat] = centroid
    const tags: ConvergenceTag[] = []

    // Point hits
    const ptHits = pointTree.search({
      minX: lon, maxX: lon, minY: lat, maxY: lat,
    })
    for (const h of ptHits) {
      const t = h.tag
      const habitatLabel =
        t.habitatType === 'seagrass' ? 'grass-edge' : t.habitatType === 'oyster' ? 'oyster' : 'marsh'
      tags.push({
        type: 'point',
        strength: t.strength,
        description: `${habitatLabel} point/spit (${t.strength})`,
      })
      break // one point tag per unit max
    }

    // Creek mouth hits (only wetland features can host them, but a nearby
    // seagrass or oyster edge counts as "at the mouth" too)
    const mHits = mouthTree.search({
      minX: lon, maxX: lon, minY: lat, maxY: lat,
    })
    for (const h of mHits) {
      const t = h.tag
      tags.push({
        type: 'creek_mouth',
        strength: t.strength,
        description: `Creek/drainage mouth (${t.widthM.toFixed(0)} m wide)`,
      })
      break
    }

    // Habitat transition — caller supplies the query
    const otherTypes = query(centroid, TRANSITION_RADIUS_M, habitatType)
    if (otherTypes.length > 0) {
      const other = otherTypes[0]
      const fromLabel = habitatType === 'seagrass' ? 'Grass' : habitatType === 'oyster' ? 'Oyster' : 'Marsh'
      const toLabel = other === 'seagrass' ? 'grass' : other === 'oyster' ? 'oyster' : 'marsh'
      tags.push({
        type: 'transition',
        strength: 'moderate',
        description: `${fromLabel}-to-${toLabel} transition`,
      })
    }

    return tags
  }

  return {
    pointStats: { features: pointFeatures, tags: pointCount },
    mouthStats: { features: mouthFeatures, tags: mouthCount },
    tagUnit,
  }
}
