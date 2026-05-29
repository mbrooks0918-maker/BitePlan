/**
 * PWA install + update prompt (Step 19).
 *
 * Three independent surfaces share this file because they're all tiny
 * cards that float in the corners of the screen:
 *
 *   - UpdatePrompt: shows when vite-plugin-pwa reports a waiting SW
 *     (i.e. an updated build has been precached but the user is still
 *     running the previous version). Tap → SW skipWaiting + reload.
 *
 *   - InstallPrompt: hand-rolled add-to-home prompt for iOS Safari (the
 *     OS does not auto-prompt for PWA install). For Chromium-flavoured
 *     browsers we capture `beforeinstallprompt` and offer a native
 *     dialog through it. Dismissal persists for 30 days via localStorage.
 *
 *   - OfflineIndicator: small pill under the tide pill, only visible
 *     when `navigator.onLine === false`. Sun-readable per the on-water
 *     readout palette so it works in either mode.
 *
 * The "Install App" entry in Settings (rendered in BottomSheet/SheetContent)
 * imports {requestInstall, isInstalled} from this file so the user can
 * trigger the same flow on demand even after dismissing the auto-prompt.
 */
import { useEffect, useRef, useState } from 'react'
import { CloudOff, Download, RotateCcw, Share, X as XIcon } from 'lucide-react'

// ---- standalone-mode detection ------------------------------------------

/** True when the app is already running as an installed PWA (iOS or
 *  Chromium). Used to hide install affordances post-install. */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false
  // Chromium / Android
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  // iOS Safari (legacy non-standard but still the canonical check)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const n = window.navigator as any
  if (typeof n.standalone === 'boolean' && n.standalone) return true
  return false
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua)
  return ios
}

// ---- beforeinstallprompt capture ----------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deferredPrompt: any = null

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
  })
}

/**
 * Imperative entry point used by the Settings "Install App" row. Fires
 * the beforeinstallprompt flow on Chromium; on iOS Safari returns
 * `'show-ios-instructions'` so the caller can render the manual card.
 */
export async function requestInstall(): Promise<'installed' | 'dismissed' | 'show-ios-instructions' | 'unavailable'> {
  if (isInstalled()) return 'unavailable'
  if (deferredPrompt) {
    deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice
    const outcome = choice?.outcome
    deferredPrompt = null
    return outcome === 'accepted' ? 'installed' : 'dismissed'
  }
  if (isIosSafari()) return 'show-ios-instructions'
  return 'unavailable'
}

// ---- iOS install prompt -------------------------------------------------

const DISMISS_KEY = 'install:dismissedAt'
const DISMISS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const FIRST_VISIT_DELAY_MS = 30 * 1000 // 30 seconds

function isDismissedRecently(): boolean {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY)
    if (!raw) return false
    const at = Number(raw)
    if (!Number.isFinite(at)) return false
    return Date.now() - at < DISMISS_WINDOW_MS
  } catch {
    return false
  }
}

function markDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {}
}

/**
 * iOS Safari card — shows the user how to add the app to their home
 * screen via Share → Add to Home Screen. Auto-shows after 30 s on first
 * visit; dismissal persists for 30 days.
 *
 * Also covers the manual-trigger path from Settings (when the user has
 * dismissed once but later asks for it). The trigger sets `forceShow`
 * which bypasses the dismiss-recently gate.
 */
function IosInstallCard({
  forceShow,
  onClose,
}: {
  forceShow: boolean
  onClose: () => void
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (forceShow) {
      setOpen(true)
      return
    }
    if (!isIosSafari()) return
    if (isInstalled()) return
    if (isDismissedRecently()) return
    timer.current = window.setTimeout(() => setOpen(true), FIRST_VISIT_DELAY_MS)
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    }
  }, [forceShow])

  if (!open) return null

  const dismiss = () => {
    markDismissed()
    setOpen(false)
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-label="Install BitePlan to your home screen"
      className={
        'fixed left-1/2 -translate-x-1/2 top-4 z-[1300] w-[min(92vw,28rem)] ' +
        'bg-slate-900/95 text-slate-100 rounded-xl shadow-2xl border border-slate-700/60 ' +
        'backdrop-blur-sm px-4 py-3'
      }
    >
      <div className="flex items-start gap-3">
        <Share className="size-5 text-blue-400 mt-0.5 shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold leading-snug">
            Add BitePlan to your home screen for offline fishing.
          </div>
          <div className="text-xs text-slate-400 mt-1 leading-snug">
            Tap the <span className="text-slate-200 font-medium">Share</span> icon
            in Safari then <span className="text-slate-200 font-medium">‘Add to Home Screen’</span>.
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss install prompt"
          onClick={dismiss}
          className="shrink-0 size-8 -mr-1 rounded-full hover:bg-slate-800 flex items-center justify-center"
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  )
}

// ---- Service-worker update banner ---------------------------------------

/**
 * When vite-plugin-pwa precaches a new build, the new SW enters a
 * "waiting" state until the page reloads. We surface a small banner the
 * user can tap to reload-with-update at their convenience.
 *
 * `virtual:pwa-register` is a plugin-injected module that exists only in
 * production builds. We dynamic-import it lazily so dev (with the plugin
 * but no real SW) and any environment without the plugin both no-op
 * silently. The returned `registerSW` is imperative — no React hook
 * required.
 */
function UpdateBanner() {
  const [waiting, setWaiting] = useState(false)
  const updateSWRef = useRef<((reload?: boolean) => Promise<void>) | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const mod = (await import(
          /* @vite-ignore */
          'virtual:pwa-register'
        )) as {
          registerSW: (opts?: {
            onNeedRefresh?: () => void
            onOfflineReady?: () => void
            onRegistered?: (r?: ServiceWorkerRegistration) => void
            onRegisterError?: (e: unknown) => void
          }) => (reloadPage?: boolean) => Promise<void>
        }
        if (cancelled) return
        updateSWRef.current = mod.registerSW({
          onNeedRefresh: () => setWaiting(true),
          // Future improvement: confirm "ready offline" once on first
          // install. Silent for now — the Install Prompt + Offline pill
          // already give the user feedback at the right moments.
        })
      } catch {
        // No virtual module — dev mode or non-PWA build. Silent.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!waiting) return null

  const reload = async () => {
    try {
      // updateSW(true) skipWaiting + reload — but explicit reload is more
      // reliable across browsers if the plugin call no-ops.
      if (updateSWRef.current) await updateSWRef.current(true)
    } finally {
      window.location.reload()
    }
  }

  return (
    <button
      type="button"
      onClick={reload}
      className={
        'fixed left-1/2 -translate-x-1/2 top-4 z-[1300] w-[min(92vw,24rem)] ' +
        'bg-blue-600 hover:bg-blue-500 text-white rounded-lg shadow-2xl ' +
        'px-4 py-3 flex items-center justify-between gap-2'
      }
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <RotateCcw className="size-4" aria-hidden />
        BitePlan updated — tap to reload.
      </span>
    </button>
  )
}

// ---- Offline indicator pill --------------------------------------------

export function OfflineIndicator() {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)
  useEffect(() => {
    const on = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  if (!offline) return null

  // The pill sits in the bottom-sheet's content stack just under the
  // ConditionsPanel — when in On-Water Mode the sheet is hidden so this
  // pill is hidden too, which is fine: the tide pill keeps showing the
  // last cached data.
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        'flex items-center gap-2 mx-1 mb-2 rounded-md ' +
        'bg-amber-900/40 border border-amber-700/40 text-amber-100 ' +
        'px-3 py-1.5 text-xs font-medium'
      }
    >
      <CloudOff className="size-3.5" aria-hidden />
      Offline mode — using cached data
    </div>
  )
}

// ---- Settings "Install App" row -----------------------------------------

export function InstallAppButton() {
  const [iosForceShow, setIosForceShow] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)

  if (isInstalled()) return null

  const trigger = async () => {
    const result = await requestInstall()
    if (result === 'show-ios-instructions') {
      setIosForceShow(true)
    } else if (result === 'installed') {
      setOutcome('Installed — reopen from your home screen.')
    } else if (result === 'unavailable') {
      setOutcome('Install not available in this browser.')
    } else if (result === 'dismissed') {
      setOutcome(null)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={trigger}
        className={
          'w-full min-h-[44px] rounded-md bg-slate-800/40 hover:bg-slate-800 ' +
          'border border-slate-800 text-slate-100 text-sm font-medium ' +
          'px-3 py-2 flex items-center justify-between gap-2 transition-colors'
        }
      >
        <span className="flex items-center gap-2">
          <Download className="size-4" aria-hidden />
          Install App
        </span>
        <span className="text-xs text-slate-400">offline-ready</span>
      </button>
      {outcome && <div className="text-xs text-slate-400 mt-2 px-1">{outcome}</div>}
      {iosForceShow && <IosInstallCard forceShow onClose={() => setIosForceShow(false)} />}
    </>
  )
}

// ---- Composite mount ---------------------------------------------------

function InstallPrompt() {
  return (
    <>
      <UpdateBanner />
      <IosInstallCard forceShow={false} onClose={() => {}} />
    </>
  )
}

export default InstallPrompt
