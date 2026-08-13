// Sound engine: a hidden renderer window synthesizes tones with WebAudio
// (zero audio assets), driven by IPC from the main process. Event→sound
// mapping is decided here, gated by app settings.
import { BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// dsh session/event types that carry meaning for the user.
function classifyFrame(frame) {
  if (frame?.type === 'session/event') {
    const eventType = frame.event?.type
    if (eventType === 'user/message') return { sound: 'turnStart', label: '回合开始' }
    if (eventType === 'assistant/message') return { sound: 'done', label: '任务完成' }
    return null
  }
  if (frame?.type === 'host/agent-error') return { sound: 'warning', label: 'Agent 错误' }
  return null
}

export function createSounds({ settings, onLog }) {
  let window = null

  function ensureWindow() {
    if (window !== null && !window.isDestroyed()) return window
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(HERE, 'preload-sounds.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    window.loadFile(path.join(HERE, '..', 'ui', 'sounds.html'))
    window.on('closed', () => { window = null })
    return window
  }

  /** Play one named sound, respecting settings. */
  function play(name) {
    const conf = settings.get().sound
    if (!conf.enabled) return
    const volume = Number.isFinite(conf.volume) ? conf.volume : 0.7
    if (name === 'turnStart' && !conf.turnStart) return
    if (name === 'done' && !conf.done) return
    if (name === 'ready' && !conf.ready) return
    if (name === 'warning' && !conf.warning) return
    try {
      const win = ensureWindow()
      win.webContents.send('sound:play', { name, volume })
    } catch (error) {
      onLog(`[sounds] playback failed: ${String(error)}`)
    }
  }

  /** Feed a mux frame; plays the mapped sound when one applies. */
  function onServerFrame(frame) {
    const mapped = classifyFrame(frame)
    if (mapped !== null) play(mapped.sound)
  }

  return { play, onServerFrame, ensureWindow }
}
