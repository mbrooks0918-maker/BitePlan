/**
 * Base layer switcher (Step 22 follow-up).
 *
 * Top-right floating button positioned BELOW the LocateButton. Tap to
 * expand a small panel of three radio-style options:
 *
 *   - NOAA Chart       (paper-chart symbology, default)
 *   - NOAA ENC         (vector S-52 / ECDIS)
 *   - Satellite        (Esri World Imagery)
 *
 * Visual aesthetic mirrors LocateButton + the bottom sheet — slate-800,
 * rounded, shadow-lg, backdrop-blur. The 44×44 hit target on both the
 * collapsed button and each expanded row keeps it usable with a thumb.
 *
 * Positioning:
 *   - LocateButton: fixed top-4 right-4 z-[1000], size-12 normally /
 *                   size-14 in On-Water Mode.
 *   - Switcher button: fixed below the LocateButton in the same right
 *                      column, with an 8px gap. We read `onWaterMode`
 *                      so the spacing adapts when LocateButton grows.
 *
 * Z-order:
 *   - Closed button: z-[1000], same as LocateButton.
 *   - Open panel:    z-[1001], so it sits above neighbouring controls
 *                    without fighting the popup layer (z-1100+).
 *
 * Outside-tap dismissal is wired via a document-level pointerdown
 * listener that only fires when the panel is open. We intentionally use
 * pointerdown (not click) so the dismiss races AGAINST any subsequent
 * tap on the map — that way one tap can both close the panel and dismiss
 * the sheet via MapTapDismiss.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Layers, X as XIcon } from 'lucide-react'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import { BASE_LAYER_CONFIG, BASE_LAYER_ORDER } from './baseLayers'

function BaseLayerSwitcher() {
  const baseLayer = useBitePlanStore((s) => s.baseLayer)
  const setBaseLayer = useBitePlanStore((s) => s.setBaseLayer)
  const onWater = useBitePlanStore((s) => s.onWaterMode)

  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Vertical offset below the LocateButton:
  //   top-4 (16px) + LocateButton (48px / 56px in On-Water) + 8px gap
  const topPx = onWater ? 80 : 72

  // Outside-tap dismissal.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!containerRef.current) return
      if (e.target instanceof Node && containerRef.current.contains(e.target)) return
      setOpen(false)
    }
    // Escape also closes — keyboard parity with the bottom sheet.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onPick = (next: typeof baseLayer) => {
    if (next !== baseLayer) setBaseLayer(next)
    setOpen(false)
  }

  return (
    <div
      ref={containerRef}
      className="fixed right-4 z-[1000]"
      style={{ top: `${topPx}px` }}
    >
      <button
        type="button"
        aria-label={open ? 'Close map style picker' : 'Change map style'}
        aria-expanded={open}
        title="Change map style"
        onClick={() => setOpen((v) => !v)}
        className={
          'size-11 rounded-full shadow-lg flex items-center justify-center backdrop-blur-sm ' +
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ' +
          'border border-slate-700/60 ' +
          (open
            ? 'bg-slate-900/95 text-slate-100 hover:bg-slate-800'
            : 'bg-slate-800/80 text-slate-200 hover:bg-slate-700/90')
        }
      >
        {open ? (
          <XIcon className="size-5" aria-hidden />
        ) : (
          <Layers className="size-5" aria-hidden />
        )}
      </button>

      {open && (
        <div
          role="radiogroup"
          aria-label="Map style"
          className={
            'absolute right-0 mt-2 w-56 bg-slate-900/95 text-slate-100 ' +
            'rounded-xl shadow-2xl border border-slate-700/60 backdrop-blur-sm ' +
            'overflow-hidden z-[1001]'
          }
        >
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-400">
            Map style
          </div>
          <ul className="divide-y divide-slate-800/80">
            {BASE_LAYER_ORDER.map((key) => {
              const spec = BASE_LAYER_CONFIG[key]
              const selected = baseLayer === key
              return (
                <li key={key}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onPick(key)}
                    className={
                      'w-full min-h-[52px] px-3 py-2 flex items-center gap-3 text-left ' +
                      'transition-colors ' +
                      (selected
                        ? 'bg-slate-800/80 hover:bg-slate-800'
                        : 'hover:bg-slate-800/60')
                    }
                  >
                    <span
                      aria-hidden
                      className="size-6 shrink-0 rounded-md ring-1 ring-slate-600"
                      style={{ backgroundColor: spec.swatch }}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-slate-100 truncate">
                        {spec.label}
                      </span>
                      <span className="block text-[11px] text-slate-400 leading-snug truncate">
                        {spec.description}
                      </span>
                    </span>
                    {selected && (
                      <Check
                        className="size-4 text-blue-400 shrink-0"
                        aria-hidden
                      />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

export default BaseLayerSwitcher
