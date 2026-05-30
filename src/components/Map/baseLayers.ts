/**
 * Base layer registry — Step 22 follow-up.
 *
 * Three options exposed by the BaseLayerSwitcher in the top-right corner
 * of the map. Tile URLs, attribution, and max zoom live here so MapView
 * (which renders the active TileLayer), BaseLayerSwitcher (which picks
 * one), and the docs (which list what we cache) all read from the same
 * source of truth.
 *
 * The NOAA endpoints are public-domain Esri-style raster MapServer tile
 * services hosted by NOAA Office of Coast Survey. The `paper` style ships
 * the classic NOAA chart symbology (cream land, magenta channel buoys,
 * depth soundings in feet) that anyone who's read a coastal chart will
 * recognize at a glance. The `enc` style renders the same ENC source data
 * with modern S-52 / ECDIS symbology — cleaner but less familiar to the
 * paper-chart crowd.
 *
 * Esri World Imagery is the original base layer from Step 2 — raw
 * satellite, no labels. Useful for spotting visual structure (sand bars,
 * grass-flat edges) that doesn't show on the charts.
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
}

export const BASE_LAYER_CONFIG: Record<BaseLayer, BaseLayerSpec> = {
  'noaa-paper': {
    key: 'noaa-paper',
    label: 'NOAA Chart',
    description: 'Paper-chart style — depth soundings, channel markers, navaids',
    url: 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; NOAA Office of Coast Survey',
    maxZoom: 17,
    // Classic NOAA chart cream
    swatch: '#f5e9c4',
  },
  'noaa-enc': {
    key: 'noaa-enc',
    label: 'NOAA ENC',
    description: 'Vector ENC — modern S-52 / ECDIS symbology',
    url: 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; NOAA Office of Coast Survey (ENC)',
    maxZoom: 17,
    // ENC sea blue
    swatch: '#bfd9e8',
  },
  'esri-satellite': {
    key: 'esri-satellite',
    label: 'Satellite',
    description: 'Esri World Imagery — raw satellite, no labels',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
    // Satellite water green
    swatch: '#3d6b54',
  },
}

export const BASE_LAYER_ORDER: BaseLayer[] = [
  'noaa-paper',
  'noaa-enc',
  'esri-satellite',
]
