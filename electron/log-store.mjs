// Log store for the dsh sidecar: memory ring for the panel + append to a
// rotating file. The ring survives restarts of the sidecar; the file survives
// app restarts (rotation keeps the last three generations).
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RING_CAPACITY = 2000
const ROTATE_BYTES = 8 * 1024 * 1024
const ROTATE_KEEP = 3

export function createLogStore(userDataDir) {
  const file = join(userDataDir, 'dsh-web.log')
  const ring = []

  // Rotate once at startup if the previous run's log grew large.
  if (existsSync(file) && statSync(file).size > ROTATE_BYTES) {
    for (let i = ROTATE_KEEP - 1; i >= 1; i -= 1) {
      const from = i === 1 ? file : `${file}.${i - 1}`
      const to = `${file}.${i}`
      if (existsSync(from)) renameSync(from, to)
    }
  }

  mkdirSync(userDataDir, { recursive: true })
  const stream = createWriteStream(file, { flags: 'a' })
  const listeners = new Set()

  function append(line) {
    // ISO timestamp prefix: sequencing is the whole point of a log.
    const stamped = `${new Date().toISOString()} ${line}`
    ring.push(stamped)
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY)
    stream.write(`${stamped}\n`)
    for (const listener of listeners) {
      try { listener(stamped) } catch { /* contained */ }
    }
  }

  return {
    append,
    /** Tail of the ring, oldest first. */
    tail(count = 500) {
      return ring.slice(Math.max(0, ring.length - count))
    },
    onLine(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    end() {
      stream.end()
    },
  }
}
