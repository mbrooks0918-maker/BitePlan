import { MapContainer, TileLayer, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import HabitatLayers from './HabitatLayers'
import DevLayerPanel from './DevLayerPanel'

const ESRI_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

const ESRI_ATTRIBUTION = 'Tiles &copy; Esri'

function MapStateSync() {
  const setCenter = useBitePlanStore((s) => s.setCenter)
  const setZoom = useBitePlanStore((s) => s.setZoom)
  useMapEvents({
    moveend(e) {
      const c = e.target.getCenter()
      setCenter({ lat: c.lat, lon: c.lng })
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
        className="fixed inset-0 z-0"
      >
        <TileLayer
          url={ESRI_TILE_URL}
          attribution={ESRI_ATTRIBUTION}
          maxZoom={19}
        />
        <HabitatLayers />
        <MapStateSync />
      </MapContainer>
      <DevLayerPanel />
    </>
  )
}

export default MapView
