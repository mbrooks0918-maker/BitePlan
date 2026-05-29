/**
 * TEMPORARY dev-only toggle panel for map layers + depth filter mode.
 *
 * Floats in the top-right corner of the map. Two sections:
 *  - "Habitat (dev)": the three habitat polygon layers + Step 13.6 depth
 *    contour visibility layer.
 *  - "Depth filter": three radio choices that pick the depth-filter mode
 *    feeding the scoring engine (Step 13.6).
 *
 * The whole panel exists only so the Step 4 / 13.6 work is verifiable in
 * the browser. It moves into the proper bottom sheet (with layer toggles
 * and a settings drawer) in Step 16.
 */

import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
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

type DepthOption = {
  mode: DepthFilterMode
  label: string
  description: string
}
const DEPTH_OPTIONS: DepthOption[] = [
  { mode: 'strict',     label: 'Strict',     description: 'Hide anything < 2 ft at MLLW' },
  { mode: 'tide_aware', label: 'Tide-aware', description: 'Hide where current depth < 2 ft' },
  { mode: 'tag_only',   label: 'Tag-only',   description: 'Show all; tag the shallow ones' },
]

function DevLayerPanel() {
  const habitatLayers = useBitePlanStore((s) => s.habitatLayers)
  const habitatLoading = useBitePlanStore((s) => s.habitatLoading)
  const toggleHabitat = useBitePlanStore((s) => s.toggleHabitat)
  const depthFilterMode = useBitePlanStore((s) => s.depthFilterMode)
  const setDepthFilterMode = useBitePlanStore((s) => s.setDepthFilterMode)

  return (
    <Card
      size="sm"
      // z-[1000] sits above the Leaflet zoom controls (z 800-1000).
      className="fixed top-4 right-4 z-[1000] w-56 px-3 py-3 gap-3"
    >
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Habitat (dev)
        </div>
        {LAYERS.map(({ key, label, swatch }) => {
          const id = `habitat-${key}`
          return (
            <div key={key} className="flex items-center justify-between gap-2 py-0.5">
              <Label htmlFor={id} className="cursor-pointer gap-2 text-foreground">
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

      <div className="pt-2 border-t border-border">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Depth filter
        </div>
        <div role="radiogroup" className="flex flex-col gap-1">
          {DEPTH_OPTIONS.map(({ mode, label, description }) => {
            const id = `depth-${mode}`
            const selected = depthFilterMode === mode
            return (
              <label
                key={mode}
                htmlFor={id}
                className={
                  'flex flex-col gap-0.5 cursor-pointer rounded px-2 py-1.5 text-xs ' +
                  (selected
                    ? 'bg-foreground/10 ring-1 ring-foreground/20'
                    : 'hover:bg-foreground/5')
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
                  <span className="font-medium text-foreground">{label}</span>
                </div>
                <span className="text-muted-foreground pl-5">{description}</span>
              </label>
            )
          })}
        </div>
      </div>
    </Card>
  )
}

export default DevLayerPanel
