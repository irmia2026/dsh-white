import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 250
const GRACEFUL_SHUTDOWN_MS = 2_000
const STDERR_TAIL_BYTES = 8_192

let mainWindow = null
let dshChild = null
let stopping = false

function dshRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dsh')
    : path.join(HERE, '..', '.staging', 'dsh')
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
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

async function startDsh() {
  const port = await pickFreePort()
  const bin = path.join(dshRoot(), 'lib', 'bin.js')
  const logDir = app.getPath('userData')
  await mkdir(logDir, { recursive: true })
  const logStream = createWriteStream(path.join(logDir, 'dsh-web.log'), { flags: 'a' })
  const stderrTail = []
  let stderrBytes = 0
  const child = spawn(
    process.execPath,
    [bin, 'web', '--port', String(port)],
    {
      cwd: homedir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.pipe(logStream)
  child.stderr.on('data', (chunk) => {
    logStream.write(chunk)
    stderrTail.push(chunk.toString('utf8'))
    stderrBytes += chunk.length
    while (stderrBytes > STDERR_TAIL_BYTES) {
      const dropped = stderrTail.shift()
      if (dropped === undefined) break
      stderrBytes -= dropped.length
    }
  })
  child.on('error', (error) => {
    console.error(`[deepharness-desktop] failed to spawn dsh: ${String(error)}`)
  })
  child.on('exit', (code, signal) => {
    logStream.end()
    console.error(`[deepharness-desktop] dsh exited (code=${String(code)} signal=${String(signal)}); stderr tail:\n${stderrTail.join('')}`)
    if (stopping) return
    dialog.showErrorBox(
      'DeepHarness Desktop',
      `dsh web exited unexpectedly (code=${String(code)} signal=${String(signal)}).\n\n${stderrTail.join('')}`,
    )
    app.exit(1)
  })
  dshChild = child
  console.log(`[deepharness-desktop] spawned dsh pid=${String(child.pid)} bin=${bin} port=${String(port)}`)
  await waitForReady(port, Date.now() + READY_TIMEOUT_MS)
  return port
}

function stopDsh() {
  if (stopping || dshChild === null || dshChild.exitCode !== null) return
  stopping = true
  try { dshChild.kill('SIGTERM') } catch { /* already gone */ }
  const pid = dshChild.pid
  const timer = setTimeout(() => {
    if (dshChild === null || dshChild.exitCode !== null) return
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try { dshChild.kill('SIGKILL') } catch { /* already gone */ }
    }
  }, GRACEFUL_SHUTDOWN_MS)
  timer.unref()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepHarness Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  return mainWindow
}

if (app.requestSingleInstanceLock() === false) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    const window = createWindow()
    try {
      const port = await startDsh()
      console.log(`[deepharness-desktop] dsh web ready at http://127.0.0.1:${String(port)}`)
      await window.loadURL(`http://127.0.0.1:${String(port)}`)
      console.log(`[deepharness-desktop] window loaded http://127.0.0.1:${String(port)}`)
    } catch (error) {
      dialog.showErrorBox('DeepHarness Desktop', `Failed to start dsh web:\n\n${String(error)}`)
      stopDsh()
      app.exit(1)
      return
    }
    window.on('closed', () => { mainWindow = null })
  })

  app.on('window-all-closed', () => {
    stopDsh()
    app.quit()
  })

  app.on('before-quit', () => { stopDsh() })
}
