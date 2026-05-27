import { create } from 'zustand'
import type { LatLon } from '@/types'

const PERDIDO_BAY: LatLon = { lat: 30.317, lon: -87.436 }
const DEFAULT_ZOOM = 12

type BitePlanState = {
  center: LatLon
  zoom: number
  currentTime: Date
  setCenter: (center: LatLon) => void
  setZoom: (zoom: number) => void
  setCurrentTime: (currentTime: Date) => void
}

export const useBitePlanStore = create<BitePlanState>((set) => ({
  center: PERDIDO_BAY,
  zoom: DEFAULT_ZOOM,
  currentTime: new Date(),
  setCenter: (center) => set({ center }),
  setZoom: (zoom) => set({ zoom }),
  setCurrentTime: (currentTime) => set({ currentTime }),
}))
