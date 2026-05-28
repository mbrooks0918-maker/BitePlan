import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import HabitatLayers from './HabitatLayers'
import DevLayerPanel from './DevLayerPanel'
import ScoredZones from './ScoredZones'
import ScoringStatus from './ScoringStatus'
import ZonePopup from './ZonePopup'
import TideReadout from '@/components/BottomSheet/TideReadout'
import TimeSlider from '@/components/TimeStrip/TimeSlider'
import DayPickerStrip from '@/components/TimeStrip/DayPickerStrip'
import TripStrip from '@/components/Trip/TripStrip'
import { isTripModeActive } from '@/store/useBitePlanStore'

const ESRI_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

const ESRI_ATTRIBUTION = 'Tiles &copy; Esri'

const TIDE_DEBOUNCE_MS = 500
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

function MapStateSync() {
  const setCenter = useBitePlanStore((s) => s.setCenter)
  const setZoom = useBitePlanStore((s) => s.setZoom)
  const setBounds = useBitePlanStore((s) => s.setBounds)
  const updateTideStation = useBitePlanStore((s) => s.updateTideStation)
  const recomputeScoredUnits = useBitePlanStore((s) => s.recomputeScoredUnits)
  const tideDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scoringDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const map = useMap()

  // On mount: fire the tide fetch and seed the bounds in the store. The
  // scoring worker self-initializes (kicked off at module load in the store)
  // and will request the first recompute itself once it's ready.
  useEffect(() => {
    updateTideStation(useBitePlanStore.getState().center)
    const b = map.getBounds()
    setBounds({
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    })
  }, [updateTideStation, setBounds, map])

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
  const timeMode = useBitePlanStore((s) => s.timeMode)
  const tripOverride = useBitePlanStore((s) => s.tripModeOverride)
  const tripActive = isTripModeActive(tripOverride)

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
        <ScoredZones />
        <MapStateSync />
        <InvalidateSizeOnMount />
      </MapContainer>
      <TideReadout />
      <DevLayerPanel />
      <ScoringStatus />
      {timeMode === '24h' ? (
        <TimeSlider />
      ) : tripActive ? (
        <TripStrip />
      ) : (
        <DayPickerStrip />
      )}
      <ZonePopup />
    </>
  )
}

export default MapView
