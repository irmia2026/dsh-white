// Boot smoke for the staged dsh closure: spawn it exactly like the desktop
// shell does (ELECTRON_RUN_AS_NODE + --expose-internals, dynamic port, temp
// DSH_HOME), wait for the readiness line, probe the page, then stop.
// Exits 0 only when the server stays alive and serves the boot manifest.
//
// Since dsh-v0.1.2-alpha.1 the readiness URL carries a `?token=` launch
// token: the first GET on it mints a signed auth cookie and 303s to clean
// `/`, and only cookie-bearing requests are served the page (bare requests
// get 401). The probe performs that exchange like a browser would; older
// servers answer the first GET directly, which this flow also covers.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const STAGED_BIN = join(DESKTOP_DIR, '.staging', 'dsh', 'lib', 'bin.js')
const ELECTRON_BIN = join(DESKTOP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe'
    : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
    : 'electron')

const READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 500

function fail(message) {
  console.error(`smoke-boot: ${message}`)
  process.exit(1)
}

async function probe(pageUrl, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let res = await fetch(pageUrl, { redirect: 'manual', signal: controller.signal })
    // Launch-token exchange: mint the auth cookie, then re-request `/`.
    if (res.status === 303 || res.status === 302) {
      const setCookie = res.headers.get('set-cookie')
      if (setCookie === null) return { status: res.status, hasBoot: false }
      res = await fetch(new URL('/', pageUrl), {
        headers: { cookie: setCookie.split(';')[0] },
        signal: controller.signal,
      })
    }
    const body = await res.text()
    return { status: res.status, hasBoot: body.includes('__DSH_BOOT__') }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const home = mkdtempSync(join(tmpdir(), 'dsh-smoke-boot-'))
console.log(`smoke-boot: staging at ${STAGED_BIN}`)
const child = spawn(ELECTRON_BIN, ['--expose-internals', STAGED_BIN, 'web', '--port', '0'], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: home,
    DSH_PERMISSION_MODE: 'workspace-write',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

const deadline = Date.now() + READY_TIMEOUT_MS
let url = null
while (Date.now() < deadline) {
  if (child.exitCode !== null) {
    console.error(stderr.slice(-4000))
    fail(`dsh exited early (code=${String(child.exitCode)}); see stderr above`)
  }
  const match = stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/)
  if (match !== null) {
    url = match[1]
    break
  }
  await new Promise(resolve => setTimeout(resolve, READY_POLL_MS))
}
if (url === null) {
  child.kill('SIGTERM')
  console.error(stderr.slice(-4000))
  fail(`no readiness line within ${READY_TIMEOUT_MS} ms`)
}

// Give the server a moment past the readiness line, then probe repeatedly.
await new Promise(resolve => setTimeout(resolve, 3000))
if (child.exitCode !== null) {
  console.error(stderr.slice(-4000))
  fail(`dsh exited right after ready; see stderr above`)
}
let ok = false
for (let attempt = 1; attempt <= 5; attempt += 1) {
  const result = await probe(url)
  if (result !== null && result.status === 200 && result.hasBoot) {
    ok = true
    break
  }
  if (child.exitCode !== null) break
  await new Promise(resolve => setTimeout(resolve, 2000))
}

child.kill('SIGTERM')
setTimeout(() => {
  if (child.exitCode === null) child.kill('SIGKILL')
}, 3000).unref()
rmSync(home, { recursive: true, force: true })

if (!ok) {
  console.error(stderr.slice(-4000))
  fail(`server did not serve the boot manifest at ${url}`)
}
console.log(`smoke-boot: OK — ${url} served the DSH boot manifest`)
