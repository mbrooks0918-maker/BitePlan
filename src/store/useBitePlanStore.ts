import { create } from 'zustand'
import type { LatLon } from '@/types'
import { getNearestStation, type Station } from '@/lib/stations'
import { fetchTidePredictions, type TidePrediction } from '@/lib/tides'

const PERDIDO_BAY: LatLon = { lat: 30.317, lon: -87.436 }
const DEFAULT_ZOOM = 12

export type HabitatKey = 'seagrass' | 'oysters' | 'wetlands'
export type HabitatFlags = Record<HabitatKey, boolean>

type BitePlanState = {
  center: LatLon
  zoom: number
  currentTime: Date

  // Habitat layer visibility — all three default OFF per the handoff doc
  // ("off by default to reduce clutter").
  habitatLayers: HabitatFlags
  habitatLoading: HabitatFlags

  // Nearest NOAA station to map center, plus today's hi/lo predictions for it.
  // currentStation is non-nullable because we seed it from the default center
  // on init so the readout pill can render a station name before the first
  // fetch resolves.
  currentStation: Station
  tidePredictions: TidePrediction[]
  tideLoading: boolean

  setCenter: (center: LatLon) => void
  setZoom: (zoom: number) => void
  setCurrentTime: (currentTime: Date) => void
  toggleHabitat: (key: HabitatKey) => void
  setHabitatLoading: (key: HabitatKey, isLoading: boolean) => void
  updateTideStation: (mapCenter: LatLon) => Promise<void>
}

export const useBitePlanStore = create<BitePlanState>((set, get) => ({
  center: PERDIDO_BAY,
  zoom: DEFAULT_ZOOM,
  currentTime: new Date(),

  habitatLayers: { seagrass: false, oysters: false, wetlands: false },
  habitatLoading: { seagrass: false, oysters: false, wetlands: false },

  currentStation: getNearestStation(PERDIDO_BAY.lat, PERDIDO_BAY.lon),
  tidePredictions: [],
  // Start true so the pill says "Loading tide…" until the first fetch resolves,
  // rather than briefly flashing "Tide unavailable" on cold start.
  tideLoading: true,

  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),
  setCurrentTime: (currentTime) => set({ currentTime }),

  toggleHabitat: (key) =>
    set((s) => ({
      habitatLayers: { ...s.habitatLayers, [key]: !s.habitatLayers[key] },
    })),
  setHabitatLoading: (key, isLoading) =>
    set((s) => ({
      habitatLoading: { ...s.habitatLoading, [key]: isLoading },
    })),

  updateTideStation: async (mapCenter) => {
    const station = getNearestStation(mapCenter.lat, mapCenter.lon)
    const cur = get().currentStation
    // Same station and we already have predictions → nothing to do. Re-fetching
    // is harmless (SWR cache covers it) but skipping avoids loading-flash churn
    // on every micro-pan.
    if (cur.id === station.id && get().tidePredictions.length > 0) {
      return
    }
    set({ currentStation: station, tideLoading: true })
    try {
      const predictions = await fetchTidePredictions(station.id, new Date())
      set({ tidePredictions: predictions, tideLoading: false })
    } catch (e) {
      console.error('[store] updateTideStation failed:', e)
      set({ tidePredictions: [], tideLoading: false })
    }
  },
}))
