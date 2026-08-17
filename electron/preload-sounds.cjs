// Tiny preload for the hidden sounds window (CJS: sandboxed preloads).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deepharnessSounds', {
  onPlay: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sound:play', listener)
    return () => ipcRenderer.removeListener('sound:play', listener)
  },
})
