/**
 * Base layer registry — Step 22 follow-up (revised).
 *
 * Three options exposed by the BaseLayerSwitcher in the top-right corner
 * of the map. Tile URLs, attribution, and max zoom live here so MapView
 * (which renders the active TileLayer), BaseLayerSwitcher (which picks
 * one), and the docs (which list what we cache) all read from the same
 * source of truth.
 *
 *   'noaa-chart'     — DEFAULT. NOAA Chart Display Service via OGC
 *                      WMTS REST. Paper-chart symbology: depth
 *                      soundings in feet, magenta channel buoys and
 *                      navaids, cream land, white water. What the
 *                      kayak/skiff crowd actually reads on the water.
 *   'esri-streets'   — Esri World Street Map. Roads, parks, place
 *                      names, water features labeled. Useful for
 *                      orienting by named landmarks ("Garcon Rd",
 *                      "Perdido Pass") that don't show on the chart.
 *   'esri-satellite' — Esri World Imagery. Raw satellite tiles, no
 *                      labels. There's a known stitched seam in the
 *                      mosaic near Perdido but it's still useful for
 *                      spotting sand bars, grass-flat edges, and
 *                      other visual structure.
 *
 * The previously-tried 'noaa-enc' option was removed in this revision:
 * NOAA's ENC tile service isn't exposed in a Leaflet-friendly URL
 * pattern, and two NOAA options were redundant anyway — paper-chart
 * style is what anglers want.
 */
import type { BaseLayer } from '@/store/useBitePlanStore'

export type BaseLayerSpec = {
  key: BaseLayer
  label: string
  description: string
  url: string
  attribution: string
  maxZoom: number
  /** Hex used for the small swatch in the switcher UI — a rough visual
   *  hint of the layer's dominant land/sea color. */
  swatch: string
  /** Optional Leaflet `zoomOffset` to align this layer's tile matrix with
   *  the map's standard Web-Mercator zoom level. See note in NOAA_CHART
   *  below for why this is needed. Defaults to 0 (no offset). */
  zoomOffset?: number
  /** Optional Leaflet `minZoom` for this layer — useful when a tile
   *  matrix starts at a non-zero level (e.g. NOAA WMTS z=0 is the same
   *  scale as standard web-mercator z=2, so the layer is meaningless
   *  below that). Defaults to undefined (Leaflet's `MapContainer` minZoom
   *  wins). */
  minZoom?: number
}

// NOAA Chart Display Service tiles, via OGC WMTS REST. The service's
// "GoogleMapsCompatible" tile matrix is in fact NOT standard
// GoogleMapsCompatible — its scale denominators start at the
// equivalent of standard web-mercator z=2 (NOAA's z=0 covers 5×3
// 256-px tiles instead of the standard single tile). So when Leaflet
// is at zoom 12, the URL needs to request NOAA's z=10 to get the
// correct chart tile over the same lon/lat. We compensate with
// `zoomOffset: -2`. The matrix tops out at NOAA z=18, which becomes
// Leaflet zoom 20 with the offset applied. Verified live against the
// published WMTSCapabilities.xml.
const NOAA_CHART_URL =
  'https://gis.charttools.noaa.gov/arcgis/rest/services/MarineChart_Services/NOAACharts/MapServer/WMTS/tile/1.0.0/MarineChart_Services_NOAACharts/default/GoogleMapsCompatible/{z}/{y}/{x}.png'

export const BASE_LAYER_CONFIG: Record<BaseLayer, BaseLayerSpec> = {
  'noaa-chart': {
    key: 'noaa-chart',
    label: 'NOAA Nautical Chart',
    description: 'Depth soundings, channel markers, navaids',
    url: NOAA_CHART_URL,
    attribution: '&copy; NOAA Office of Coast Survey',
    // 20 because of the -2 offset — Leaflet's display zoom can go up
    // to 20, which becomes NOAA's z=18 in the URL.
    maxZoom: 20,
    // Minimum useful display zoom is 2 (which becomes NOAA z=0).
    // Below that, Leaflet won't request tiles; the prior layer fades
    // out and the area shows blank, which is fine since the map's
    // DEFAULT_ZOOM is 12 and we never auto-zoom below ~5.
    minZoom: 2,
    zoomOffset: -2,
    // Classic NOAA chart cream
    swatch: '#f5e9c4',
  },
  'esri-streets': {
    key: 'esri-streets',
    label: 'Streets',
    description: 'Roads + place names — orient by landmarks',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles &copy; Esri &mdash; Sources: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012',
    maxZoom: 19,
    // Esri street base background tint
    swatch: '#e6d9a8',
  },
  'esri-satellite': {
    key: 'esri-satellite',
    label: 'Satellite',
    description: 'Esri World Imagery — visual structure spotting',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
    // Satellite water green
    swatch: '#3d6b54',
  },
}

export const BASE_LAYER_ORDER: BaseLayer[] = [
  'noaa-chart',
  'esri-streets',
  'esri-satellite',
]
