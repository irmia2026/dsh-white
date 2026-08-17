// Fetch the Electron binary reliably: run the package's own install.js, then
// verify the binary at the platform-correct path; if it is still missing,
// force a direct download through @electron/get with the mirror.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const ELECTRON_DIR = path.join(DESKTOP_DIR, 'node_modules', 'electron')
const pkg = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8')))
const version = pkg.version

function platformPath() {
  switch (process.platform) {
    case 'darwin': return 'Electron.app/Contents/MacOS/Electron'
    case 'win32': return 'electron.exe'
    default: return 'electron'
  }
}

function binaryPath() {
  return process.env.ELECTRON_OVERRIDE_DIST_PATH ?? path.join(ELECTRON_DIR, 'dist', platformPath())
}

if (existsSync(binaryPath())) {
  console.log(`fetch-electron: binary already present (${platformPath()})`)
  process.exit(0)
}

console.log(`fetch-electron: running electron's install.js for v${version} ${process.platform}-${process.arch}`)
try {
  execFileSync(process.execPath, [path.join(ELECTRON_DIR, 'install.js')], { stdio: 'inherit' })
} catch {
  console.warn('fetch-electron: install.js exited non-zero; trying direct download')
}

if (!existsSync(binaryPath())) {
  console.log('fetch-electron: direct download via @electron/get')
  const { downloadArtifact } = await import('@electron/get')
  const { extract } = await import('@electron-internal/extract-zip')
  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    force: true,
    platform: process.platform,
    arch: process.arch,
    mirrorOptions: process.env.ELECTRON_MIRROR ? { mirror: process.env.ELECTRON_MIRROR } : undefined,
  })
  await extract(zipPath, { dir: path.join(ELECTRON_DIR, 'dist') })
}

if (!existsSync(binaryPath())) {
  console.error(`fetch-electron: binary still missing at ${binaryPath()}`)
  process.exit(1)
}
console.log(`fetch-electron: OK (${binaryPath()})`)
