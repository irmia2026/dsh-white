// DeepHarness Desktop — Electron main process.
//
// Architecture (see HANDOFF.md): Electron shell + sidecar dsh child process
// (ELECTRON_RUN_AS_NODE), BrowserWindow loading http://127.0.0.1:<port>.
//
// Features layered on top:
// - tray + close-to-tray + auto-launch
// - supervised sidecar lifecycle with exponential-backoff self-healing
// - status/log panel (local HTML + IPC)
// - electron-updater: check automatically, install manually
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
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

function dshRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dsh')
    : path.join(HERE, '..', '.staging', 'dsh')
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepHarness Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
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
    title: 'DeepHarness 状态与日志',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  panelWindow.loadFile(path.join(HERE, '..', 'ui', 'panel.html'))
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

    updater = createUpdater({
      settings,
      onLog: (line) => logs.append(line),
      onState: (state) => {
        if (panelWindow !== null && !panelWindow.isDestroyed()) {
          panelWindow.webContents.send('app:update', state)
        }
      },
    })
    lifecycle = createDshLifecycle({
      dshRoot: dshRoot(),
      env: process.env,
      onLog: (line) => logs.append(line),
      onStatus: (status) => {
        if (panelWindow !== null && !panelWindow.isDestroyed()) {
          panelWindow.webContents.send('app:status', status)
        }
        if (tray !== undefined) tray.refresh()
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
    ipcMain.handle('app:get-version', () => app.getVersion())

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
      dialog.showErrorBox('DeepHarness Desktop', `无法启动 dsh web：\n\n${String(error)}`)
      quitApp()
      return
    }
    await mainWindow.loadURL(`http://127.0.0.1:${String(lifecycle.getStatus().port)}`)
    logs.append(`[main] window loaded http://127.0.0.1:${String(lifecycle.getStatus().port)}`)
    console.log(`[deepharness-desktop] dsh web ready at http://127.0.0.1:${String(lifecycle.getStatus().port)}`)
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
