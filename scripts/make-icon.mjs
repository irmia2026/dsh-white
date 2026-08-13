// Generate placeholder app icons (PNG 512 for mac/linux, PNG-in-ICO 256 for
// Windows) without image-library dependencies; replace with real brand art
// before a public release.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'build-resources')

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xFFFFFFFF
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}

function encodePng(size, pixelAt) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let offset = 0
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixelAt(x, y)
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      raw[offset + 3] = a
      offset += 4
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function smooth(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function paintIcon(size) {
  const cx = size / 2
  const cy = size * 0.52
  const ringOuter = size * 0.30
  const ringInner = size * 0.21
  const dotX = size * 0.64
  const dotY = size * 0.36
  const dotR = size * 0.06
  const top = [27, 42, 94]
  const bottom = [77, 107, 254]
  return (x, y) => {
    const t = y / size
    let r = top[0] + (bottom[0] - top[0]) * t
    let g = top[1] + (bottom[1] - top[1]) * t
    let b = top[2] + (bottom[2] - top[2]) * t
    const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
    const ring = smooth(ringInner - 1, ringInner, dist) * (1 - smooth(ringOuter, ringOuter + 1, dist))
    r += (240 - r) * ring
    g += (244 - g) * ring
    b += (255 - b) * ring
    const dotDist = Math.hypot(x + 0.5 - dotX, y + 0.5 - dotY)
    const dot = 1 - smooth(dotR - 1, dotR, dotDist)
    r += (127 - r) * dot
    g += (231 - g) * dot
    b += (255 - b) * dot
    return [Math.round(r), Math.round(g), Math.round(b), 255]
  }
}

function wrapIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry[0] = 0
  entry[1] = 0
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, png])
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(512, paintIcon(512)))
writeFileSync(path.join(OUT_DIR, 'icon.ico'), wrapIco(encodePng(256, paintIcon(256))))
// Tray icon: a small square version shipped inside the app (assets/ is part of
// the electron-builder `files` list, so the tray can load it at runtime).
const ASSETS_DIR = path.join(path.dirname(OUT_DIR), 'assets')
mkdirSync(ASSETS_DIR, { recursive: true })
writeFileSync(path.join(ASSETS_DIR, 'tray.png'), encodePng(32, paintIcon(32)))
console.log('make-icon: wrote build-resources/icon.png, icon.ico and assets/tray.png')
