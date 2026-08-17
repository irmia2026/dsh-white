// dsh sidecar lifecycle with self-healing: spawn → ready → unexpected exit →
// exponential-backoff restart, with a status object the UI and tray consume.
//
// The previous behavior (error dialog + app.exit on a crash) is replaced by
// supervised restarts; `failed` is reserved for conditions restart cannot fix
// (e.g. the bin is missing entirely).
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { request } from 'node:http'
import path from 'node:path'

const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 250
const GRACEFUL_SHUTDOWN_MS = 2_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/**
 * Prefer a fixed port so the browser origin (and thereby localStorage: chat
 * drafts, UI preferences) survives restarts; fall back to an OS-assigned
 * port only when the preferred one is occupied.
 */
async function pickPort(preferred) {
  if (preferred > 0 && await isPortFree(preferred)) return preferred
  return pickFreePort()
}

function waitForReady(port, deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error(`dsh web did not become ready within ${READY_TIMEOUT_MS} ms`))
        return
      }
      const req = request({ host: '127.0.0.1', port, path: '/', timeout: 1_000 }, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => setTimeout(attempt, READY_POLL_MS))
      req.on('timeout', () => { req.destroy(); setTimeout(attempt, READY_POLL_MS) })
      req.end()
    }
    attempt()
  })
}

export function createDshLifecycle({ dshRoot, env, onLog, onStatus, preferredPort = 3080 }) {
  let child = null
  let stopping = false
  let restartTimer = null
  let manualRestart = false
  let stdoutTail = ''
  let stderrTail = ''
  let status = {
    phase: 'idle', // idle | starting | ready | restarting | failed
    port: null,
    pid: null,
    restarts: 0,
    lastError: null,
    startedAt: null,
    readyAt: null,
  }

  const emitStatus = (patch) => {
    status = { ...status, ...patch }
    onStatus(status)
  }

  function backoffMs() {
    const attempts = Math.min(status.restarts, 10)
    return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempts)
  }

  function consumeStream(buffer, chunk, tag) {
    // Extract only complete lines; keep the trailing partial for the next chunk.
    const full = (buffer ?? '') + chunk.toString('utf8')
    const lines = full.split('\n')
    const remainder = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trimEnd()
      if (trimmed !== '') onLog(`[${tag}] ${trimmed}`)
    }
    return remainder.slice(-8192)
  }

  async function start() {
    if (stopping) return
    if (child !== null && child.exitCode === null) return

    const port = await pickPort(preferredPort)
    const bin = path.join(dshRoot, 'lib', 'bin.js')
    emitStatus({
      phase: 'starting',
      port,
      pid: null,
      lastError: null,
      startedAt: new Date().toISOString(),
    })
    onLog(`[lifecycle] starting dsh: ${bin} --port ${port} (restart #${status.restarts})`)

    let resolved = false
    const childProcess = spawn(
      process.execPath,
      // `--expose-internals`: the dsh loader reaches Node's internal ESM loader
      // for HMR; under ELECTRON_RUN_AS_NODE the node-addon-require-builtin shim
      // cannot provide it (missing V8 embedder symbol), so the flag is the only
      // reliable channel. Verified: `ELECTRON_RUN_AS_NODE=1 electron
      // --expose-internals -e "require('internal/modules/esm/loader')"` works.
      ['--expose-internals', bin, 'web', '--port', String(port)],
      {
        cwd: homedir(),
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child = childProcess
    emitStatus({ pid: childProcess.pid })

    childProcess.stdout.on('data', (chunk) => {
      stdoutTail = consumeStream(stdoutTail, chunk, 'dsh')
    })
    childProcess.stderr.on('data', (chunk) => {
      stderrTail = consumeStream(stderrTail, chunk, 'dsh:err')
    })

    childProcess.on('error', (error) => {
      // Spawn-level failure (missing bin): restart cannot help.
      emitStatus({ phase: 'failed', lastError: String(error) })
      onLog(`[lifecycle] spawn failed (no auto-restart): ${String(error)}`)
    })

    childProcess.on('exit', (code, signal) => {
      child = null
      if (stopping) {
        onLog(`[lifecycle] dsh exited cleanly (code=${String(code)} signal=${String(signal)})`)
        return
      }
      if (!resolved && code === 0) {
        // Exited before becoming ready with a clean code — still a boot failure.
        onLog(`[lifecycle] dsh exited before ready (code=${String(code)})`)
      }
      status.restarts += 1
      const detail = stderrTail.trim() || stdoutTail.trim()
      emitStatus({
        phase: 'restarting',
        lastError: detail ? detail.slice(0, 500) : `exit code=${String(code)} signal=${String(signal)}`,
        pid: null,
      })
      // Manual restarts skip the exponential backoff.
      const delay = manualRestart ? 0 : backoffMs()
      manualRestart = false
      onLog(`[lifecycle] dsh exited (code=${String(code)} signal=${String(signal)}); restarting in ${delay} ms`)
      restartTimer = setTimeout(() => {
        restartTimer = null
        void start()
      }, delay)
    })

    try {
      await waitForReady(port, Date.now() + READY_TIMEOUT_MS)
    } catch (error) {
      if (!stopping) {
        // Ready timeout: treat like a crash and let the restart path heal it.
        onLog(`[lifecycle] ready timeout: ${String(error)}`)
        try { childProcess.kill('SIGTERM') } catch { /* already gone */ }
        setTimeout(() => {
          if (childProcess.exitCode === null) {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(childProcess.pid), '/T', '/F'], { stdio: 'ignore' })
            } else {
              try { childProcess.kill('SIGKILL') } catch { /* already gone */ }
            }
          }
        }, GRACEFUL_SHUTDOWN_MS).unref()
      }
      return
    }
    resolved = true
    emitStatus({ phase: 'ready', readyAt: new Date().toISOString() })
    onLog(`[lifecycle] dsh web ready at http://127.0.0.1:${String(port)}`)
  }

  function stop() {
    if (stopping) return
    stopping = true
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const current = child
    if (current !== null && current.exitCode === null) {
      try { current.kill('SIGTERM') } catch { /* already gone */ }
      const pid = current.pid
      const timer = setTimeout(() => {
        if (current.exitCode === null) {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
          } else {
            try { current.kill('SIGKILL') } catch { /* already gone */ }
          }
        }
      }, GRACEFUL_SHUTDOWN_MS)
      timer.unref()
    }
    emitStatus({ phase: 'stopping' })
  }

  /** User-initiated restart: kill the current child; the exit handler
   *  restarts immediately (manual restarts skip backoff). */
  function restart() {
    manualRestart = true
    onLog('[lifecycle] manual restart requested')
    const current = child
    if (current !== null && current.exitCode === null) {
      try { current.kill('SIGTERM') } catch { /* already gone */ }
      const timer = setTimeout(() => {
        if (current.exitCode === null) {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(current.pid), '/T', '/F'], { stdio: 'ignore' })
          } else {
            try { current.kill('SIGKILL') } catch { /* already gone */ }
          }
        }
      }, GRACEFUL_SHUTDOWN_MS)
      timer.unref()
    } else {
      void start()
    }
  }

  return {
    start,
    stop,
    restart,
    getStatus: () => status,
  }
}
