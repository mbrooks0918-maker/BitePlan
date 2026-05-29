/**
 * Heat-zone rendering for scored units (Step 7).
 *
 * Reads `zones` and `scoredUnits` from the store and emits, in this order:
 *   1. Yellow / Orange / Red zone polygons (canvas, drawn bottom→top)
 *   2. Yellow / Orange dots as CircleMarkers (canvas, drawn above zones)
 *   3. Red dots as DivIcons (DOM, naturally above the canvas pane) — these
 *      pulse via CSS.
 *
 * Step 8 made every layer interactive: clicking a polygon opens the popup
 * against the cluster's top scoring member; clicking a dot opens it against
 * that dot's specific scored unit.
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

/**
 * Build a fire-dot DivIcon with a deterministic phase offset so the pulse
 * staggers across many fires instead of beating in unison. The offset is
 * a hash of the unit's lat/lon mapped into the 0–2s pulse cycle and
 * applied via the `--biteplan-pulse-phase` CSS variable (Step 21 polish).
 */
function makeFireDotIcon(lon: number, lat: number): L.DivIcon {
  // Cheap deterministic hash → [0, 2000) ms offset.
  const phaseMs = Math.floor(((lon * 1000) ^ (lat * 1000)) & 0xffff) % 2000
  return L.divIcon({
    className: 'biteplan-fire-dot-marker biteplan-tier-fadein',
    html: `<div class="biteplan-fire-dot" style="--biteplan-pulse-phase:-${phaseMs}ms"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })
}

function ScoredZones() {
  const zones = useBitePlanStore((s) => s.zones)
  const scoredUnits = useBitePlanStore((s) => s.scoredUnits)
  const selectZone = useBitePlanStore((s) => s.selectZone)
  const tierFilter = useBitePlanStore((s) => s.tierFilter)

  // Step 16 tier filter — hide driveby (and optionally hot) when the user
  // asks for fire+ / hot+ chips at the Half snap. We filter both the zone
  // polygons and the per-unit dots so the map and the in-sheet
  // TopZonesList stay visually in sync.
  const tierAllowed = (t: 'fire' | 'hot' | 'driveby'): boolean => {
    if (tierFilter === 'all') return true
    if (tierFilter === 'fire+') return t === 'fire'
    return t === 'fire' || t === 'hot'
  }

  // Split per tier for deterministic z-order.
  const { yellowZones, orangeZones, redZones } = useMemo(
    () => ({
      yellowZones: tierAllowed('driveby') ? zones.filter((z) => z.tier === 'driveby') : [],
      orangeZones: tierAllowed('hot') ? zones.filter((z) => z.tier === 'hot') : [],
      redZones: tierAllowed('fire') ? zones.filter((z) => z.tier === 'fire') : [],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zones, tierFilter],
  )

  const { yellowUnits, orangeUnits, redUnits } = useMemo(
    () => ({
      yellowUnits: tierAllowed('driveby')
        ? scoredUnits.filter((e) => e.result.tier === 'driveby')
        : [],
      orangeUnits: tierAllowed('hot')
        ? scoredUnits.filter((e) => e.result.tier === 'hot')
        : [],
      redUnits: tierAllowed('fire')
        ? scoredUnits.filter((e) => e.result.tier === 'fire')
        : [],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scoredUnits, tierFilter],
  )

  return (
    <>
      {/* ----- 1. Zone polygons: bottom → top by tier ----- */}
      {yellowZones.map((z, i) => (
        <GeoJSON
          key={`z-driveby-${i}`}
          data={z.geometry}
          style={() => ZONE_STYLE.driveby}
          eventHandlers={{ click: () => selectZone({ unit: z.topUnit, result: z.topResult }) }}
        />
      ))}
      {orangeZones.map((z, i) => (
        <GeoJSON
          key={`z-hot-${i}`}
          data={z.geometry}
          style={() => ZONE_STYLE.hot}
          eventHandlers={{ click: () => selectZone({ unit: z.topUnit, result: z.topResult }) }}
        />
      ))}
      {redZones.map((z, i) => (
        <GeoJSON
          key={`z-fire-${i}`}
          data={z.geometry}
          style={() => ZONE_STYLE.fire}
          eventHandlers={{ click: () => selectZone({ unit: z.topUnit, result: z.topResult }) }}
        />
      ))}

      {/* ----- 2. Dots: bottom → top, same tier order ----- */}
      {/* Keys include the array index because the Step 3 wetlands tile fetch
       *  returned a small number of duplicate features at tile seams, which
       *  surface here as identical unit.id values. Index-prefixed keys keep
       *  React happy without us having to dedup at the data layer. */}
      {yellowUnits.map((e, i) => (
        <CircleMarker
          key={`d-driveby-${i}-${e.unit.id}`}
          center={[e.unit.centroid[1], e.unit.centroid[0]]}
          radius={8}
          pathOptions={YELLOW_DOT}
          eventHandlers={{ click: () => selectZone(e) }}
        />
      ))}
      {orangeUnits.map((e, i) => (
        // The halo is purely decorative — let clicks fall through to the dot
        // below it so we don't have two layers fighting over the same tap.
        <CircleMarker
          key={`d-hot-halo-${i}-${e.unit.id}`}
          center={[e.unit.centroid[1], e.unit.centroid[0]]}
          radius={14}
          pathOptions={ORANGE_HALO}
          interactive={false}
        />
      ))}
      {orangeUnits.map((e, i) => (
        <CircleMarker
          key={`d-hot-${i}-${e.unit.id}`}
          center={[e.unit.centroid[1], e.unit.centroid[0]]}
          radius={10}
          pathOptions={ORANGE_DOT}
          eventHandlers={{ click: () => selectZone(e) }}
        />
      ))}
      {redUnits.map((e, i) => (
        <Marker
          key={`d-fire-${i}-${e.unit.id}`}
          position={[e.unit.centroid[1], e.unit.centroid[0]]}
          icon={makeFireDotIcon(e.unit.centroid[0], e.unit.centroid[1])}
          eventHandlers={{ click: () => selectZone(e) }}
        />
      ))}
    </>
  )
}

export default ScoredZones
