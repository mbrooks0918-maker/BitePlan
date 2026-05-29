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

/**
 * Build a waypoint icon. The `dropped` flag adds a spring drop-in
 * animation (Step 21 polish) — used for the freshly-saved waypoint so it
 * lands on the map with a satisfying bounce.
 */
function makeIcon(tier: Tier, dropped: boolean): L.DivIcon {
  const cls = `biteplan-waypoint-marker${dropped ? ' biteplan-waypoint-drop' : ''}`
  return L.divIcon({
    className: cls,
    html: `<div class="biteplan-waypoint-icon" style="color:${TIER_BORDER[tier]}">${BOOKMARK_SVG}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22],
  })
}
const ICONS: Record<Tier, L.DivIcon> = {
  fire: makeIcon('fire', false),
  hot: makeIcon('hot', false),
  driveby: makeIcon('driveby', false),
}
const DROP_ICONS: Record<Tier, L.DivIcon> = {
  fire: makeIcon('fire', true),
  hot: makeIcon('hot', true),
  driveby: makeIcon('driveby', true),
}

// Step 21: the freshly-saved waypoint plays the drop animation. We track
// the newest createdAt and apply DROP_ICONS only to that id, only for
// ~1 second after mount — long enough for the animation to complete but
// short enough that re-renders for unrelated reasons (filter changes,
// pans) don't replay it.
const DROP_WINDOW_MS = 1200

function SavedWaypoints() {
  const waypoints = useBitePlanStore((s) => s.waypoints)
  const selectWaypoint = useBitePlanStore((s) => s.selectWaypoint)

  // Identify the most-recently-saved waypoint and whether we're still
  // inside its drop animation window. Cheap enough to compute on every
  // render — typical waypoint counts are dozens, not thousands.
  const now = Date.now()
  let newest: { id: string; createdAt: number } | null = null
  for (const w of waypoints) {
    if (!newest || w.createdAt > newest.createdAt) newest = { id: w.id, createdAt: w.createdAt }
  }
  const droppingId = newest && now - newest.createdAt < DROP_WINDOW_MS ? newest.id : null

  return (
    <>
      {waypoints.map((w) => (
        <Marker
          key={w.id}
          position={[w.lat, w.lon]}
          icon={(w.id === droppingId ? DROP_ICONS : ICONS)[w.tier]}
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
