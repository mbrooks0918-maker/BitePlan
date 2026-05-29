import type { Geometry, MultiPolygon, Polygon } from 'geojson'

export type LatLon = {
  lat: number
  lon: number
}

export type MapState = {
  center: LatLon
  zoom: number
}

export type TideState = 'rising' | 'falling' | 'slack'

/** Species filter. 'all' = no filter; anything else applies that species' bonuses. */
export type Species = 'all' | 'redfish' | 'trout' | 'flounder'

export type TideStation = {
  id: string
  name: string
  lat: number
  lon: number
}

export type HabitatType = 'seagrass' | 'oyster' | 'wetland'

/** A single feature from one of the habitat GeoJSON files. */
export type HabitatFeature = {
  id: string
  type: HabitatType
  geometry: Geometry
  properties: Record<string, unknown>
}

/** Structural-feature tag attached to a scoring unit. The convergence-scoring
 *  philosophy (Step 12.5, see handoff doc) gates units out of hot/fire tiers
 *  unless they carry at least one of these tags. */
export type ConvergenceTag = {
  type: 'point' | 'creek_mouth' | 'transition'
  description: string
  strength: 'weak' | 'moderate' | 'strong'
}

/** What the scoring engine actually scores: either a small whole polygon
 *  or a sampled edge point off a large polygon's boundary. */
export type ScoringUnit = {
  id: string
  unitType: 'polygon' | 'edge_point'
  habitatType: HabitatType
  geometry: Geometry
  /** [lon, lat] — used as the visual location for clustering and popups. */
  centroid: [number, number]
  parentFeatureId: string
  /** Detected structural features at or near this unit's centroid. Empty
   *  array means "bare habitat" → scoring engine caps at driveby. */
  convergence: ConvergenceTag[]
}

/** Visible-bounds query envelope (matches Leaflet/turf bbox convention). */
export type Bounds = {
  west: number
  south: number
  east: number
  north: number
}

/** Inputs the scoring engine reads per call. Everything is pre-computed
 *  by the store so scoreUnit() can stay pure and synchronous. */
export type ScoringContext = {
  time: Date
  tideState: TideState
  species: Species
  /** 0.0 (new) to 1.0 (full). */
  moonIllumination: number
  sunrise: Date
  sunset: Date
  /** Wind speed in knots. Until Step 13 wires NWS, this is 0. */
  windSpeedKt: number
  /** Today's high minus low at the active station, feet. */
  dailyTideRangeFt: number
  /** 1 (Jan) - 12 (Dec). */
  month: number
  /** 0 - 23 in local time. */
  hour: number
}

export type FactorCategory =
  | 'tide'
  | 'time'
  | 'species'
  | 'habitat'
  | 'moon'
  | 'wind'
  | 'season'
  | 'depth'
  | 'convergence'

export type ScoringFactor = {
  fired: boolean
  description: string
  delta: number
  category: FactorCategory
}

export type Tier = 'fire' | 'hot' | 'driveby'

export type ScoringResult = {
  /** Clamped to 0-10. */
  score: number
  tier: Tier
  /** Human-readable time-spend recommendation per the handoff doc. */
  timeInvestment: string
  firedFactors: ScoringFactor[]
  missingFactors: ScoringFactor[]
  /** Filled in by Step 9's projection logic; null for now. */
  projectedNextFire: null
}

/** Time-strip display mode. The 24h slider and the 7-day picker share the
 *  same screen real estate near the bottom of the map. */
export type TimeMode = '24h' | '7day'

/**
 * Per-day summary for the day picker. The day's `conditionsScore` is the
 * single best unit score reached in the day's best 3-hour window, rounded
 * to an integer 1-10. `fireZoneCount` is the number of units that hit
 * fire-tier (≥ 8) in that same best window. Step 12 (Trip Mode) reuses this
 * shape with `dayCount = 12`.
 */
export type DayCondition = {
  /** YYYY-MM-DD of the day this row represents. */
  date: string
  /** 1-10 rounded score; the day's "Conditions Score". */
  conditionsScore: number
  /** Count of fire-tier (≥ 8) units in the day's best window. */
  fireZoneCount: number
  /** Start of the best 3-hour window, epoch ms. */
  bestWindowStartMs: number
  /** Raw (un-rounded) best unit score at the best window. */
  bestWindowScore: number
}

/**
 * A clustered group of same-tier scored units rendered as one tinted polygon.
 * Geometry is a convex hull around the cluster's member centroids, buffered
 * outward by ~50 m so the zone reads as a soft blob rather than a stark
 * polygon.
 *
 * topUnit/topResult are the highest-scoring member of the cluster — used when
 * the user taps the zone polygon and we need to open the popup against a
 * single representative unit.
 */
export type HeatZone = {
  tier: Tier
  geometry: Polygon | MultiPolygon
  memberCount: number
  topUnit: ScoringUnit
  topResult: ScoringResult
}
