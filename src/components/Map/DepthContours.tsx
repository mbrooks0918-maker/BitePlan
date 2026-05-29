/**
 * DepthContours (Step 13.6) — toggleable map overlay that draws
 * `public/data/depth_contours.geojson` polylines, styled per depth interval.
 *
 * Pattern mirrors HabitatLayers: lazy fetch on first toggle-on, module-level
 * cache so re-toggle doesn't refetch, leaflet GeoJSON via react-leaflet
 * canvas rendering.
 *
 * Reading depth lines is a core inshore pattern-recognition skill —
 * surfacing them next to the engine's heat zones helps an angler decide
 * which spots actually correspond to a contour break vs. a flat that just
 * happens to be a unit centroid.
 */
import { useEffect, useState } from 'react'
import { GeoJSON } from 'react-leaflet'
import type { Feature, FeatureCollection, LineString } from 'geojson'
import type { PathOptions } from 'leaflet'
import { useBitePlanStore } from '@/store/useBitePlanStore'

type ContourProps = { depth_ft: number }

// Per-interval styling. Subtle by design — these are a reference layer.
const CONTOUR_STYLE: Record<number, PathOptions> = {
  2:  { color: '#ef4444', weight: 1, opacity: 0.4, dashArray: '3 3' },
  4:  { color: '#facc15', weight: 1, opacity: 0.45, dashArray: '4 4' },
  6:  { color: '#22d3ee', weight: 1, opacity: 0.5 },
  10: { color: '#60a5fa', weight: 1.2, opacity: 0.55 },
  15: { color: '#2563eb', weight: 1.4, opacity: 0.65 },
}
const FALLBACK_STYLE: PathOptions = { color: '#64748b', weight: 1, opacity: 0.4 }

let cache: FeatureCollection<LineString, ContourProps> | null = null
let inFlight: Promise<FeatureCollection<LineString, ContourProps>> | null = null

async function loadContours(): Promise<FeatureCollection<LineString, ContourProps>> {
  if (cache) return cache
  if (inFlight) return inFlight
  inFlight = fetch('/data/depth_contours.geojson')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} loading depth_contours.geojson`)
      return r.json() as Promise<FeatureCollection<LineString, ContourProps>>
    })
    .then((fc) => {
      cache = fc
      inFlight = null
      return fc
    })
    .catch((e) => {
      inFlight = null
      throw e
    })
  return inFlight
}

function DepthContours() {
  const enabled = useBitePlanStore((s) => s.habitatLayers.contours)
  const setHabitatLoading = useBitePlanStore((s) => s.setHabitatLoading)
  const [data, setData] = useState<FeatureCollection<LineString, ContourProps> | null>(
    cache,
  )

  useEffect(() => {
    if (!enabled || cache) return
    setHabitatLoading('contours', true)
    loadContours()
      .then((fc) => {
        setData(fc)
        setHabitatLoading('contours', false)
      })
      .catch((e) => {
        console.error('[depth-contours] failed to load:', e)
        setHabitatLoading('contours', false)
      })
  }, [enabled, setHabitatLoading])

  if (!enabled || !data) return null
  if (data.features.length === 0) {
    // Spec fallback path — the fetch script could not extract contours.
    // We still surface SOMETHING in the dev panel so the toggle isn't
    // silently inert; just don't render anything on the map.
    return null
  }

  return (
    <GeoJSON
      // Re-mount on data change so HMR + cache refresh swap cleanly.
      key={`contours:${data.features.length}`}
      data={data}
      // Per-feature styling: pick the bucket for this interval, fall back to
      // a neutral grey for any unexpected depth value.
      style={(f) => {
        const props = (f?.properties ?? {}) as ContourProps
        return CONTOUR_STYLE[props.depth_ft] ?? FALLBACK_STYLE
      }}
      interactive={false}
      onEachFeature={(_: Feature, _layer) => {
        // Reference layer only — no click handlers, no tooltips. Step 16's
        // proper bottom sheet may add an on-tap depth readout.
      }}
    />
  )
}

export default DepthContours
