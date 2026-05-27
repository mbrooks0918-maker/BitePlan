import type { TideStation } from '@/types'

export type Station = TideStation

/**
 * Coverage-area NOAA tide stations from the handoff doc table.
 *
 * Kept in sync with public/data/tide_stations.json (the runtime copy used
 * by the PWA precache). Update both when adding or correcting stations.
 *
 * Known data caveat: Destin and Panama City both list station ID 8729108
 * in the handoff doc. That looks like a transcription bug — 8729108 is the
 * actual NOAA "Panama City" gauge. Until corrected upstream, Destin queries
 * will return Panama City predictions. Flagged for follow-up.
 */
export const TIDE_STATIONS: ReadonlyArray<Station> = [
  { id: '8735180', name: 'Dauphin Island, AL',         lat: 30.250, lon: -88.075 },
  { id: '8737048', name: 'Mobile State Docks, AL',     lat: 30.708, lon: -88.043 },
  { id: '8736897', name: 'Bon Secour, AL',             lat: 30.328, lon: -87.730 },
  { id: '8729962', name: 'Nix Point, Perdido Bay, FL', lat: 30.413, lon: -87.448 },
  { id: '8729840', name: 'Pensacola, FL',              lat: 30.404, lon: -87.211 },
  { id: '8729214', name: 'Navarre Beach, FL',          lat: 30.376, lon: -86.866 },
  { id: '8729108', name: 'Destin, FL',                 lat: 30.393, lon: -86.514 },
  { id: '8729108', name: 'Panama City, FL',            lat: 30.152, lon: -85.667 },
  { id: '8728690', name: 'Apalachicola, FL',           lat: 29.727, lon: -84.981 },
]

/**
 * Haversine great-circle distance between two lat/lon points on a sphere.
 * Returns kilometers; we only use it to order stations by proximity, so the
 * unit choice doesn't matter to callers — km just keeps the math readable.
 */
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371 // earth radius (km)
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const lat1 = toRad(aLat)
  const lat2 = toRad(bLat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function getNearestStation(lat: number, lon: number): Station {
  let best = TIDE_STATIONS[0]
  let bestD = haversineKm(lat, lon, best.lat, best.lon)
  for (let i = 1; i < TIDE_STATIONS.length; i++) {
    const s = TIDE_STATIONS[i]
    const d = haversineKm(lat, lon, s.lat, s.lon)
    if (d < bestD) {
      best = s
      bestD = d
    }
  }
  return best
}
