import type { Geometry } from 'geojson'

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
