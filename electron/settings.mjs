// Application-level settings store (userData/settings.json).
//
// Deliberately separate from `~/.dsh` (the dsh runtime's own config domain):
// these are the shell's own preferences — tray behavior, sounds, updater.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_SETTINGS = Object.freeze({
  closeToTray: true,
  autoLaunch: false,
  sound: {
    enabled: true,
    volume: 0.7,
    turnStart: false,
    done: true,
    ready: true,
    warning: true,
  },
  updaterAutoCheck: true,
})

export function createSettings(userDataDir) {
  const file = join(userDataDir, 'settings.json')
  let settings = { ...DEFAULT_SETTINGS }
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      sound: { ...DEFAULT_SETTINGS.sound, ...(parsed.sound ?? {}) },
    }
  } catch {
    // First run or unreadable file: defaults, will be written on first change.
  }

  const listeners = new Set()
  const emit = () => {
    for (const listener of listeners) {
      try { listener(settings) } catch { /* listener fault is contained */ }
    }
  }

  function save() {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  }

  return {
    get() { return settings },
    /** Apply a shallow patch (nested `sound` object is merged). */
    set(patch) {
      settings = {
        ...settings,
        ...patch,
        sound: { ...settings.sound, ...(patch.sound ?? {}) },
      }
      save()
      emit()
      return settings
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
