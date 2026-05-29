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

// =====================================================================
// Step 12.5 v3 strict thresholds — see directive in handoff doc.
// =====================================================================
//
// Each detector's bar was raised significantly after v2's "every shore lit"
// visual. The v3 ground rule: only emit a tag when the structure is
// unambiguously real to a human looking at the chart. Then the scoring
// engine's multi-tag gate (in scoring.ts) requires 2+ DIFFERENT tag types
// to unlock a unit above driveby — so individual detector liberties matter
// less than they did under the single-tag unlock model.

// --- Point / spit ---------------------------------------------------------
//
// Real fishery points are sharp inflections with substantial edges extending
// outward. Digitization micro-jitter is filtered by collapsing vertices
// within VERTEX_COLLAPSE_M before angle analysis. Then both adjacent edges
// must be long, AND the turn must be sharp.
const VERTEX_COLLAPSE_M = 20           // merge near-neighbors before angle calc
const POINT_MIN_EDGE_M = 100           // adjacent edges must be ≥ 100 m each
const POINT_WEAK_TURN_DEG = 60         // interior < 120°
const POINT_MODERATE_TURN_DEG = 90     // interior < 90°
const POINT_STRONG_TURN_DEG = 120      // interior < 60°
const POINT_TAG_RADIUS_M = 25

// --- Creek / drainage mouth ----------------------------------------------
//
// Two non-adjacent ring vertices come within CREEK_PINCH_M of each other,
// AND the two arcs between them enclose substantially different areas
// (one is the "wetland interior", the other is the gap opening to the bay).
// The asymmetry test is what distinguishes a drainage from a thin neck.
// v3 iter-3: even 18 m pinches were noisy. Final: ≤ 12 m max width, gap arc
// must be ≥ 10x smaller than interior arc, AND the interior side must be
// substantial (≥ 5,000 sq m at this latitude). Only real drainage mouths
// survive.
const CREEK_PINCH_M = 12
const CREEK_MIN_BOUNDARY_GAP = 14
const CREEK_MAX_RING_VERTICES = 400
const CREEK_SIDE_AREA_RATIO = 10
const CREEK_INTERIOR_MIN_DEG2 = 5e-7 // ≈ 5,000 m² in degree-squared at ~30° N
const CREEK_TAG_RADIUS_M = 18
const CREEK_MODERATE_M = 10
const CREEK_STRONG_M = 6

// --- Habitat transition --------------------------------------------------
//
// v3 iter-2: 25 m was generous in the dense Perdido data. Drop to 8 m so
// only true edge-to-edge meetings qualify. (Centroid-distance filtering was
// considered but rejected — large feature centroids sit far from edges, so
// the check would false-negative legitimate transitions.)
const TRANSITION_RADIUS_M = 8

// --- Chokepoint (Step 13.5) ----------------------------------------------
//
// Tidal pinch < 300 m wide between two larger water bodies. Detecting this
// from the habitat polygons alone is unreliable (we have no land mask, only
// shoreline-adjacent habitat). For the Phase 1 coverage area we hardcode
// the five known Gulf inshore passes documented in the audit memo; any
// scoring unit whose centroid lands within CHOKEPOINT_TAG_RADIUS_M of one
// gets a chokepoint convergence tag.
//
// Coordinates are public-knowledge nautical chart references; widths are
// approximate (Gulf passes shift season to season as sand bars migrate).
const CHOKEPOINT_TAG_RADIUS_M = 500
type KnownChokepoint = { name: string; lat: number; lon: number; widthM: number }
const KNOWN_CHOKEPOINTS: KnownChokepoint[] = [
  { name: 'Perdido Pass',       lat: 30.272, lon: -87.553, widthM: 200 },
  { name: 'Pensacola Pass',     lat: 30.323, lon: -87.293, widthM: 300 },
  { name: 'East Pass (Destin)', lat: 30.387, lon: -86.518, widthM: 200 },
  { name: 'St. Andrew Pass',    lat: 30.124, lon: -85.730, widthM: 200 },
  { name: 'Bob Sikes Cut',      lat: 29.717, lon: -84.872, widthM: 100 },
]

// --- Confluence (Step 13.5) ----------------------------------------------
//
// Two or more creek/drainage mouths within CONFLUENCE_PAIR_M of each other.
// Stronger than a single mouth (audit: "where two creek/drainage mouths meet
// open water within close proximity (~100 m)"). The midpoint is the tag
// location; any unit within CONFLUENCE_TAG_RADIUS_M of that midpoint
// inherits the tag.
const CONFLUENCE_PAIR_M = 100
const CONFLUENCE_TAG_RADIUS_M = 150

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
type DetectedChokepoint = { lon: number; lat: number; name: string; widthM: number }
type DetectedConfluence = { lon: number; lat: number; mouthCount: number }

type IndexedPoint = { minX: number; minY: number; maxX: number; maxY: number; tag: DetectedPoint }
type IndexedMouth = { minX: number; minY: number; maxX: number; maxY: number; tag: DetectedMouth }
type IndexedChokepoint = { minX: number; minY: number; maxX: number; maxY: number; tag: DetectedChokepoint }
type IndexedConfluence = { minX: number; minY: number; maxX: number; maxY: number; tag: DetectedConfluence }

// ---- detection helpers ---------------------------------------------------

function eachOuterRing(geom: Geometry, fn: (ring: number[][]) => void): void {
  if (geom.type === 'Polygon') fn((geom as Polygon).coordinates[0])
  else if (geom.type === 'MultiPolygon') {
    for (const poly of (geom as MultiPolygon).coordinates) fn(poly[0])
  }
}

/**
 * Collapse vertices within VERTEX_COLLAPSE_M of their predecessor into a
 * single representative. Removes digitization noise before angle analysis
 * so we don't pick up "points" that are just zigzag jitter.
 */
function collapseNearVertices(ring: number[][]): number[][] {
  if (ring.length < 4) return ring
  const out: number[][] = [ring[0]]
  for (let i = 1; i < ring.length - 1; i++) {
    const prev = out[out.length - 1]
    if (haversineMeters(prev as [number, number], ring[i] as [number, number]) >= VERTEX_COLLAPSE_M) {
      out.push(ring[i])
    }
  }
  // Always re-close the ring with the original last vertex
  if (out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1])
  return out
}

/**
 * Simple polygon area via the shoelace formula. Coordinates in degree-space;
 * the value is only used for RATIOS (interior arc vs gap arc), not absolute
 * area, so degree-units are fine.
 */
function shoelaceAbs(poly: number[][]): number {
  let s = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    s += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(s) / 2
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
function detectPointsOnRing(rawRing: number[][], habitatType: HabitatType): DetectedPoint[] {
  const out: DetectedPoint[] = []
  // v3: collapse digitization jitter before angle analysis. The collapsed
  // ring is shorter and only retains topologically meaningful turns.
  const ring = collapseNearVertices(rawRing)
  const n = ring.length - 1
  if (n < 6) return out

  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n]
    const curr = ring[i]
    const next = ring[(i + 1) % n]

    const dA = haversineMeters(prev as [number, number], curr as [number, number])
    const dB = haversineMeters(curr as [number, number], next as [number, number])
    if (dA < POINT_MIN_EDGE_M || dB < POINT_MIN_EDGE_M) continue

    const ax = curr[0] - prev[0]
    const ay = curr[1] - prev[1]
    const bx = next[0] - curr[0]
    const by = next[1] - curr[1]
    const cross = ax * by - ay * bx
    const dot = ax * bx + ay * by
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
function detectCreekMouthsOnRing(rawRing: number[][]): DetectedMouth[] {
  const out: DetectedMouth[] = []
  // v3: collapse jitter, then enforce side-area asymmetry. A pinch that
  // splits the ring roughly in half is a thin neck, not a drainage mouth.
  const ring = collapseNearVertices(rawRing)
  const n = ring.length - 1
  if (n > CREEK_MAX_RING_VERTICES) return out
  if (n < 16) return out

  const tree = new RBush<{ minX: number; minY: number; maxX: number; maxY: number; i: number }>()
  const sampleLat = ring[0][1]
  const dLat = CREEK_PINCH_M * DEG_PER_M_LAT
  const dLon = CREEK_PINCH_M * degPerMeterLon(sampleLat)
  tree.load(
    ring.slice(0, n).map((p, idx) => ({
      minX: p[0], maxX: p[0], minY: p[1], maxY: p[1], i: idx,
    })),
  )

  const seen = new Set<string>()

  for (let i = 0; i < n; i++) {
    const v = ring[i]
    const hits = tree.search({
      minX: v[0] - dLon, maxX: v[0] + dLon,
      minY: v[1] - dLat, maxY: v[1] + dLat,
    })
    for (const h of hits) {
      const j = h.i
      const gap = Math.min(Math.abs(i - j), n - Math.abs(i - j))
      if (gap < CREEK_MIN_BOUNDARY_GAP) continue
      const pairKey = i < j ? `${i}-${j}` : `${j}-${i}`
      if (seen.has(pairKey)) continue
      seen.add(pairKey)

      const widthM = haversineMeters(v as [number, number], ring[j] as [number, number])
      if (widthM > CREEK_PINCH_M) continue

      // Side-area asymmetry check: the chord v→ring[j] splits the polygon
      // into two arcs. Compute the area each arc encloses (arc + chord).
      // A real drainage has one big "interior" side and one small "gap"
      // side; a thin neck has two similar sides.
      const [lo, hi] = i < j ? [i, j] : [j, i]
      const sideA: number[][] = []
      for (let k = lo; k <= hi; k++) sideA.push(ring[k])
      const sideB: number[][] = []
      for (let k = hi; k < n; k++) sideB.push(ring[k])
      for (let k = 0; k <= lo; k++) sideB.push(ring[k])
      const aA = shoelaceAbs(sideA)
      const aB = shoelaceAbs(sideB)
      const interior = Math.max(aA, aB)
      const gapArea = Math.min(aA, aB)
      const ratio = interior / Math.max(gapArea, 1e-12)
      if (ratio < CREEK_SIDE_AREA_RATIO) continue
      if (interior < CREEK_INTERIOR_MIN_DEG2) continue

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
  chokepointStats: { tags: number }
  confluenceStats: { tags: number }
  tagUnit: (
    centroid: [number, number],
    habitatType: HabitatType,
    query: HabitatTreeQuery,
  ) => ConvergenceTag[]
}

export function buildConvergenceContext(features: HabitatFeature[]): ConvergenceContext {
  const pointTree = new RBush<IndexedPoint>()
  const mouthTree = new RBush<IndexedMouth>()
  const chokepointTree = new RBush<IndexedChokepoint>()
  const confluenceTree = new RBush<IndexedConfluence>()

  let pointCount = 0
  let pointFeatures = 0
  let mouthCount = 0
  let mouthFeatures = 0
  let chokepointCount = 0
  let confluenceCount = 0

  // Collect every detected mouth (with its location) so we can do a pairwise
  // proximity scan below to derive confluence tags.
  const allMouths: DetectedMouth[] = []

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
          allMouths.push(m)
        }
      }
    })
    if (foundPoint) pointFeatures++
    if (foundMouth) mouthFeatures++
  }

  // --- Confluence pass ---------------------------------------------------
  //
  // O(n²) over detected mouths is cheap (mouths are sparse — typically dozens
  // per Phase 1 area). Pair every mouth with every later mouth and emit a
  // confluence tag at the midpoint when they're within CONFLUENCE_PAIR_M.
  // A "cluster" of 3+ mouths produces 3 pair-midpoints that share a tag tree
  // — the rendered popup just shows whichever lands within the unit's
  // search radius.
  for (let i = 0; i < allMouths.length; i++) {
    for (let j = i + 1; j < allMouths.length; j++) {
      const a = allMouths[i]
      const b = allMouths[j]
      const d = haversineMeters([a.lon, a.lat], [b.lon, b.lat])
      if (d > CONFLUENCE_PAIR_M) continue
      const conf: DetectedConfluence = {
        lon: (a.lon + b.lon) / 2,
        lat: (a.lat + b.lat) / 2,
        mouthCount: 2, // we only know about this pair locally
      }
      const dLat = CONFLUENCE_TAG_RADIUS_M * DEG_PER_M_LAT
      const dLon = CONFLUENCE_TAG_RADIUS_M * degPerMeterLon(conf.lat)
      confluenceTree.insert({
        minX: conf.lon - dLon, maxX: conf.lon + dLon,
        minY: conf.lat - dLat, maxY: conf.lat + dLat,
        tag: conf,
      })
      confluenceCount++
    }
  }

  // --- Chokepoint pass ---------------------------------------------------
  //
  // Hardcoded for Phase 1 (see KNOWN_CHOKEPOINTS comment above). Each known
  // pass gets one tag in the rbush; units within CHOKEPOINT_TAG_RADIUS_M
  // pick it up at derive time.
  for (const cp of KNOWN_CHOKEPOINTS) {
    const dLat = CHOKEPOINT_TAG_RADIUS_M * DEG_PER_M_LAT
    const dLon = CHOKEPOINT_TAG_RADIUS_M * degPerMeterLon(cp.lat)
    chokepointTree.insert({
      minX: cp.lon - dLon, maxX: cp.lon + dLon,
      minY: cp.lat - dLat, maxY: cp.lat + dLat,
      tag: { lon: cp.lon, lat: cp.lat, name: cp.name, widthM: cp.widthM },
    })
    chokepointCount++
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

    // Chokepoint hits (Step 13.5) — any unit within ~500 m of a known pass.
    // Documented as flounder-stacking spots and bull-redfish run paths.
    const cpHits = chokepointTree.search({
      minX: lon, maxX: lon, minY: lat, maxY: lat,
    })
    for (const h of cpHits) {
      const t = h.tag
      tags.push({
        type: 'chokepoint',
        strength: 'strong',
        description: `${t.name} chokepoint (${t.widthM} m wide)`,
      })
      break // one chokepoint tag per unit max
    }

    // Confluence hits (Step 13.5) — drainage convergence within ~150 m.
    const confHits = confluenceTree.search({
      minX: lon, maxX: lon, minY: lat, maxY: lat,
    })
    if (confHits.length > 0) {
      tags.push({
        type: 'confluence',
        strength: 'moderate',
        description: 'Confluence of drainage mouths',
      })
    }

    return tags
  }

  return {
    pointStats: { features: pointFeatures, tags: pointCount },
    mouthStats: { features: mouthFeatures, tags: mouthCount },
    chokepointStats: { tags: chokepointCount },
    confluenceStats: { tags: confluenceCount },
    tagUnit,
  }
}
