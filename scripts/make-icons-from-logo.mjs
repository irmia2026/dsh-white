// Generate app icons from build-resources/logo.png:
//   build-resources/icon.png  512x512 (mac/linux, electron-builder)
//   build-resources/icon.ico  256x256 PNG-in-ICO (Windows)
//   assets/tray.png           32x32 (tray icon, shipped in the asar)
// The logo keeps its own aspect; it is scaled down, never cropped.
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Jimp } from 'jimp'

const DESKTOP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LOGO = path.join(DESKTOP_DIR, 'build-resources', 'logo.png')
const BUILD_RESOURCES = path.join(DESKTOP_DIR, 'build-resources')
const ASSETS = path.join(DESKTOP_DIR, 'assets')

if (!existsSync(LOGO)) {
  console.error('make-icons-from-logo: missing build-resources/logo.png — put your logo there first')
  process.exit(1)
}

// ── minimal ICO container (PNG-in-ICO, the Vista+ format) ───────────────────
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

const logo = await Jimp.read(LOGO)
console.log(`make-icons-from-logo: source ${logo.width}x${logo.height}`)

async function render(size, file) {
  const image = logo.clone()
  image.resize({ w: size, h: size })
  const buffer = await image.getBuffer('image/png')
  writeFileSync(file, buffer)
  console.log(`  ${path.relative(DESKTOP_DIR, file)}  (${size}x${size}, ${(buffer.length / 1024).toFixed(1)} KiB)`)
}

mkdirSync(BUILD_RESOURCES, { recursive: true })
mkdirSync(ASSETS, { recursive: true })

await render(512, path.join(BUILD_RESOURCES, 'icon.png'))
const icoPng = await (() => {
  const image = logo.clone()
  image.resize({ w: 256, h: 256 })
  return image.getBuffer('image/png')
})()
writeFileSync(path.join(BUILD_RESOURCES, 'icon.ico'), wrapIco(icoPng))
console.log(`  build-resources/icon.ico  (256x256 PNG-in-ICO)`)

// Tray: the full logo is unreadable at 32px, so crop to the head region
// (face + ears) before downscaling.
{
  const head = logo.clone()
  const side = 760
  head.crop({ x: Math.round((logo.width - side) / 2), y: 60, w: side, h: side })
  head.resize({ w: 32, h: 32 })
  writeFileSync(path.join(ASSETS, 'tray.png'), await head.getBuffer('image/png'))
  console.log('  assets/tray.png  (32x32, head-cropped for legibility)')
}
console.log('make-icons-from-logo: done')
