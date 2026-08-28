// Dsh-white — Electron main process.
//
// Architecture (see HANDOFF.md): Electron shell + sidecar dsh child process
// (ELECTRON_RUN_AS_NODE), BrowserWindow loading http://127.0.0.1:<port>.
//
// Features layered on top:
// - tray + close-to-tray + auto-launch
// - supervised sidecar lifecycle with exponential-backoff self-healing
// - status/log panel (local HTML + IPC)
// - electron-updater: check automatically, install manually
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDshLifecycle } from './lifecycle.mjs'
import { createLogStore } from './log-store.mjs'
import { createSettings } from './settings.mjs'
import { createTray } from './tray.mjs'
import { createUpdater } from './updater.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let mainWindow = null
let panelWindow = null
// The URL the main window currently shows; guards against double loads when
// the lifecycle 'ready' status and the startup path race each other.
let loadedUrl = null
let quitting = false

/** Route renderer console errors and load failures into the app log. */
function attachRendererDiagnostics(window, tag) {
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) logs.append(`[${tag}:console] ${message}`)
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logs.append(`[${tag}] did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    logs.append(`[${tag}] render-process-gone: ${JSON.stringify(details)}`)
  })
}

// ── window state persistence ────────────────────────────────────────────────
function loadWindowState() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'window-state.json'), 'utf8'))
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') return parsed
  } catch { /* first run */ }
  return null
}

function watchWindowState(window) {
  const file = path.join(app.getPath('userData'), 'window-state.json')
  let timer = null
  const save = () => {
    if (window.isDestroyed()) return
    const bounds = window.getNormalBounds()
    writeFileSync(file, JSON.stringify({ ...bounds, isMaximized: window.isMaximized() }))
  }
  const debounced = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  window.on('resize', debounced)
  window.on('move', debounced)
  window.on('close', save)
}

/** Minimal right-click menu: Electron ships none by default. */
function attachContextMenu(window) {
  window.webContents.on('context-menu', (_event, params) => {
    const template = []
    if (params.isEditable) {
      template.push({ role: 'cut', label: '剪切' }, { role: 'paste', label: '粘贴' })
    }
    if (params.selectionText.trim().length > 0) template.push({ role: 'copy', label: '复制' })
    template.push({ role: 'selectAll', label: '全选' })
    if (params.linkURL) template.push({ label: '在浏览器中打开链接', click: () => void shell.openExternal(params.linkURL) })
    Menu.buildFromTemplate(template).popup()
  })
}

function dshRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dsh')
    : path.join(HERE, '..', '.staging', 'dsh')
}

function createWindow() {
  const saved = loadWindowState()
  const window = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 600,
    title: 'Dsh-white',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload only touches contextBridge + ipcRenderer, which sandboxed
      // preloads are allowed to use.
      sandbox: true,
      // Close-to-tray keeps the page alive: don't throttle its timers/SSE.
      backgroundThrottling: false,
      // Persistent V8 code cache for the renderer (faster UI cold loads).
      v8CacheOptions: 'code',
    },
  })
  if (saved?.isMaximized) window.maximize()
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Navigation fence: the app window may only ever show the local dsh server.
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) {
      event.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    }
  })
  window.on('close', (event) => {
    if (!quitting && settings.get().closeToTray) {
      // Close-to-tray: keep the sidecar and the page (mux socket) alive.
      event.preventDefault()
      window.hide()
    }
  })
  window.on('closed', () => { mainWindow = null })
  attachRendererDiagnostics(window, 'main')
  attachContextMenu(window)
  watchWindowState(window)
  // Splash until the sidecar is ready (first-run profile init can take ~20s).
  window.loadFile(path.join(HERE, '..', 'ui', 'splash.html'))
  return window
}

function createPanel() {
  if (panelWindow !== null && !panelWindow.isDestroyed()) {
    panelWindow.show()
    panelWindow.focus()
    return panelWindow
  }
  panelWindow = new BrowserWindow({
    width: 780,
    height: 560,
    minWidth: 620,
    minHeight: 420,
    title: 'Dsh-white 状态与日志',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  panelWindow.loadFile(path.join(HERE, '..', 'ui', 'panel.html'))
  // The panel is a static local page: no in-page navigation, ever.
  panelWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  panelWindow.on('closed', () => { panelWindow = null })
  attachRendererDiagnostics(panelWindow, 'panel')
  return panelWindow
}

function quitApp() {
  if (quitting) return
  quitting = true
  try { lifecycle.stop() } catch { /* already stopped */ }
  setTimeout(() => {
    try { logs.end() } catch { /* already ended */ }
    app.quit()
  }, 300).unref()
}

// ── boot ────────────────────────────────────────────────────────────────────
const userDataDir = app.getPath('userData')
const settings = createSettings(userDataDir)
const logs = createLogStore(userDataDir)
let updater
let lifecycle
let tray

if (app.requestSingleInstanceLock() === false) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    app.setLoginItemSettings({ openAtLogin: settings.get().autoLaunch })

    // Permission fence: deny every renderer permission request except
    // notifications, which the dsh web UI may legitimately surface.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'notifications')
    })

    updater = createUpdater({
      settings,
      onLog: (line) => logs.append(line),
      useDirectConnection: () => session.defaultSession.setProxy({ mode: 'direct' }),
      onState: (state) => {
        if (panelWindow !== null && !panelWindow.isDestroyed()) {
          panelWindow.webContents.send('app:update', state)
        }
      },
    })
    lifecycle = createDshLifecycle({
      dshRoot: dshRoot(),
      env: process.env,
      compileCacheDir: path.join(userDataDir, 'dsh-compile-cache'),
      onLog: (line) => logs.append(line),
      onStatus: (status) => {
        if (panelWindow !== null && !panelWindow.isDestroyed()) {
          panelWindow.webContents.send('app:status', status)
        }
        if (tray !== undefined) tray.refresh()
        // dsh v0.1.2-alpha.1+ gates the page behind a launch token: bare
        // loads get 401. Load the authenticated readiness URL, and reload
        // with the fresh token after every sidecar restart (each spawn
        // mints a new one).
        if (status.phase === 'ready' && mainWindow !== null && !mainWindow.isDestroyed()) {
          const target = status.authUrl
            ?? (status.port !== null ? `http://127.0.0.1:${String(status.port)}` : null)
          if (target !== null && target !== loadedUrl) {
            loadedUrl = target
            void mainWindow.loadURL(target)
          }
        }
      },
    })

    // ── IPC ────────────────────────────────────────────────────────────────
    ipcMain.handle('app:get-status', () => lifecycle.getStatus())
    ipcMain.handle('app:get-logs', () => logs.tail(800))
    ipcMain.handle('app:get-settings', () => settings.get())
    ipcMain.handle('app:set-settings', (_event, patch) => {
      const next = settings.set(patch ?? {})
      if (patch?.autoLaunch !== undefined) {
        app.setLoginItemSettings({ openAtLogin: next.autoLaunch })
      }
      return next
    })
    ipcMain.handle('app:get-update', () => updater.getState())
    ipcMain.handle('app:check-updates', () => { void updater.checkNow() })
    ipcMain.handle('app:download-update', () => { void updater.downloadAndInstall() })
    ipcMain.handle('app:install-update', () => updater.quitAndInstall())
    ipcMain.handle('app:window-hide', () => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.hide()
    })
    ipcMain.handle('app:window-show', () => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
    ipcMain.handle('app:quit', () => quitApp())
    ipcMain.handle('app:restart-dsh', () => lifecycle.restart())
    ipcMain.handle('app:get-version', () => app.getVersion())

    // Downloads (session export etc.): ask where to save instead of silently
    // dropping files into the default downloads directory.
    session.defaultSession.on('will-download', (_event, item) => {
      const owner = BrowserWindow.fromWebContents(item.getWebContents()) ?? mainWindow
      dialog.showSaveDialog(owner, { defaultPath: item.getFilename() }).then(({ canceled, filePath }) => {
        if (canceled || !filePath) {
          item.cancel()
          return
        }
        item.setSavePath(filePath)
      })
    })

    logs.onLine((line) => {
      if (panelWindow !== null && !panelWindow.isDestroyed()) {
        panelWindow.webContents.send('app:log', line)
      }
    })

    // ── windows, tray, sidecar ─────────────────────────────────────────────
    mainWindow = createWindow()
    tray = createTray({
      getWindow: () => mainWindow,
      openPanel: () => createPanel(),
      settings,
      updater,
      onQuit: () => quitApp(),
    })

    try {
      await lifecycle.start()
    } catch (error) {
      dialog.showErrorBox('Dsh-white', `无法启动 dsh web：\n\n${String(error)}`)
      quitApp()
      return
    }
    const readyStatus = lifecycle.getStatus()
    const target = readyStatus.authUrl ?? `http://127.0.0.1:${String(readyStatus.port)}`
    if (target !== loadedUrl) {
      loadedUrl = target
      await mainWindow.loadURL(target)
    }
    logs.append(`[main] window loaded http://127.0.0.1:${String(readyStatus.port)}`)
    console.log(`[dsh-white] dsh web ready at http://127.0.0.1:${String(readyStatus.port)}`)
    updater.schedule()
    // `--open-panel` (dev/diagnostics): open the status panel at startup.
    if (process.argv.includes('--open-panel')) createPanel()
  })

  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault()
      quitApp()
    }
  })

  // With close-to-tray the main window never closes; if every window is
  // destroyed without quitting (e.g. closeToTray disabled + panel closed),
  // keep the tray alive.
  app.on('window-all-closed', () => {
    /* tray keeps the app running */
  })
}
