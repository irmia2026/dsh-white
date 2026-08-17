// Shared preload (CommonJS — sandboxed preloads cannot use ESM).
// Exposes `window.deepharness` to every window. The session-event mux
// listener lives in the main process (main.mjs) instead: Node 24 has a
// built-in WebSocket and the loopback trust fence passes it, so the preload
// only ever needs contextBridge + ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron')

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
