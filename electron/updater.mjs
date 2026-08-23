// electron-updater wrapper: "check automatically, install manually".
//
// - Auto-check: 30 s after startup and every 4 hours (configurable).
// - `autoDownload: false` — the user must click "下载并安装".
// - After the download finishes, the panel offers "重启以安装" (quitAndInstall).
// - Enabled only in packaged builds; NSIS (win32) and dmg/zip (darwin) only;
//   portable Windows builds cannot self-update and skip this entirely.
import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
// electron-updater is CJS; the ESM named-export interop cannot see its keys,
// so take the namespace default and destructure.
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

const CHECK_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export function createUpdater({ settings, onLog, onState, useDirectConnection }) {
  let state = { phase: 'idle', version: null, error: null, progress: null, current: app.getVersion() }
  let timer = null
  const listeners = new Set()

  // A local system proxy (e.g. Clash/Mihomo on 127.0.0.1 with a broken rule
  // for github.com) kills TLS to GitHub: the check dies with
  // net::ERR_CONNECTION_CLOSED while direct connectivity is fine. Electron's
  // net stack follows the system proxy by default, so on a proxy-shaped
  // network failure switch the default session to direct and retry ONCE.
  // The default session otherwise only talks to localhost, so this is safe.
  let triedDirect = false
  const PROXY_SHAPED = /ERR_(CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_REFUSED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|TIMED_OUT)|SSL connection/i

  async function withDirectFallback(operation) {
    try {
      return await operation()
    } catch (error) {
      if (triedDirect || typeof useDirectConnection !== 'function' || !PROXY_SHAPED.test(String(error))) {
        throw error
      }
      triedDirect = true
      onLog('[updater] proxy-shaped network failure — retrying over a direct connection')
      await useDirectConnection()
      return operation()
    }
  }

  const emit = (patch) => {
    state = { ...state, ...patch, current: app.getVersion() }
    onState(state)
    for (const listener of listeners) {
      try { listener(state) } catch { /* contained */ }
    }
  }

  // Unpacked/dev builds carry no app-update.yml; checking against one would
  // spam ENOENT into the log on every schedule tick.
  const canUpdate = () => app.isPackaged
    && (process.platform === 'win32' || process.platform === 'darwin')
    && existsSync(path.join(process.resourcesPath, 'app-update.yml'))

  function attach() {
    if (!canUpdate()) return
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => {
      emit({ phase: 'checking', error: null })
      onLog('[updater] checking for updates')
    })
    autoUpdater.on('update-available', (info) => {
      emit({ phase: 'available', version: info.version, error: null })
      onLog(`[updater] update available: v${info.version} (current v${app.getVersion()})`)
    })
    autoUpdater.on('update-not-available', () => {
      emit({ phase: 'none', error: null })
      onLog('[updater] no update available')
    })
    autoUpdater.on('error', (error) => {
      emit({ phase: 'error', error: String(error) })
      onLog(`[updater] error: ${String(error)}`)
    })
    autoUpdater.on('download-progress', (progress) => {
      emit({ phase: 'downloading', progress })
    })
    autoUpdater.on('update-downloaded', (info) => {
      emit({ phase: 'downloaded', version: info.version, error: null })
      onLog(`[updater] v${info.version} downloaded — install on restart`)
    })
  }

  function schedule() {
    if (!settings.get().updaterAutoCheck) return
    attach()
    if (!canUpdate()) return
    timer = setTimeout(() => {
      void checkNow()
      timer = setInterval(() => { void checkNow() }, CHECK_INTERVAL_MS)
    }, CHECK_DELAY_MS)
  }

  async function checkNow() {
    if (!canUpdate()) {
      emit({ phase: 'disabled', error: null })
      return
    }
    try {
      await withDirectFallback(() => autoUpdater.checkForUpdates())
    } catch (error) {
      emit({ phase: 'error', error: String(error) })
      onLog(`[updater] check failed: ${String(error)}`)
    }
  }

  async function downloadAndInstall() {
    if (!canUpdate()) return
    try {
      await withDirectFallback(() => autoUpdater.downloadUpdate())
    } catch (error) {
      emit({ phase: 'error', error: String(error) })
      onLog(`[updater] download failed: ${String(error)}`)
    }
  }

  function quitAndInstall() {
    if (state.phase === 'downloaded' && canUpdate()) {
      autoUpdater.quitAndInstall(false, true)
    }
  }

  return {
    schedule,
    checkNow,
    downloadAndInstall,
    quitAndInstall,
    canUpdate,
    onState(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getState: () => state,
  }
}
