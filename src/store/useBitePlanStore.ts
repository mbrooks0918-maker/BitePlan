import { create } from 'zustand'
import type { LatLon } from '@/types'

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
  // Per-layer loading state, set while a lazy fetch is in flight on first
  // toggle. Used by the dev toggle panel to show a "Loading..." hint.
  habitatLoading: HabitatFlags

  setCenter: (center: LatLon) => void
  setZoom: (zoom: number) => void
  setCurrentTime: (currentTime: Date) => void
  toggleHabitat: (key: HabitatKey) => void
  setHabitatLoading: (key: HabitatKey, isLoading: boolean) => void
}

export const useBitePlanStore = create<BitePlanState>((set) => ({
  center: PERDIDO_BAY,
  zoom: DEFAULT_ZOOM,
  currentTime: new Date(),

  habitatLayers: { seagrass: false, oysters: false, wetlands: false },
  habitatLoading: { seagrass: false, oysters: false, wetlands: false },

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
}))
