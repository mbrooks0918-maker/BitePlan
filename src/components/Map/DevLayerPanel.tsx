/**
 * TEMPORARY dev-only toggle panel for habitat GeoJSON layers.
 *
 * Floats in the top-right corner of the map and exposes a checkbox for each
 * of the three habitat layers, plus a "Loading..." hint while a layer is
 * fetching for the first time.
 *
 * This panel exists only so Step 4 is verifiable in the browser. It will be
 * removed in Step 16 when the proper bottom sheet with layer toggles is built
 * (see `BottomSheet/LayerToggles.tsx` in the project structure).
 */

import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useBitePlanStore, type HabitatKey } from '@/store/useBitePlanStore'

const LAYERS: Array<{ key: HabitatKey; label: string; swatch: string }> = [
  { key: 'seagrass', label: 'Seagrass', swatch: '#14b8a6' },
  { key: 'oysters',  label: 'Oysters',  swatch: '#f59e0b' },
  { key: 'wetlands', label: 'Wetlands', swatch: '#84cc16' },
]

function DevLayerPanel() {
  const habitatLayers = useBitePlanStore((s) => s.habitatLayers)
  const habitatLoading = useBitePlanStore((s) => s.habitatLoading)
  const toggleHabitat = useBitePlanStore((s) => s.toggleHabitat)

  return (
    <Card
      size="sm"
      // z-[1000] sits above the Leaflet zoom controls (z 800-1000).
      className="fixed top-4 right-4 z-[1000] w-44 px-3 py-3 gap-2"
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Habitat (dev)
      </div>
      {LAYERS.map(({ key, label, swatch }) => {
        const id = `habitat-${key}`
        return (
          <div key={key} className="flex items-center justify-between gap-2">
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
    </Card>
  )
}

export default DevLayerPanel
