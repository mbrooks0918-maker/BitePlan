import { useEffect, useState } from 'react'
import { GeoJSON } from 'react-leaflet'
import type { PathOptions } from 'leaflet'
import type { FeatureCollection } from 'geojson'
import { useBitePlanStore } from '@/store/useBitePlanStore'

/** HabitatLayers handles only the three habitat polygon layers. The
 *  Step-13.6 `contours` flag in HabitatKey is rendered by DepthContours
 *  alongside us. Narrowing the local key type keeps the file's record
 *  initializers honest. */
type HabitatPolyKey = 'seagrass' | 'oysters' | 'wetlands'

// Style spec per handoff doc — "UI: tier-color heat zones" → "Habitat layer toggles".
//
// Step 22 follow-up: oysters recoloured from amber #f59e0b → purple #a855f7
// to break the visual collision with HOT-tier scored dots (which are
// #f97316 orange). Amber-on-orange was reading as "is this a hot zone or
// an oyster bed?" during user testing of the deployed build. Purple is
// distinct from every other map color (cyan seagrass, lime wetlands,
// orange/red tiers, blue GPS, cyan AMRD anchors) so the eye can sort it
// cleanly.
const LAYER_STYLE: Record<HabitatPolyKey, PathOptions> = {
  seagrass: { color: '#14b8a6', weight: 1, fillColor: '#14b8a6', fillOpacity: 0.30 },
  oysters:  { color: '#a855f7', weight: 1, fillColor: '#a855f7', fillOpacity: 0.35 },
  wetlands: { color: '#84cc16', weight: 1, fillColor: '#84cc16', fillOpacity: 0.25 },
}

// Module-level cache so toggling a layer off then on doesn't refetch.
// Persists across remounts within the same browser session.
const cache = new Map<HabitatPolyKey, FeatureCollection>()
// Tracks fetches already in flight so concurrent toggles don't double-fetch.
const inFlight = new Map<HabitatPolyKey, Promise<FeatureCollection>>()

async function loadLayer(key: HabitatPolyKey): Promise<FeatureCollection> {
  const hit = cache.get(key)
  if (hit) return hit
  const pending = inFlight.get(key)
  if (pending) return pending

  const p = fetch(`/data/${key}.geojson`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} loading ${key}.geojson`)
      return r.json() as Promise<FeatureCollection>
    })
    .then((fc) => {
      cache.set(key, fc)
      inFlight.delete(key)
      return fc
    })
    .catch((e) => {
      inFlight.delete(key)
      throw e
    })

  inFlight.set(key, p)
  return p
}

function HabitatLayers() {
  const habitatLayers = useBitePlanStore((s) => s.habitatLayers)
  const setHabitatLoading = useBitePlanStore((s) => s.setHabitatLoading)

  // Per-layer data once fetched. null = not loaded yet.
  const [data, setData] = useState<Record<HabitatPolyKey, FeatureCollection | null>>(() => ({
    seagrass: cache.get('seagrass') ?? null,
    oysters: cache.get('oysters') ?? null,
    wetlands: cache.get('wetlands') ?? null,
  }))

  // Whenever a layer is toggled on for the first time, kick off its fetch.
  // The map paints satellite tiles immediately; the polygons appear when data lands.
  useEffect(() => {
    const keys: HabitatPolyKey[] = ['seagrass', 'oysters', 'wetlands']
    for (const key of keys) {
      if (habitatLayers[key] && !cache.has(key)) {
        setHabitatLoading(key, true)
        loadLayer(key)
          .then((fc) => {
            setData((d) => ({ ...d, [key]: fc }))
            setHabitatLoading(key, false)
          })
          .catch((e) => {
            console.error(`[habitat] failed to load ${key}:`, e)
            setHabitatLoading(key, false)
          })
      }
    }
  }, [habitatLayers, setHabitatLoading])

  return (
    <>
      {(['seagrass', 'oysters', 'wetlands'] as HabitatPolyKey[]).map((key) => {
        if (!habitatLayers[key] || !data[key]) return null
        return (
          <GeoJSON
            // Re-key so React mounts a fresh layer when data changes (e.g. dev HMR).
            // Without this, toggling off/on can leave stale paths on the canvas.
            key={key}
            data={data[key] as FeatureCollection}
            style={() => LAYER_STYLE[key]}
            interactive={false}
          />
        )
      })}
    </>
  )
}

export default HabitatLayers
