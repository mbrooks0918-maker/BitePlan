/**
 * LayerToggles (Step 16 — Full snap section).
 *
 * Consolidates everything that previously lived in DevLayerPanel + the
 * scattered controls:
 *
 *   - Habitat polygon visibility (Seagrass / Oysters / Wetlands)
 *   - Depth contour line visibility
 *   - Three-mode depth filter (Strict / Tide-aware / Tag-only) — affects
 *     scoring, not just visibility
 *   - Trip Mode override toggle
 *
 * The map and the engine read these directly from the store; this
 * component is pure UI.
 */
import { Layers, Mountain, Tent } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  isTripModeActive,
  useBitePlanStore,
  type DepthFilterMode,
  type HabitatKey,
} from '@/store/useBitePlanStore'

type LayerRow = { key: HabitatKey; label: string; swatch: string }
const LAYERS: LayerRow[] = [
  { key: 'seagrass', label: 'Seagrass',       swatch: '#14b8a6' },
  { key: 'oysters',  label: 'Oysters',        swatch: '#f59e0b' },
  { key: 'wetlands', label: 'Wetlands',       swatch: '#84cc16' },
  { key: 'contours', label: 'Depth contours', swatch: '#60a5fa' },
]

type DepthOption = { mode: DepthFilterMode; label: string; description: string }
const DEPTH_OPTIONS: DepthOption[] = [
  { mode: 'strict',     label: 'Strict',     description: 'Hide anything < 2 ft at MLLW' },
  { mode: 'tide_aware', label: 'Tide-aware', description: 'Hide where current depth < 2 ft' },
  { mode: 'tag_only',   label: 'Tag-only',   description: 'Show all; tag the shallow ones' },
]

function LayerToggles() {
  const habitatLayers = useBitePlanStore((s) => s.habitatLayers)
  const habitatLoading = useBitePlanStore((s) => s.habitatLoading)
  const toggleHabitat = useBitePlanStore((s) => s.toggleHabitat)
  const depthFilterMode = useBitePlanStore((s) => s.depthFilterMode)
  const setDepthFilterMode = useBitePlanStore((s) => s.setDepthFilterMode)
  const tripOverride = useBitePlanStore((s) => s.tripModeOverride)
  const setTripOverride = useBitePlanStore((s) => s.setTripModeOverride)
  const tripActive = isTripModeActive(tripOverride)

  return (
    <section aria-label="Layers and filters" className="mt-4 space-y-4">
      {/* Layer visibility */}
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-2 px-1 flex items-center gap-1.5">
          <Layers className="size-3.5" /> Layers
        </div>
        <div className="rounded-md bg-slate-800/40 border border-slate-800 divide-y divide-slate-800">
          {LAYERS.map(({ key, label, swatch }) => {
            const id = `layer-${key}`
            return (
              <div key={key} className="flex items-center justify-between gap-2 px-3 py-2.5 min-h-[44px]">
                <Label htmlFor={id} className="cursor-pointer flex items-center gap-2 text-foreground text-sm">
                  <span
                    aria-hidden
                    className="inline-block size-3 rounded-sm ring-1 ring-foreground/30"
                    style={{ backgroundColor: swatch }}
                  />
                  {label}
                  {habitatLoading[key] && (
                    <span className="ml-1 text-xs text-muted-foreground">Loading…</span>
                  )}
                </Label>
                <Checkbox
                  id={id}
                  checked={habitatLayers[key]}
                  onCheckedChange={() => toggleHabitat(key)}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* Depth filter — affects scoring, not just visibility. */}
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-2 px-1 flex items-center gap-1.5">
          <Mountain className="size-3.5" /> Depth filter
        </div>
        <div role="radiogroup" className="flex flex-col gap-1.5">
          {DEPTH_OPTIONS.map(({ mode, label, description }) => {
            const id = `depth-${mode}`
            const selected = depthFilterMode === mode
            return (
              <label
                key={mode}
                htmlFor={id}
                className={
                  'flex flex-col gap-0.5 cursor-pointer rounded-md px-3 py-2 text-sm min-h-[44px] ' +
                  (selected
                    ? 'bg-slate-800 ring-1 ring-slate-600'
                    : 'bg-slate-800/30 hover:bg-slate-800/60')
                }
              >
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id={id}
                    name="depth-filter-mode"
                    checked={selected}
                    onChange={() => setDepthFilterMode(mode)}
                    className="size-3"
                  />
                  <span className="font-medium text-slate-100">{label}</span>
                </div>
                <span className="text-xs text-slate-400 pl-5">{description}</span>
              </label>
            )
          })}
        </div>
      </div>

      {/* Trip Mode override */}
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-2 px-1 flex items-center gap-1.5">
          <Tent className="size-3.5" /> Trip Mode
        </div>
        <button
          type="button"
          aria-pressed={tripActive}
          onClick={() => setTripOverride(!tripActive)}
          className={
            'w-full min-h-[44px] rounded-md px-3 py-2 text-sm font-medium transition-colors flex items-center justify-between ' +
            (tripActive
              ? 'bg-amber-600/90 hover:bg-amber-600 text-white'
              : 'bg-slate-800/40 hover:bg-slate-800 text-slate-200 border border-slate-800')
          }
        >
          <span className="flex items-center gap-2">
            <Tent className="size-4" />
            {tripActive ? 'Trip Mode ON' : 'Trip Mode OFF'}
          </span>
          <span className="text-xs opacity-80">
            {tripOverride === null ? '(auto)' : '(manual)'}
          </span>
        </button>
      </div>
    </section>
  )
}

export default LayerToggles
