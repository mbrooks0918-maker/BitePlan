/**
 * Step 14 — saved-waypoint map pins.
 *
 * Renders one Leaflet marker per entry in `store.waypoints`. The pin is a
 * small white bookmark with a tier-colored border so the eye reads
 * (a) "this is a saved spot, not a scored zone dot", and (b) "what tier
 * was it when I saved it". Tapping selects the waypoint for the
 * SavedWaypointPopup.
 *
 * Always visible regardless of scoring state. Z-ordered above the canvas
 * tier dots via the markerPane (DOM-rendered markers sit above the
 * canvas-rendered shapes).
 */
import { Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { Tier } from '@/types'

const TIER_BORDER: Record<Tier, string> = {
  fire: '#ef4444',
  hot: '#f97316',
  driveby: '#facc15',
}

// Inlined Lucide `Bookmark`. White fill + tier-colored stroke so it pops
// against satellite tiles AND signals what tier it was when saved.
const BOOKMARK_SVG = `
  <svg viewBox="0 0 24 24" fill="white" stroke="currentColor" stroke-width="2.5"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
  </svg>
`

// One icon per tier; reused across markers.
function makeIcon(tier: Tier): L.DivIcon {
  return L.divIcon({
    className: 'biteplan-waypoint-marker',
    html: `<div class="biteplan-waypoint-icon" style="color:${TIER_BORDER[tier]}">${BOOKMARK_SVG}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22], // pointed end of the bookmark sits on the lat/lon
  })
}
const ICONS: Record<Tier, L.DivIcon> = {
  fire: makeIcon('fire'),
  hot: makeIcon('hot'),
  driveby: makeIcon('driveby'),
}

function SavedWaypoints() {
  const waypoints = useBitePlanStore((s) => s.waypoints)
  const selectWaypoint = useBitePlanStore((s) => s.selectWaypoint)

  return (
    <>
      {waypoints.map((w) => (
        <Marker
          key={w.id}
          position={[w.lat, w.lon]}
          icon={ICONS[w.tier]}
          eventHandlers={{ click: () => selectWaypoint(w.id) }}
        >
          {/* Hover-tap tooltip shows the label without opening the popup —
              useful for quickly scanning what's saved while panning. */}
          <Tooltip direction="top" offset={[0, -18]} opacity={0.95}>
            {w.label}
          </Tooltip>
        </Marker>
      ))}
    </>
  )
}

export default SavedWaypoints
