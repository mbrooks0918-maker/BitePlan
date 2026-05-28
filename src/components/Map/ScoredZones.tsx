/**
 * Heat-zone rendering for scored units (Step 7).
 *
 * Reads `zones` and `scoredUnits` from the store and emits, in this order:
 *   1. Yellow / Orange / Red zone polygons (canvas, drawn bottom→top)
 *   2. Yellow / Orange dots as CircleMarkers (canvas, drawn above zones)
 *   3. Red dots as DivIcons (DOM, naturally above the canvas pane) — these
 *      pulse via CSS.
 *
 * preferCanvas={true} on the MapContainer means every Path layer (GeoJSON,
 * CircleMarker) shares one canvas; their visual stacking is determined by
 * the order they're added to the map. React mounts children in source order,
 * so the JSX below IS the z-order.
 */

import { useMemo } from 'react'
import { CircleMarker, GeoJSON, Marker } from 'react-leaflet'
import L from 'leaflet'
import type { PathOptions } from 'leaflet'
import type { Tier } from '@/types'
import { useBitePlanStore } from '@/store/useBitePlanStore'

// ----- tier styling (matches handoff doc exactly) -------------------------

const ZONE_STYLE: Record<Tier, PathOptions> = {
  fire: { fillColor: '#ef4444', fillOpacity: 0.25, stroke: false, weight: 0 },
  hot: { fillColor: '#f97316', fillOpacity: 0.18, stroke: false, weight: 0 },
  driveby: { fillColor: '#eab308', fillOpacity: 0.12, stroke: false, weight: 0 },
}

const YELLOW_DOT: PathOptions = {
  fillColor: '#eab308',
  fillOpacity: 0.8,
  color: '#eab308',
  stroke: false,
  weight: 0,
}
const ORANGE_HALO: PathOptions = {
  fillColor: '#f97316',
  fillOpacity: 0.2,
  color: '#f97316',
  stroke: false,
  weight: 0,
}
const ORANGE_DOT: PathOptions = {
  fillColor: '#f97316',
  fillOpacity: 1,
  color: '#f97316',
  stroke: false,
  weight: 0,
}

// Pulsing fire dot — see biteplan-fire-dot CSS in src/index.css.
const FIRE_DOT_ICON = L.divIcon({
  className: 'biteplan-fire-dot-marker',
  html: '<div class="biteplan-fire-dot"></div>',
  iconSize: [28, 28], // 14 px radius × 2
  iconAnchor: [14, 14],
})

function ScoredZones() {
  const zones = useBitePlanStore((s) => s.zones)
  const scoredUnits = useBitePlanStore((s) => s.scoredUnits)

  // Split per tier for deterministic z-order.
  const { yellowZones, orangeZones, redZones } = useMemo(
    () => ({
      yellowZones: zones.filter((z) => z.tier === 'driveby'),
      orangeZones: zones.filter((z) => z.tier === 'hot'),
      redZones: zones.filter((z) => z.tier === 'fire'),
    }),
    [zones],
  )

  const { yellowUnits, orangeUnits, redUnits } = useMemo(
    () => ({
      yellowUnits: scoredUnits.filter((e) => e.result.tier === 'driveby'),
      orangeUnits: scoredUnits.filter((e) => e.result.tier === 'hot'),
      redUnits: scoredUnits.filter((e) => e.result.tier === 'fire'),
    }),
    [scoredUnits],
  )

  return (
    <>
      {/* ----- 1. Zone polygons: bottom → top by tier ----- */}
      {yellowZones.map((z, i) => (
        <GeoJSON
          key={`z-driveby-${i}`}
          data={z.geometry}
          style={() => ZONE_STYLE.driveby}
          interactive={false}
        />
      ))}
      {orangeZones.map((z, i) => (
        <GeoJSON
          key={`z-hot-${i}`}
          data={z.geometry}
          style={() => ZONE_STYLE.hot}
          interactive={false}
        />
      ))}
      {redZones.map((z, i) => (
        <GeoJSON
          key={`z-fire-${i}`}
          data={z.geometry}
          style={() => ZONE_STYLE.fire}
          interactive={false}
        />
      ))}

      {/* ----- 2. Dots: bottom → top, same tier order ----- */}
      {yellowUnits.map((e) => (
        <CircleMarker
          key={`d-driveby-${e.unit.id}`}
          center={[e.unit.centroid[1], e.unit.centroid[0]]}
          radius={8}
          pathOptions={YELLOW_DOT}
          interactive={false}
        />
      ))}
      {orangeUnits.map((e) => (
        <CircleMarker
          key={`d-hot-halo-${e.unit.id}`}
          center={[e.unit.centroid[1], e.unit.centroid[0]]}
          radius={14}
          pathOptions={ORANGE_HALO}
          interactive={false}
        />
      ))}
      {orangeUnits.map((e) => (
        <CircleMarker
          key={`d-hot-${e.unit.id}`}
          center={[e.unit.centroid[1], e.unit.centroid[0]]}
          radius={10}
          pathOptions={ORANGE_DOT}
          interactive={false}
        />
      ))}
      {redUnits.map((e) => (
        <Marker
          key={`d-fire-${e.unit.id}`}
          position={[e.unit.centroid[1], e.unit.centroid[0]]}
          icon={FIRE_DOT_ICON}
          interactive={false}
        />
      ))}
    </>
  )
}

export default ScoredZones
