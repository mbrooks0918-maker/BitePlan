export type LatLon = {
  lat: number
  lon: number
}

export type MapState = {
  center: LatLon
  zoom: number
}

export type TideState = 'rising' | 'falling' | 'slack'

export type Species = 'redfish' | 'trout' | 'flounder' | null

export type TideStation = {
  id: string
  name: string
  lat: number
  lon: number
}

// Placeholder. Fleshed out in Step 6 when the scoring engine lands.
export type ScoringContext = {
  tideState: TideState
  hour: number
  species: Species
  moon: { illumination: number; phase: string }
  wind: { speedKt: number; directionDeg: number }
  date: Date
  station: TideStation
}
