/**
 * UserLocation (Step 17).
 *
 * Three Leaflet layers stacked on top of each other:
 *
 *   1. Accuracy circle  — Circle in metre units, only when accuracy > 50m.
 *                         Semi-transparent blue fill, no border. Drawn first
 *                         so the dot+ring sit cleanly on top.
 *   2. Pulsing ring     — DivIcon with a pure-CSS animated ring. Marker is
 *                         non-interactive so taps fall through to the map
 *                         below (popups, etc.).
 *   3. Solid blue dot   — Inside the same DivIcon as the ring; the ring is
 *                         the absolutely-positioned ::before pseudo-element
 *                         and the dot is the static center.
 *
 * The dot doesn't open a popup — it's purely a position indicator. Pop-up
 * interactions are intentionally reserved for scored zones, anchors, and
 * saved waypoints.
 *
 * First-fix auto-centre: on the first non-null userLocation in a session
 * we pan the map to the dot exactly once, then flip the store flag so we
 * never do it again. Subsequent watchPosition updates only update the dot.
 */
import { useEffect, useMemo } from 'react'
import { Circle, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import { useBitePlanStore } from '@/store/useBitePlanStore'

const LOW_ACCURACY_THRESHOLD_M = 50
const ACCURACY_CIRCLE_STYLE = {
  color: '#3b82f6',
  fillColor: '#3b82f6',
  fillOpacity: 0.12,
  weight: 0,
  interactive: false as const,
}

// The DivIcon is created once and reused. Pure CSS animation lives in
// index.css (.biteplan-user-location-marker / -dot / -ring).
const USER_DOT_ICON = L.divIcon({
  className: 'biteplan-user-location-marker',
  html:
    '<div class="biteplan-user-location-ring" aria-hidden="true"></div>' +
    '<div class="biteplan-user-location-dot" aria-hidden="true"></div>',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
})

function UserLocation() {
  const loc = useBitePlanStore((s) => s.userLocation)
  const hasAutoCentered = useBitePlanStore((s) => s.hasAutoCenteredOnUser)
  const markAutoCentered = useBitePlanStore((s) => s.markAutoCentered)
  const map = useMap()

  // First-fix auto-centre. Fires exactly once per session per the spec
  // ("subsequent updates don't pan").
  useEffect(() => {
    if (!loc) return
    if (hasAutoCentered) return
    map.panTo([loc.lat, loc.lon], { animate: true, duration: 0.8 })
    markAutoCentered()
  }, [loc, hasAutoCentered, markAutoCentered, map])

  // Memoise the position tuple so leaflet's marker doesn't rebuild every
  // re-render — only when lat/lon actually change.
  const position = useMemo<[number, number] | null>(
    () => (loc ? [loc.lat, loc.lon] : null),
    [loc],
  )

  if (!loc || !position) return null

  const showAccuracy = loc.accuracyM > LOW_ACCURACY_THRESHOLD_M

  return (
    <>
      {showAccuracy && (
        <Circle
          center={position}
          radius={loc.accuracyM}
          pathOptions={ACCURACY_CIRCLE_STYLE}
        />
      )}
      <Marker
        position={position}
        icon={USER_DOT_ICON}
        interactive={false}
        keyboard={false}
        // Bump pane so the dot sits above scored zones and AMRD anchors
        // but stays below popup/toast layers. Markers default to the
        // 'markerPane' (zIndex 600); we keep that.
      />
    </>
  )
}

export default UserLocation
