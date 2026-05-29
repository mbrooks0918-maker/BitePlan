/**
 * Named-anchor popup (Step 12.5).
 *
 * Sibling to ZonePopup. Shown when `selectedAnchor` is non-null. Same
 * slide-up backdrop pattern as ZonePopup but the content is a simple
 * fact-sheet — name, type, depth, materials, year — with a Directions CTA.
 * No score, no factors. This is identity, not scoring.
 */

import { useEffect, useId, useRef } from 'react'
import { Navigation, X as XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useBitePlanStore } from '@/store/useBitePlanStore'
import type { AnchorType } from '@/lib/anchors'

const TYPE_LABEL: Record<AnchorType, string> = {
  amrd_reef: 'Verified AMRD structure',
  restoration: 'Restoration anchor',
  living_shoreline: 'Living shoreline',
  park_reef: 'Park-managed reef',
  launch: 'Launch point',
}

const TYPE_BG: Record<AnchorType, string> = {
  amrd_reef: 'bg-cyan-700',
  restoration: 'bg-violet-700',
  living_shoreline: 'bg-emerald-700',
  park_reef: 'bg-blue-700',
  launch: 'bg-amber-700',
}

function AnchorPopup() {
  const selected = useBitePlanStore((s) => s.selectedAnchor)
  const selectAnchor = useBitePlanStore((s) => s.selectAnchor)
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (selected) closeRef.current?.focus()
  }, [selected])

  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        selectAnchor(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, selectAnchor])

  if (!selected) return null

  const onDirections = () => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${selected.lat},${selected.lon}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[1100] bg-black/40"
      onClick={() => selectAnchor(null)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-x-0 bottom-0 mx-auto w-full sm:max-w-md bg-slate-900 text-slate-100 rounded-t-2xl shadow-2xl overflow-hidden"
      >
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1 w-10 rounded-full bg-slate-600" />
        </div>
        <header
          className={`flex items-center justify-between px-4 py-3 text-white ${TYPE_BG[selected.type]}`}
        >
          <div>
            <h2 id={titleId} className="text-base font-bold tracking-wide">
              {selected.name}
            </h2>
            <div className="text-[11px] opacity-80">{TYPE_LABEL[selected.type]}</div>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={() => selectAnchor(null)}
            className="size-11 flex items-center justify-center rounded-full hover:bg-white/15 focus-visible:bg-white/15 focus-visible:outline-none"
          >
            <XIcon className="size-5" />
          </button>
        </header>

        <section className="px-4 py-3 space-y-2 text-sm">
          {(selected.depthFt != null || selected.acres != null || selected.yearBuilt != null) && (
            <div className="grid grid-cols-3 gap-3 text-center">
              {selected.depthFt != null && (
                <div>
                  <div className="text-lg font-semibold tabular-nums">{selected.depthFt}</div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">Depth (ft)</div>
                </div>
              )}
              {selected.acres != null && (
                <div>
                  <div className="text-lg font-semibold tabular-nums">{selected.acres}</div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">Acres</div>
                </div>
              )}
              {selected.yearBuilt != null && (
                <div>
                  <div className="text-lg font-semibold tabular-nums">{selected.yearBuilt}</div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">Built</div>
                </div>
              )}
            </div>
          )}
          {selected.material && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Material</div>
              <div className="text-slate-200">{selected.material}</div>
            </div>
          )}
          {selected.notes && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Notes</div>
              <div className="text-slate-200">{selected.notes}</div>
            </div>
          )}
          <div className="text-[10px] text-slate-400 pt-1">
            {selected.lat.toFixed(5)}, {selected.lon.toFixed(5)}
          </div>
        </section>

        <div className="px-4 pb-4 pt-2 border-t border-slate-800">
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={onDirections}
            className="h-12 w-full text-sm font-semibold border-slate-600 bg-transparent text-slate-100 hover:bg-slate-800 hover:text-slate-100"
          >
            <Navigation className="size-4" />
            Directions
          </Button>
        </div>
      </div>
    </div>
  )
}

export default AnchorPopup
