/**
 * Named-anchor pins (Step 12.5).
 *
 * Renders one Leaflet marker per entry in `NAMED_ANCHORS` (the verified
 * AMRD reefs, Pensacola Bay restoration sites, and launch points from the
 * handoff doc's Verified Data Inventory). These are identity pins — they
 * don't carry a fishing-conditions score; tapping opens an info popup with
 * the inventory facts.
 *
 * Always visible regardless of scoring state. z-ordered above the canvas
 * tier dots via the markerPane (DOM > canvas).
 */

import { Marker } from 'react-leaflet'
import L from 'leaflet'
import { NAMED_ANCHORS, type AnchorType } from '@/lib/anchors'
import { useBitePlanStore } from '@/store/useBitePlanStore'

// Lucide-styled SVG strings inlined into DivIcon HTML. Keeps the marker
// styling vector-crisp at any zoom and avoids loading bitmap icons.
const ANCHOR_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 22V8" />
    <circle cx="12" cy="5" r="3" />
    <path d="M5 12a7 7 0 0 0 14 0" />
  </svg>
`

const ANCHOR_COLOR: Record<AnchorType, string> = {
  amrd_reef: '#22d3ee',       // cyan-400 — verified built reef
  restoration: '#a78bfa',     // violet-400 — restoration site
  living_shoreline: '#34d399', // emerald-400 — living shoreline
  park_reef: '#60a5fa',       // blue-400 — park-managed structures
  launch: '#fbbf24',          // amber-400 — launch point
}

function makeIcon(type: AnchorType): L.DivIcon {
  return L.divIcon({
    className: 'biteplan-anchor-marker',
    html: `<div class="biteplan-anchor-icon" style="color:${ANCHOR_COLOR[type]}">${ANCHOR_SVG}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  })
}

// One icon instance per type, reused across markers.
const ICONS: Record<AnchorType, L.DivIcon> = {
  amrd_reef: makeIcon('amrd_reef'),
  restoration: makeIcon('restoration'),
  living_shoreline: makeIcon('living_shoreline'),
  park_reef: makeIcon('park_reef'),
  launch: makeIcon('launch'),
}

function NamedAnchors() {
  const selectAnchor = useBitePlanStore((s) => s.selectAnchor)
  return (
    <>
      {NAMED_ANCHORS.map((a) => (
        <Marker
          key={a.id}
          position={[a.lat, a.lon]}
          icon={ICONS[a.type]}
          eventHandlers={{ click: () => selectAnchor(a) }}
        />
      ))}
    </>
  )
}

export default NamedAnchors
