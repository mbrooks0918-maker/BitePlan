/**
 * Placeholder PWA icon generator (Step 19).
 *
 * Hand-rolls solid-color RGB PNG icons (no external deps) into
 * public/icons/. Final icon design is Step 21 polish; until then we want
 * something that installs cleanly on iOS + Android and reads as
 * "BitePlan branded" rather than a generic browser fallback.
 *
 * Each PNG is:
 *   - filled with a dark slate background (#0a0e1a — matches the manifest
 *     theme_color)
 *   - over which we draw an emerald rectangle and three tier-colored
 *     dots (yellow / orange / red) to evoke the heat zones the app paints
 *     on the map
 *
 * Generates: icon-192.png, icon-512.png, maskable-512.png (with extra
 * safe-area padding so it survives Android's circle/squircle masking).
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'public', 'icons')
mkdirSync(OUT_DIR, { recursive: true })

const BG = [0x0a, 0x0e, 0x1a] // slate-950ish
const EMERALD = [0x10, 0xb9, 0x81]
const FIRE = [0xef, 0x44, 0x44]
const HOT = [0xf9, 0x73, 0x16]
const DRIVEBY = [0xea, 0xb3, 0x08]

// ---- PNG byte assembly ---------------------------------------------------

function crc32(buf) {
  // PNG spec CRC32. Computed lazily — only needed for chunk validation.
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
  return Buffer.from([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ])
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const payload = Buffer.concat([typeBuf, data])
  const crc = u32(crc32(payload))
  return Buffer.concat([u32(data.length), payload, crc])
}

function makePng(size, draw) {
  // 8-bit RGB, non-interlaced.
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
  const ihdrData = Buffer.concat([
    u32(size),
    u32(size),
    Buffer.from([8, 2, 0, 0, 0]), // bit depth 8, color type 2 (RGB), no filter/interlace
  ])
  return Buffer.concat([sig, chunk('IHDR', ihdrData), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---- Drawing helpers -----------------------------------------------------

function drawFor(size, padding) {
  // padding is a fraction of `size` reserved as safe-area gutter
  // (matters for the maskable icon).
  const inner = size - 2 * padding
  const cx = size / 2
  const cy = size / 2
  // Emerald rectangle, centered, occupies the middle 60% of the inner area
  // — evokes the bottom sheet / brand block.
  const rectW = inner * 0.6
  const rectH = inner * 0.32
  const rectX0 = cx - rectW / 2
  const rectX1 = cx + rectW / 2
  const rectY0 = cy + inner * 0.1
  const rectY1 = rectY0 + rectH
  // Three heat dots above the rectangle: yellow / orange / red, left → right.
  const dotR = inner * 0.07
  const dotY = cy - inner * 0.16
  const dotXs = [cx - inner * 0.18, cx, cx + inner * 0.18]
  const dotColors = [DRIVEBY, HOT, FIRE]

  return (x, y) => {
    // Background
    let color = BG
    // Rectangle
    if (x >= rectX0 && x <= rectX1 && y >= rectY0 && y <= rectY1) color = EMERALD
    // Dots (loop after rect so dots draw over)
    for (let i = 0; i < dotXs.length; i++) {
      const dx = x - dotXs[i]
      const dy = y - dotY
      if (dx * dx + dy * dy <= dotR * dotR) color = dotColors[i]
    }
    return color
  }
}

// ---- Emit ----------------------------------------------------------------

function write(name, size, padding) {
  const draw = drawFor(size, padding)
  const buf = makePng(size, draw)
  const path = resolve(OUT_DIR, name)
  writeFileSync(path, buf)
  console.log(`  ${name} — ${(buf.length / 1024).toFixed(1)} KB`)
}

console.log('Generating PWA icons…')
write('icon-192.png', 192, 12)
write('icon-512.png', 512, 32)
// Maskable icons need ~20% safe area on each side so the mask doesn't
// crop into the artwork. We use 25% padding to be safe across Android
// mask shapes.
write('maskable-512.png', 512, 128)
console.log('Done.')
