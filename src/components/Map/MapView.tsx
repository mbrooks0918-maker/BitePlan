import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import HabitatLayers from './HabitatLayers'
import DevLayerPanel from './DevLayerPanel'
import TideReadout from '@/components/BottomSheet/TideReadout'

const ESRI_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

const ESRI_ATTRIBUTION = 'Tiles &copy; Esri'

const TIDE_DEBOUNCE_MS = 500

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
  const updateTideStation = useBitePlanStore((s) => s.updateTideStation)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fire once on mount so the tide readout populates without waiting for
  // a user pan.
  useEffect(() => {
    updateTideStation(useBitePlanStore.getState().center)
  }, [updateTideStation])

  useMapEvents({
    moveend(e) {
      const c = e.target.getCenter()
      const newCenter = { lat: c.lat, lon: c.lng }
      setCenter(newCenter)
      // Debounce so a single drag doesn't fire a dozen NOAA fetches; the
      // nearest-station only changes when the user lands somewhere new.
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        updateTideStation(newCenter)
      }, TIDE_DEBOUNCE_MS)
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
        <MapStateSync />
        <InvalidateSizeOnMount />
      </MapContainer>
      <TideReadout />
      <DevLayerPanel />
    </>
  )
}

export default MapView
