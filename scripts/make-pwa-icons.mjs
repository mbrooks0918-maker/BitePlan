/**
 * BitePlan PWA icon generator (Step 19 placeholder → Step 21 final).
 *
 * Hand-rolls solid-RGB PNG icons (no external deps) into public/icons/.
 * The design language matches the in-app heat-zone palette: dark slate
 * canvas + a tier-graded "heat" disc with a stylized fish silhouette
 * cutting through it.
 *
 * Visual:
 *   - Background: slate-950 (#0a0e1a), matches manifest theme_color
 *   - Centered heat disc with a red→orange→yellow radial banding that
 *     evokes the fire/hot/driveby tiers
 *   - Black fish silhouette running left→right across the disc; tail
 *     flares with a small orange highlight to suggest a "biting" fish
 *
 * Maskable: extra padding so iOS / Android masks (circle / squircle)
 * crop into background instead of artwork.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'public', 'icons')
mkdirSync(OUT_DIR, { recursive: true })

// ---- palette -------------------------------------------------------------

const BG = rgb('#0a0e1a')   // slate-950, manifest theme_color
const FIRE = rgb('#ef4444')  // red-500
const HOT = rgb('#f97316')   // orange-500
const DRIVE = rgb('#eab308') // yellow-500
const FISH = rgb('#0f172a')  // near-black slate, slightly lighter than BG
const FISH_EYE = rgb('#fef3c7') // pale yellow-100 for eye highlight
const ACCENT = rgb('#fbbf24')   // amber-400 tail flare

function rgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

// ---- PNG byte assembly ---------------------------------------------------
// Minimal RGB 8-bit PNG writer — no external dep, no alpha (we composite
// onto a known background colour instead).

function crc32(buf) {
  let c
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function u32(n) {
  return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const payload = Buffer.concat([typeBuf, data])
  const crc = u32(crc32(payload))
  return Buffer.concat([u32(data.length), payload, crc])
}

function makePng(size, draw) {
  const rowBytes = size * 3
  const raw = Buffer.alloc(size * (1 + rowBytes))
  for (let y = 0; y < size; y++) {
    raw[y * (1 + rowBytes)] = 0 // filter byte: None
    for (let x = 0; x < size; x++) {
      const [r, g, b] = draw(x, y, size)
      const base = y * (1 + rowBytes) + 1 + x * 3
      raw[base] = r
      raw[base + 1] = g
      raw[base + 2] = b
    }
  }
  const idat = deflateSync(raw, { level: 9 })
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.concat([u32(size), u32(size), Buffer.from([8, 2, 0, 0, 0])])
  return Buffer.concat([sig, chunk('IHDR', ihdrData), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---- drawing primitives --------------------------------------------------

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

/**
 * Anti-alias by sampling 2×2 sub-pixels and averaging. Cheap super-sampling
 * gives the artwork much smoother edges at 192/512 px than naive nearest.
 */
function aa(draw, x, y) {
  const samples = [
    draw(x + 0.25, y + 0.25),
    draw(x + 0.75, y + 0.25),
    draw(x + 0.25, y + 0.75),
    draw(x + 0.75, y + 0.75),
  ]
  return [
    Math.round((samples[0][0] + samples[1][0] + samples[2][0] + samples[3][0]) / 4),
    Math.round((samples[0][1] + samples[1][1] + samples[2][1] + samples[3][1]) / 4),
    Math.round((samples[0][2] + samples[1][2] + samples[2][2] + samples[3][2]) / 4),
  ]
}

/**
 * The icon's actual shape function. `size` is the icon dimension and
 * `padding` reserves a safe-area gutter (used by the maskable variant).
 *
 * Layout: a centered heat disc (radius = innerSize * 0.42) painted with
 * a 3-stop radial gradient — yellow core → orange middle → red rim. A
 * dark fish silhouette overlays the disc with a small accent highlight
 * at the tail.
 */
function drawFor(size, padding) {
  const inner = size - 2 * padding
  const cx = size / 2
  const cy = size / 2
  const discR = inner * 0.42
  const fishCenterY = cy + inner * 0.02
  const fishLen = inner * 0.7
  const fishHeight = inner * 0.18
  const fishX0 = cx - fishLen / 2
  const fishX1 = cx + fishLen / 2
  const tailTipX = fishX0 - inner * 0.05

  return (xs, ys) => {
    // Heat disc (radial gradient)
    const dx = xs - cx
    const dy = ys - cy
    const r = Math.sqrt(dx * dx + dy * dy)
    let color = BG
    if (r <= discR) {
      const t = r / discR
      if (t < 0.5) color = mix(DRIVE, HOT, t * 2)
      else color = mix(HOT, FIRE, (t - 0.5) * 2)
    }
    // Outer rim soft edge
    else if (r <= discR + 1.5) {
      const t = (r - discR) / 1.5
      color = mix(FIRE, BG, t)
    }

    // Fish body — an elongated ellipse running horizontally.
    const localX = xs - cx
    const localY = ys - fishCenterY
    const bodyRx = fishLen * 0.45
    const bodyRy = fishHeight / 2
    const bodyV = (localX / bodyRx) ** 2 + (localY / bodyRy) ** 2
    if (bodyV <= 1 && xs >= fishX0 && xs <= fishX1) {
      color = FISH
    }

    // Tail triangle — narrows from the body's left flank to a sharp tip.
    if (xs < fishX0 && xs >= tailTipX) {
      const tailT = (fishX0 - xs) / (fishX0 - tailTipX)
      const tailHalf = (1 - tailT) * fishHeight * 0.6
      if (Math.abs(ys - fishCenterY) <= tailHalf) {
        color = FISH
      }
    }

    // Accent: tail flare highlight near the body-tail junction.
    if (xs >= fishX0 - inner * 0.02 && xs <= fishX0 + inner * 0.04) {
      const flareDy = ys - fishCenterY
      if (Math.abs(flareDy) <= fishHeight * 0.06) {
        color = ACCENT
      }
    }

    // Eye dot
    const eyeX = fishX0 + fishLen * 0.78
    const eyeY = fishCenterY - fishHeight * 0.1
    const eyeR = fishHeight * 0.09
    const edx = xs - eyeX
    const edy = ys - eyeY
    if (edx * edx + edy * edy <= eyeR * eyeR) {
      color = FISH_EYE
    }

    return color
  }
}

function renderIcon(size, padding) {
  const draw = drawFor(size, padding)
  return makePng(size, (x, y) => aa(draw, x, y))
}

// ---- emit ----------------------------------------------------------------

function write(name, size, padding) {
  const buf = renderIcon(size, padding)
  const path = resolve(OUT_DIR, name)
  writeFileSync(path, buf)
  console.log(`  ${name} — ${(buf.length / 1024).toFixed(1)} KB`)
}

console.log('Generating PWA icons (Step 21 final)…')
write('icon-192.png', 192, 8)
write('icon-512.png', 512, 24)
// Maskable: 25% safe-area padding so the mask doesn't crop into the disc
write('maskable-512.png', 512, 128)
console.log('Done.')
