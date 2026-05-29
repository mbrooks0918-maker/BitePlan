import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import HabitatLayers from './HabitatLayers'
import DepthContours from './DepthContours'
import ScoredZones from './ScoredZones'
import ScoringStatus from './ScoringStatus'
import ZonePopup from './ZonePopup'
import NamedAnchors from './NamedAnchors'
import AnchorPopup from './AnchorPopup'
import SavedWaypoints from './SavedWaypoints'
import SavedWaypointPopup from './SavedWaypointPopup'
import UserLocation from './UserLocation'
import LocateButton from '@/components/LocateButton'
import SaveToast from '@/components/SaveWaypoint/SaveToast'
import BottomSheet from '@/components/BottomSheet/BottomSheet'
import SheetContent from '@/components/BottomSheet/SheetContent'
import OnWaterMode from '@/components/OnWater/OnWaterMode'
import InstallPrompt from '@/components/Install/InstallPrompt'

const ESRI_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

const ESRI_ATTRIBUTION = 'Tiles &copy; Esri'

const TIDE_DEBOUNCE_MS = 500
const WEATHER_DEBOUNCE_MS = 500
const SCORING_DEBOUNCE_MS = 200

// Leaflet captures the container's pixel size during init. When MapContainer
// mounts before the document's final layout settles (HMR remount, iframe
// resize, mobile address-bar collapse), it can stick at a smaller size and
// only paint the center tile. We:
//   1. Defer the first invalidateSize() by one tick so Leaflet's internal
//      level/tile state is fully wired before we tell it to recompute size,
//      otherwise tiles get stranded at fractional opacity in an orphan level.
//   2. Watch the container for actual resizes (rotation, address bar collapse,
//      browser window resize) and invalidate on each.
function InvalidateSizeOnMount() {
  const map = useMap()
  useEffect(() => {
    const initial = window.setTimeout(() => {
      map.invalidateSize({ animate: false, pan: false })
    }, 0)

    const container = map.getContainer()
    let lastW = container.clientWidth
    let lastH = container.clientHeight
    const ro = new ResizeObserver(() => {
      if (container.clientWidth !== lastW || container.clientHeight !== lastH) {
        lastW = container.clientWidth
        lastH = container.clientHeight
        map.invalidateSize({ animate: false, pan: false })
      }
    })
    ro.observe(container)

    return () => {
      window.clearTimeout(initial)
      ro.disconnect()
    }
  }, [map])
  return null
}

/**
 * Saved-waypoint + top-zones fly-to (Step 15 + Step 16). Watches both the
 * waypoint id and the ad-hoc lat/lon target the TopZonesList uses, calls
 * `map.flyTo`, then clears the pending state so the same target can be
 * triggered again later.
 */
function MapFlyToSync() {
  const pendingId = useBitePlanStore((s) => s.pendingFlyToWaypointId)
  const pendingLatLon = useBitePlanStore((s) => s.pendingFlyToLatLon)
  const waypoints = useBitePlanStore((s) => s.waypoints)
  const clearPendingFlyTo = useBitePlanStore((s) => s.clearPendingFlyTo)
  const map = useMap()
  useEffect(() => {
    if (pendingId) {
      const wp = waypoints.find((w) => w.id === pendingId)
      if (wp) map.flyTo([wp.lat, wp.lon], 15, { duration: 1.2 })
      clearPendingFlyTo()
      return
    }
    if (pendingLatLon) {
      map.flyTo([pendingLatLon.lat, pendingLatLon.lon], 15, { duration: 1.2 })
      clearPendingFlyTo()
    }
  }, [pendingId, pendingLatLon, waypoints, clearPendingFlyTo, map])
  return null
}

function MapStateSync() {
  const setCenter = useBitePlanStore((s) => s.setCenter)
  const setZoom = useBitePlanStore((s) => s.setZoom)
  const setBounds = useBitePlanStore((s) => s.setBounds)
  const updateTideStation = useBitePlanStore((s) => s.updateTideStation)
  const updateWeather = useBitePlanStore((s) => s.updateWeather)
  const recomputeScoredUnits = useBitePlanStore((s) => s.recomputeScoredUnits)
  const tideDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const weatherDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scoringDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const map = useMap()

  // On mount: fire the tide + weather fetches and seed the bounds in the
  // store. The scoring worker self-initializes (kicked off at module load
  // in the store) and will request the first recompute itself once it's
  // ready; weather lands shortly after and triggers a re-score with real
  // wind data.
  useEffect(() => {
    const c = useBitePlanStore.getState().center
    updateTideStation(c)
    updateWeather(c)
    const b = map.getBounds()
    setBounds({
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    })
  }, [updateTideStation, updateWeather, setBounds, map])

  useMapEvents({
    moveend(e) {
      const c = e.target.getCenter()
      const b = e.target.getBounds()
      const newCenter = { lat: c.lat, lon: c.lng }
      setCenter(newCenter)
      setBounds({
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
      })

      // Debounce 500ms — only refresh the tide station after the user lands.
      if (tideDebounce.current) clearTimeout(tideDebounce.current)
      tideDebounce.current = setTimeout(() => updateTideStation(newCenter), TIDE_DEBOUNCE_MS)

      // Same 500ms cadence for weather — the NWS points endpoint is the
      // expensive bit and only changes when the user has stopped panning.
      if (weatherDebounce.current) clearTimeout(weatherDebounce.current)
      weatherDebounce.current = setTimeout(() => updateWeather(newCenter), WEATHER_DEBOUNCE_MS)

      // Debounce 200ms — per the handoff doc's perf requirement
      // ("View pan/zoom: scored zones redraw within 300ms").
      if (scoringDebounce.current) clearTimeout(scoringDebounce.current)
      scoringDebounce.current = setTimeout(recomputeScoredUnits, SCORING_DEBOUNCE_MS)
    },
    zoomend(e) {
      setZoom(e.target.getZoom())
    },
  })

  return null
}

function MapView() {
  const center = useBitePlanStore((s) => s.center)
  const zoom = useBitePlanStore((s) => s.zoom)

  return (
    <>
      <MapContainer
        center={[center.lat, center.lon]}
        zoom={zoom}
        maxZoom={19}
        // Canvas rendering is mandatory for the habitat layers — the wetlands
        // file alone has ~5k polygons and SVG rendering chokes on this scale.
        preferCanvas={true}
        // Fade animation can stall in headless / iframe environments (the
        // rAF-driven opacity ramp stops partway), leaving most tiles at near-
        // zero opacity. Popping tiles in instantly is safer and equally usable.
        fadeAnimation={false}
        className="fixed inset-0 z-0"
      >
        <TileLayer
          url={ESRI_TILE_URL}
          attribution={ESRI_ATTRIBUTION}
          maxZoom={19}
        />
        <HabitatLayers />
        <DepthContours />
        <ScoredZones />
        <NamedAnchors />
        <SavedWaypoints />
        <UserLocation />
        <MapStateSync />
        <MapFlyToSync />
        <InvalidateSizeOnMount />
        <LocateButton />
      </MapContainer>
      <ScoringStatus />
      <BottomSheet>
        <SheetContent />
      </BottomSheet>
      <ZonePopup />
      <AnchorPopup />
      <SavedWaypointPopup />
      <SaveToast />
      <OnWaterMode />
      <InstallPrompt />
    </>
  )
}

export default MapView
