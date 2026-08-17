// Startup timing experiment: baseline vs NODE_COMPILE_CACHE (cold vs warm).
// Measures time from spawn to the "dsh web:" readiness line. Same temp
// DSH_HOME across runs so profile-init cost is paid once (first run).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const BIN = join(DESKTOP_DIR, '.staging', 'dsh', 'lib', 'bin.js')
const ELECTRON = join(DESKTOP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')

const home = mkdtempSync(join(tmpdir(), 'dsh-perf-home-'))
const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-perf-cache-'))

async function timeRun(label, extraEnv) {
  const start = Date.now()
  const child = spawn(ELECTRON, ['--expose-internals', BIN, 'web', '--port', '0'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c) => { out += c.toString('utf8') })
  const ready = await new Promise((resolve) => {
    const check = setInterval(() => {
      if (out.includes('dsh web: http://')) { clearInterval(check); resolve(Date.now() - start) }
      if (child.exitCode !== null) { clearInterval(check); resolve(-1) }
    }, 100)
  })
  child.kill('SIGTERM')
  setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 2000).unref()
  console.log(`${label}: ${ready < 0 ? 'FAILED' : `${ready} ms`}`)
  return ready
}

console.log(`home=${home}`)
await timeRun('baseline #1 (profile init)', {})
await timeRun('baseline #2 (warm home, no cache)', {})
await timeRun('cache cold  (first fill)', { NODE_COMPILE_CACHE: cacheDir })
await timeRun('cache warm  (cache hit)  ', { NODE_COMPILE_CACHE: cacheDir })
await timeRun('cache warm  (again)       ', { NODE_COMPILE_CACHE: cacheDir })

rmSync(home, { recursive: true, force: true })
rmSync(cacheDir, { recursive: true, force: true })
process.exit(0)
