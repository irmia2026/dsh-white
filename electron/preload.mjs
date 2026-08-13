// Shared preload for every window: exposes the `window.deepharness` API.
//
// In the dsh UI window the preload additionally opens the /api/events.mux
// WebSocket (same-origin, loopback trust fence passes automatically) and
// forwards session frames to the main process, which maps them to sounds.
// This is the "no dsh source changes" hook for the sound system.
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // ── status ────────────────────────────────────────────────────────────────
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('app:status', listener)
    return () => ipcRenderer.removeListener('app:status', listener)
  },

  // ── logs ──────────────────────────────────────────────────────────────────
  getLogs: () => ipcRenderer.invoke('app:get-logs'),
  onLog: (callback) => {
    const listener = (_event, line) => callback(line)
    ipcRenderer.on('app:log', listener)
    return () => ipcRenderer.removeListener('app:log', listener)
  },

  // ── settings ──────────────────────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('app:set-settings', patch),
  onSettings: (callback) => {
    const listener = (_event, settings) => callback(settings)
    ipcRenderer.on('app:settings', listener)
    return () => ipcRenderer.removeListener('app:settings', listener)
  },

  // ── updater ───────────────────────────────────────────────────────────────
  getUpdateState: () => ipcRenderer.invoke('app:get-update'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('app:update', listener)
    return () => ipcRenderer.removeListener('app:update', listener)
  },

  // ── window / tray helpers ─────────────────────────────────────────────────
  hideWindow: () => ipcRenderer.invoke('app:window-hide'),
  showWindow: () => ipcRenderer.invoke('app:window-show'),
  quit: () => ipcRenderer.invoke('app:quit'),

  // ── sounds ────────────────────────────────────────────────────────────────
  playSound: (name) => ipcRenderer.invoke('app:play-sound', name),

  // ── metadata ──────────────────────────────────────────────────────────────
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  platform: process.platform,
}

contextBridge.exposeInMainWorld('deepharness', api)

// ── dsh UI window: mux listener ────────────────────────────────────────────
// The preload runs in every window; only the window actually loading the dsh
// UI (http origin) opens the event socket.
if (typeof location !== 'undefined' && location.protocol === 'http:') {
  let socket = null
  let reconnectTimer = null
  let stopped = false

  const connect = () => {
    if (stopped) return
    const url = new URL('/api/events.mux', location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(url)
    socket.addEventListener('open', () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    })
    socket.addEventListener('message', (event) => {
      try {
        const envelope = JSON.parse(String(event.data))
        if (envelope && envelope.payload) {
          ipcRenderer.send('app:server-event', envelope.payload)
        }
      } catch {
        // Malformed frame: ignore, the stream continues.
      }
    })
    socket.addEventListener('close', () => {
      if (stopped) return
      reconnectTimer = setTimeout(connect, 2000)
    })
  }
  connect()
  window.addEventListener('beforeunload', () => {
    stopped = true
    try { socket?.close() } catch { /* already closed */ }
  })
}
