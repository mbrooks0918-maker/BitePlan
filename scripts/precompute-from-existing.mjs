/**
 * Step 20 perf — run convergence detection + habitat simplification
 * against the GeoJSONs already on disk, without re-fetching from FWC /
 * USFWS. Saves time during dev iteration; the full fetch script does the
 * same thing inline.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as turf from '@turf/turf'
import { runConvergenceDetection } from '../src/lib/convergence.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = resolve(__dirname, '..', 'public', 'data')

async function loadFc(file) {
  const raw = await readFile(resolve(DATA, file), 'utf8')
  return JSON.parse(raw)
}

const sg = await loadFc('seagrass.geojson')
const oy = await loadFc('oysters.geojson')
const wt = await loadFc('wetlands.geojson')

console.log(
  `loaded: seagrass=${sg.features.length}, oysters=${oy.features.length}, wetlands=${wt.features.length}`,
)

const fcByType = [
  { type: 'seagrass', fc: sg },
  { type: 'oyster', fc: oy },
  { type: 'wetland', fc: wt },
]
const all = []
for (const { type, fc } of fcByType) {
  let i = 0
  for (const f of fc.features) {
    const idCandidate =
      f.properties?.['OBJECTID'] ?? f.properties?.['Wetlands.OBJECTID'] ?? i++
    all.push({
      id: `${type}:${idCandidate}`,
      type,
      geometry: f.geometry,
      properties: f.properties ?? {},
    })
  }
}

const tCv0 = Date.now()
const primitives = runConvergenceDetection(all)
const cvMs = Date.now() - tCv0
console.log(
  `convergence detected: ${primitives.points.length} points + ${primitives.mouths.length} mouths in ${(cvMs / 1000).toFixed(1)}s`,
)

await writeFile(resolve(DATA, 'convergence_index.json'), JSON.stringify(primitives))

// Simplify habitats (oysters skipped — point-cluster scale)
function simplifyFc(label, fc, tol) {
  if (fc.features.length === 0) return fc
  const t0 = Date.now()
  const result = turf.simplify(fc, { tolerance: tol, highQuality: false, mutate: false })
  console.log(`simplified ${label} (tol=${tol}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return result
}
const sgSimp = simplifyFc('seagrass', sg, 0.0001)
const wtSimp = simplifyFc('wetlands', wt, 0.0001)

const before = (raw) => (raw.length / 1024 / 1024).toFixed(2) + ' MB'

const sgRawBefore = await readFile(resolve(DATA, 'seagrass.geojson'), 'utf8')
const wtRawBefore = await readFile(resolve(DATA, 'wetlands.geojson'), 'utf8')

await writeFile(resolve(DATA, 'seagrass.geojson'), JSON.stringify(sgSimp))
await writeFile(resolve(DATA, 'wetlands.geojson'), JSON.stringify(wtSimp))

const sgRawAfter = await readFile(resolve(DATA, 'seagrass.geojson'), 'utf8')
const wtRawAfter = await readFile(resolve(DATA, 'wetlands.geojson'), 'utf8')

console.log('')
console.log(`seagrass:   ${before(sgRawBefore)} → ${before(sgRawAfter)}`)
console.log(`wetlands:   ${before(wtRawBefore)} → ${before(wtRawAfter)}`)
console.log(`convergence_index.json: ${(JSON.stringify(primitives).length / 1024).toFixed(1)} KB`)
