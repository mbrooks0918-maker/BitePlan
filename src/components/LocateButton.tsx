/**
 * LocateButton (Step 17).
 *
 * Floating GPS toggle in the top-right of the map. Three visual states
 * track the store's `locationStatus`:
 *
 *   off    — neutral slate, `Locate` icon
 *   on     — blue, `LocateFixed` icon (actively tracking)
 *   denied — red-tint, `LocateOff` icon
 *
 * Tap dispatch:
 *
 *   off                       → request permission + start watch
 *   on, not centred on user   → pan to current GPS position (no zoom change)
 *   on, already centred       → stop tracking entirely
 *   denied                    → toast: "Location access denied…"
 *
 * The Permissions API probe runs once on mount so a previously-denied
 * user sees the denied state immediately without needing to tap. We never
 * auto-start tracking on a previously-granted permission — battery
 * courtesy per the handoff doc.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Locate, LocateFixed, LocateOff } from 'lucide-react'
import { useMap } from 'react-leaflet'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import {
  isViewCenteredOnUser,
  probePermissionsOnMount,
  requestLocation,
  setLocateToastEmitter,
  stopLocationTracking,
} from '@/lib/geolocation'

const TOAST_MS = 4_000

function LocateButton() {
  const status = useBitePlanStore((s) => s.locationStatus)
  const loc = useBitePlanStore((s) => s.userLocation)
  const map = useMap()

  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  // Register the toast emitter so error paths in lib/geolocation can
  // surface user-facing messages. Unhook on unmount.
  useEffect(() => {
    setLocateToastEmitter((msg) => {
      setToast(msg)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS)
    })
    return () => {
      setLocateToastEmitter(null)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  // Permissions probe — sets 'denied' state if the user has previously
  // refused so the button renders the red icon on first paint.
  useEffect(() => {
    void probePermissionsOnMount()
  }, [])

  const onTap = useCallback(() => {
    if (status === 'denied') {
      setToast('Location access denied. Enable in browser settings to use Locate Me.')
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS)
      return
    }
    if (status === 'on') {
      // Pan-or-stop: if the view is already centred (within ~10m), the
      // user clearly wants tracking off; otherwise re-centre.
      const center = map.getCenter()
      if (loc && isViewCenteredOnUser({ lat: center.lat, lon: center.lng }, loc)) {
        stopLocationTracking()
      } else if (loc) {
        map.panTo([loc.lat, loc.lon], { animate: true, duration: 0.8 })
      }
      return
    }
    // off / error / requesting → trigger a fresh request. The geolocation
    // module's requestLocation handles the prompt + watch arming.
    requestLocation()
  }, [status, loc, map])

  let bg = 'bg-slate-800 hover:bg-slate-700 text-slate-200'
  let Icon = Locate
  let aria = 'Show my location'
  if (status === 'on') {
    bg = 'bg-blue-600 hover:bg-blue-500 text-white'
    Icon = LocateFixed
    aria = 'Re-centre on my location (tap again while centred to stop)'
  } else if (status === 'denied') {
    bg = 'bg-red-900/80 hover:bg-red-900 text-red-200'
    Icon = LocateOff
    aria = 'Location access denied'
  } else if (status === 'requesting') {
    bg = 'bg-slate-700 text-slate-300 animate-pulse'
    Icon = Locate
    aria = 'Requesting GPS…'
  } else if (status === 'error') {
    bg = 'bg-amber-900/70 hover:bg-amber-800 text-amber-200'
    Icon = LocateOff
    aria = 'GPS unavailable — tap to retry'
  }

  return (
    <>
      <button
        type="button"
        onClick={onTap}
        aria-label={aria}
        title={aria}
        // top-4 right-4 z-[1000] — same layer the DevLayerPanel used to
        // occupy. Sits above the Leaflet zoom controls (z 800-1000) so the
        // user can always reach it.
        className={
          'fixed top-4 right-4 z-[1000] size-12 rounded-full shadow-lg ' +
          'flex items-center justify-center backdrop-blur-sm ' +
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ' +
          bg
        }
      >
        <Icon className="size-5" aria-hidden />
      </button>
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-20 right-4 z-[1100] max-w-xs bg-slate-900/95 text-slate-100 rounded-md shadow-xl border border-slate-700/60 px-3 py-2 text-xs"
        >
          {toast}
        </div>
      )}
    </>
  )
}

export default LocateButton
