/**
 * Bottom sheet (Step 16 + Step 22 follow-ups) — 4-snap-point mobile UI.
 *
 * Replaces the floating panels from Steps 5–15. Four snap points:
 *
 *   Handle (~36px on every screen): DEFAULT. Just the drag pill + a few
 *                px of slate background. Map dominates the screen.
 *   Peek (10vh): tide pill + conditions score + time indicator. Secondary
 *                state reachable by drag — not the default.
 *   Half (50vh): time strip, top zones list, tier + species filters.
 *   Full (70vh): layer toggles, depth filter, Trip toggle, saved
 *                waypoints list, settings. Capped at 70vh so the map
 *                stays visible above the sheet even at maximum extent;
 *                internal scrolling reaches the bottom of the content.
 *
 * Drag-vs-scroll separation (critical for one-handed mobile use):
 *
 *   DRAG ZONE   — the header strip with the grab pill. Has pointer
 *                 handlers + `touch-action: none` so the browser yields
 *                 vertical gestures to our snap logic. Dragging here
 *                 NEVER touches the content's scroll position; content
 *                 scrollTop is preserved across snap transitions because
 *                 React doesn't unmount or reset it.
 *   SCROLL ZONE — the children area. Has `overflow-y-auto` + a
 *                 `touch-action: pan-y` so the browser handles native
 *                 vertical scroll. `overscroll-behavior: contain` keeps
 *                 over-scroll out of the page body (no pull-to-refresh,
 *                 no map-pan leakage). NO pointer-event handlers here —
 *                 scrolling content cannot accidentally drag the sheet.
 *   CLOSE       — a separate absolutely-positioned X button at top-right.
 *                 Visible at peek/half/full (hidden at handle). Tapping
 *                 it collapses to `'handle'`, providing an explicit
 *                 affordance alongside drag-down and tap-map.
 *
 * Gesture model: drag the handle pill (or anywhere on the header strip)
 * with a pointer. While dragging, the sheet height tracks the pointer.
 * On release we snap to the nearest snap point, with a velocity-aware
 * bypass — a fast upward flick from Handle can land on Full directly.
 * Snap is persisted to `settings:sheetSnap`.
 *
 * Tap-to-dismiss: in MapView.tsx, a Leaflet `click` event on bare map
 * snaps the sheet back to `'handle'`. Tapping the handle row when
 * collapsed expands to Half.
 *
 * Implementation notes:
 *   - Height-based animation via CSS transitions on the container.
 *     React only updates state on pointer release; the active-drag
 *     height lives in a ref + raw inline style to avoid re-renders
 *     during the gesture.
 *   - Full-snap-only sections render lazily via `everOpenedFull` — once
 *     the user has reached Full, those components remain mounted so a
 *     second trip to Full feels instant.
 *   - z-30 sits above the map but below the popups (popup layer uses
 *     z-1100+ to overlay the sheet).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { GripHorizontal, X as XIcon } from 'lucide-react'
import { useBitePlanStore, type SheetSnapPoint } from '@/store/useBitePlanStore'

// Snap heights in vh. Handle is a hardcoded pixel value translated to vh on
// the fly — see resolvedHandleVh — so the thin tab is the same physical
// size across phones regardless of screen height. Full was reduced from
// 90 → 70 in the second Step 22 follow-up so the map stays partly visible
// even at maximum sheet extent; the content scrolls internally.
const HANDLE_PX = 36
const SNAP_HEIGHTS: Record<Exclude<SheetSnapPoint, 'handle'>, number> = {
  peek: 10,
  half: 50,
  full: 70,
}
const SNAP_ORDER: SheetSnapPoint[] = ['handle', 'peek', 'half', 'full']
// Velocity threshold for a flick that bypasses the nearest snap. Tuned by
// feel — slower than this and we just nearest-snap; faster and we commit
// to the next snap in the swipe direction.
const VELOCITY_FLICK_PX_MS = 0.6

type Props = {
  children: React.ReactNode
}

function BottomSheet({ children }: Props) {
  const snap = useBitePlanStore((s) => s.sheetSnapPoint)
  const setSnap = useBitePlanStore((s) => s.setSheetSnapPoint)
  // Step 18: hide the sheet entirely (translate off-screen + opacity 0)
  // when On-Water Mode is active. We keep it mounted so internal state
  // — slider position, scroll position, etc. — is preserved.
  const onWater = useBitePlanStore((s) => s.onWaterMode)

  // Lazy-mount flag for Full-only content. Flipped once on first reach.
  const [everOpenedFull, setEverOpenedFull] = useState(snap === 'full')
  useEffect(() => {
    if (snap === 'full' && !everOpenedFull) setEverOpenedFull(true)
  }, [snap, everOpenedFull])

  // Drag state lives in refs so pointermove doesn't re-render React.
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const dragStartY = useRef<number | null>(null)
  const dragStartTime = useRef<number>(0)
  const dragStartHeightVh = useRef<number>(0)
  const lastMoveY = useRef<number>(0)
  const lastMoveTime = useRef<number>(0)

  // Resolve Handle's px height into vh for the duration of this render.
  // Window height can change (rotation, mobile address bar) so we compute
  // it inline rather than caching. Defensive fallback prevents divide-by-
  // zero in unusual SSR-like contexts.
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800
  const resolvedHandleVh = (HANDLE_PX / Math.max(1, winH)) * 100

  /** Height in vh for a given snap. Handle resolves dynamically; the rest
   *  are constants. */
  const heightForSnap = (s: SheetSnapPoint): number =>
    s === 'handle' ? resolvedHandleVh : SNAP_HEIGHTS[s]

  // Convert px → vh and clamp into the [handle, full] range so the gesture
  // can't pull the sheet outside its design envelope.
  const pxToVh = (px: number) => (px / window.innerHeight) * 100
  const clampVh = (vh: number) =>
    Math.max(resolvedHandleVh, Math.min(SNAP_HEIGHTS.full, vh))

  // Apply a height directly to the element during drag — bypasses React
  // for the smoothest animation. Also disables the CSS transition for the
  // duration of the gesture so the sheet sticks to the finger.
  const applyTransientHeight = useCallback((vh: number) => {
    const el = sheetRef.current
    if (!el) return
    el.style.transition = 'none'
    el.style.height = `${vh}vh`
  }, [])

  const commitSnap = useCallback(
    (target: SheetSnapPoint) => {
      const el = sheetRef.current
      if (el) {
        // Re-enable the transition so the snap is smooth, and apply the
        // target height inline so the browser NEVER sees an intermediate
        // empty-height frame. If we cleared height to '' here instead,
        // the layout would briefly collapse to content-auto before React
        // re-rendered with the new vh value; during that frame the
        // browser would clamp the scroll-area's scrollTop to 0 (since the
        // scroll area momentarily has no overflow). That broke the
        // "content scroll position should survive a snap change" safety
        // rule. Setting the explicit height inline means the snap is one
        // seamless animation from old height to new height with the
        // scroll position untouched.
        el.style.transition = ''
        el.style.height =
          target === 'handle'
            ? `${HANDLE_PX}px`
            : `${SNAP_HEIGHTS[target]}vh`
      }
      setSnap(target)
    },
    [setSnap],
  )

  const [grabbing, setGrabbing] = useState(false)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only react to the primary button / first touch.
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    dragStartY.current = e.clientY
    dragStartTime.current = performance.now()
    dragStartHeightVh.current = heightForSnap(snap)
    lastMoveY.current = e.clientY
    lastMoveTime.current = dragStartTime.current
    setGrabbing(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartY.current == null) return
    const dy = e.clientY - dragStartY.current
    // Dragging the handle DOWN should shrink the sheet (height decreases);
    // dragging UP should grow it.
    const nextVh = clampVh(dragStartHeightVh.current - pxToVh(dy))
    applyTransientHeight(nextVh)
    lastMoveY.current = e.clientY
    lastMoveTime.current = performance.now()
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setGrabbing(false)
    if (dragStartY.current == null) return
    const startY = dragStartY.current
    dragStartY.current = null
    const releaseY = e.clientY
    const releaseTime = performance.now()
    const totalDy = releaseY - startY
    const releaseHeightVh = clampVh(dragStartHeightVh.current - pxToVh(totalDy))
    // Velocity over the LAST ~80 ms (more responsive than averaging the
    // whole drag — a slow drag that ends in a flick should still trigger
    // the bypass).
    const recentDy = releaseY - lastMoveY.current
    const recentDt = Math.max(1, releaseTime - lastMoveTime.current)
    const velocity = recentDy / recentDt // px / ms (positive = downward)

    // Decide the target snap. Default = nearest by absolute height.
    let target: SheetSnapPoint = nearestSnap(releaseHeightVh, resolvedHandleVh)
    if (Math.abs(velocity) >= VELOCITY_FLICK_PX_MS) {
      // Flick — move at least one snap in the gesture direction.
      const currentIdx = SNAP_ORDER.indexOf(snap)
      const dir = velocity < 0 ? +1 : -1 // upward swipe → bigger snap
      const idx = Math.max(0, Math.min(SNAP_ORDER.length - 1, currentIdx + dir))
      target = SNAP_ORDER[idx]
      // Strong flick can skip steps — e.g. handle → full or full → handle.
      if (Math.abs(velocity) >= VELOCITY_FLICK_PX_MS * 1.7) {
        target = dir > 0 ? 'full' : 'handle'
      }
    }
    commitSnap(target)
  }

  // Tapping (no drag) on the header expands a collapsed sheet. From either
  // Handle or Peek a tap goes to Half (the user clearly wants to see
  // something). We detect "tap" as negligible movement + short duration,
  // which is implicit here because onClick only fires when no drag-cancel
  // happened.
  const onHeaderClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // If the click bubbled up from an actionable child, don't toggle.
    if ((e.target as HTMLElement).closest('button, a, input, [role="button"]')) return
    if (snap === 'handle' || snap === 'peek') {
      commitSnap('half')
    }
  }

  // Keyboard accessibility per spec: Escape steps down through the snap
  // order (Full → Half → Peek → Handle), then no-ops at Handle. Alt+Arrow
  // continues to cycle through the full snap order in either direction.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        const idx = SNAP_ORDER.indexOf(snap)
        if (idx > 0) commitSnap(SNAP_ORDER[idx - 1])
      } else if (e.key === 'ArrowUp' && e.altKey) {
        // Alt+ArrowUp moves up one snap (don't hijack default Up).
        e.preventDefault()
        const idx = SNAP_ORDER.indexOf(snap)
        if (idx < SNAP_ORDER.length - 1) commitSnap(SNAP_ORDER[idx + 1])
      } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault()
        const idx = SNAP_ORDER.indexOf(snap)
        if (idx > 0) commitSnap(SNAP_ORDER[idx - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snap, commitSnap])

  return (
    <aside
      ref={sheetRef}
      aria-label="Bottom sheet"
      aria-expanded={snap !== 'handle'}
      data-snap={snap}
      // Centered + max-width on tablet+; full-width on mobile per spec.
      // touch-action: none so the browser doesn't fight our pointer drag.
      // overscroll-contain prevents scroll chaining into the map.
      className={
        'fixed inset-x-0 bottom-0 z-30 mx-auto w-full sm:max-w-[480px] ' +
        'bg-slate-900 text-slate-100 rounded-t-2xl shadow-2xl ' +
        'border-t border-slate-700/60 ' +
        // Step 21: cubic-bezier(0.32, 0.72, 0, 1) is the iOS-sheet snap
        // curve — feels more native than the prior ease-out.
        'transition-[height,transform,opacity] duration-300 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] overflow-hidden ' +
        'flex flex-col'
      }
      style={{
        height: snap === 'handle' ? `${HANDLE_PX}px` : `${SNAP_HEIGHTS[snap]}vh`,
        // On-Water Mode: slide off-screen + fade. Pointer events off so
        // taps go through to the map below.
        transform: onWater ? 'translateY(100%)' : undefined,
        opacity: onWater ? 0 : undefined,
        pointerEvents: onWater ? 'none' : undefined,
      }}
    >
      {/* Header strip — the DRAG ZONE. The grab handle pill in the centre
          gives the user a visual affordance; the entire row accepts
          pointer events so the gesture works wherever the user grabs.
          touch-action: none disables built-in vertical scroll INSIDE the
          drag zone only; the content area below explicitly opts back into
          pan-y so its native scroll still works. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onHeaderClick}
        role="separator"
        aria-orientation="horizontal"
        aria-valuetext={snap}
        className="shrink-0 cursor-grab active:cursor-grabbing select-none py-2 flex flex-col items-center gap-1"
        style={{ touchAction: 'none' }}
      >
        <div
          aria-hidden
          className={
            'biteplan-sheet-handle w-12 h-1.5 bg-slate-600 rounded-full ' +
            (grabbing ? 'biteplan-sheet-handle--grabbing' : '')
          }
        />
        {/* Visually-hidden text describes the gesture to screen readers. */}
        <span className="sr-only">
          Drag to resize. Current snap: {snap}.
          <GripHorizontal className="size-3 inline" aria-hidden />
        </span>
      </div>

      {/* X close button — second Step 22 follow-up. Hidden at handle
          (where there's no panel to close) and in On-Water Mode (where
          the sheet is translated off-screen). Absolutely positioned at
          the top-right so it sits OUTSIDE the drag zone — taps on it
          can never start a sheet drag. */}
      {snap !== 'handle' && !onWater && (
        <button
          type="button"
          aria-label="Hide panel"
          onClick={() => commitSnap('handle')}
          className={
            'absolute top-1.5 right-2 z-10 size-9 inline-flex items-center justify-center ' +
            'rounded-full text-slate-400 transition-colors ' +
            'hover:text-slate-100 hover:bg-slate-800/70 ' +
            'focus-visible:bg-slate-800 focus-visible:outline-none'
          }
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      )}

      {/* Scrollable content — the SCROLL ZONE. Children compose Peek,
          Half, Full sections in order. The parent's height clip is what
          hides the lower sections when collapsed. No pointer-event
          handlers here, so scrolling content cannot accidentally drag
          the sheet. `touch-action: pan-y` explicitly grants the browser
          native vertical pan so iOS doesn't fall back to the parent
          `touch-action: none` from the drag zone. `overscroll-contain`
          stops the scroll from chaining into the page body (no
          pull-to-refresh, no map pan leakage). */}
      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pb-[max(env(safe-area-inset-bottom,0),0.5rem)]"
        style={{ touchAction: 'pan-y' }}
      >
        {children}
        {/* Pass-through so children can branch on the lazy-mount flag.
            We can't pass via React context cleanly without a wrapper,
            so we expose it via a data-attribute the children can read.
            (Children that need it use useBitePlanStore's sheetSnapPoint.) */}
        <input
          type="hidden"
          data-ever-opened-full={everOpenedFull ? 'true' : 'false'}
          tabIndex={-1}
        />
      </div>
    </aside>
  )
}

/** Pick the closest of the four snap heights to `vh`. Handle's vh height
 *  is dynamic (depends on viewport height) so it's passed in. */
function nearestSnap(vh: number, handleVh: number): SheetSnapPoint {
  let best: SheetSnapPoint = 'half'
  let bestDist = Infinity
  for (const s of SNAP_ORDER) {
    const target = s === 'handle' ? handleVh : SNAP_HEIGHTS[s]
    const d = Math.abs(vh - target)
    if (d < bestDist) {
      bestDist = d
      best = s
    }
  }
  return best
}

export default BottomSheet
