// Materialize the self-contained `dsh` runtime this desktop build ships.
//
// pnpm deploy cannot handle this workspace (link-overridden vendor packages,
// unsatisfied peers, ignored build scripts), so the closure is enumerated the
// way Node itself resolves it: walk @deepseek-ai/dsh's prod dependencies from
// the workspace's own node_modules wiring (where every build output already
// exists), copying each package instance once into a flat staging tree.
import { createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.dirname(HERE)
const REPO_ROOT = path.dirname(DESKTOP_DIR)
const CLI_DIR = path.join(REPO_ROOT, 'apps', 'cli')
const STAGING_DIR = path.join(DESKTOP_DIR, '.staging')
const OUT_DIR = path.join(STAGING_DIR, 'dsh')
const OUT_NODE_MODULES = path.join(OUT_DIR, 'node_modules')
// Do NOT skip 'doc'/'docs': at least one runtime package (yaml) keeps live
// code in dist/doc/directives.js. Only test/example/coverage dirs are safe.
const SKIP_DIRS = new Set(['tests', '__tests__', 'coverage', '__snapshots__', 'examples'])
// Runtime-dead file kinds: sourcemaps, debug symbols, TS sources/declarations,
// build caches, and C/C++ sources (their .node/.dll/.exe products are kept).
const SKIP_EXTENSIONS = new Set(['.map', '.pdb', '.tsbuildinfo', '.ts', '.tsx', '.cc', '.cpp', '.c', '.hh', '.hpp'])

function fail(message) {
  console.error(`materialize: ${message}`)
  process.exit(1)
}

// Files whose exec bit matters must survive the copy; cpSync preserves modes.
// `dereference` materializes stray file links, while nested `node_modules`
// directories are stripped entirely: they carry pnpm's per-instance symlink
// wiring (including dependency cycles like cordis ↔ cordis-plugin-include)
// that cannot be dereferenced and must not ship. The staged tree resolves
// every dependency through its own flat/nested layout instead.
// NB: `SKIP_DIRS.has(base)` — a Set has no `in` operator; the original
// `base in SKIP_DIRS` silently never matched and leaked 199 test dirs.
function copyPackage(sourceDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  cpSync(sourceDir, destDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const base = path.basename(src)
      if (base === 'node_modules') return false
      if (SKIP_DIRS.has(base)) {
        return !statSync(src, { throwIfNoEntry: false })?.isDirectory()
      }
      if (SKIP_EXTENSIONS.has(path.extname(base).toLowerCase())) return false
      return true
    },
  })
}

// The staged tree must be link-free: every symlink/junction either points back
// into the workspace (broken on other machines) or at an absolute dev path.
function assertLinkFree(rootDir) {
  const stack = [rootDir]
  let links = 0
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        links += 1
        if (links <= 5) console.warn(`materialize: staged link remains: ${full}`)
        continue
      }
      if (entry.isDirectory()) stack.push(full)
    }
  }
  if (links > 0) fail(`staged tree contains ${links} symbolic link(s); run materialize on a fresh staging (this copy is not self-contained)`)
}

function manifestOf(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

// Resolve `<name>/package.json` exactly as Node would from `requesterDir`,
// following the workspace's pnpm symlinks to the real package instance.
function resolveInstance(requesterDir, name) {
  const requester = createRequire(path.join(requesterDir, 'noop.js'))
  try {
    return path.dirname(requester.resolve(`${name}/package.json`))
  } catch {
    // Fall through to entry resolution.
  }
  try {
    // Exports maps without a ./package.json subpath: resolve the entry and
    // climb to the nearest package.json carrying the requested name.
    let dir = path.dirname(requester.resolve(name))
    for (;;) {
      const manifestPath = path.join(dir, 'package.json')
      if (existsSync(manifestPath) && manifestOf(dir).name === name) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // Fall through to a manual node_modules walk.
  }
  // Conditional exports that resolve for nobody (e.g. peer pi-ai on this
  // Node version): follow the workspace's own node_modules wiring upward.
  let dir = requesterDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// The staged copy of one package instance: flat for the first version of a
// name, nested under the requester that needs a conflicting version.
const stagedVersions = new Map()

function stageInstance(name, instanceDir, requesterStagedDir) {
  const version = manifestOf(instanceDir).version
  const primary = stagedVersions.get(name)
  if (primary !== undefined) {
    if (primary.version === version) return primary.stagedDir
    const nestedDir = path.join(requesterStagedDir, 'node_modules', name)
    if (!existsSync(nestedDir)) copyPackage(instanceDir, nestedDir)
    return nestedDir
  }
  const stagedDir = path.join(OUT_NODE_MODULES, name)
  stagedVersions.set(name, { version, stagedDir })
  copyPackage(instanceDir, stagedDir)
  return stagedDir
}

console.log('materialize: staging @deepseek-ai/dsh (apps/cli)')
rmSync(STAGING_DIR, { recursive: true, force: true })
mkdirSync(OUT_NODE_MODULES, { recursive: true })

const cliManifest = manifestOf(CLI_DIR)
mkdirSync(path.join(OUT_DIR, 'lib'), { recursive: true })
for (const file of readdirSync(path.join(CLI_DIR, 'lib'))) {
  if (file.endsWith('.js')) cpSync(path.join(CLI_DIR, 'lib', file), path.join(OUT_DIR, 'lib', file))
}
copyPackage(path.join(CLI_DIR, 'config'), path.join(OUT_DIR, 'config'))
// Upstream dsh-v0.1.2-alpha.1 turned shipped config trees (e.g.
// config/agent-presets, now living in packages/preset/agent-presets) into
// build-time mounts declared as `dsh.configTrees` in the CLI manifest:
// the source tree at `path` is mounted at `mount` of the packaged CLI.
// Replicate the mounts here so the staged runtime matches upstream's own
// packing. Older upstreams ship the trees inline under config/ and declare
// no mounts, in which case this loop is a no-op.
for (const tree of cliManifest.dsh?.configTrees ?? []) {
  const source = path.resolve(CLI_DIR, tree.path)
  if (!existsSync(source)) fail(`configTrees mount source missing: ${tree.path} (from ${CLI_DIR})`)
  copyPackage(source, path.join(OUT_DIR, tree.mount))
}
// Redistribution compliance: the harness license and third-party notices
// ride the closure root, next to the staged runtime.
for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  const src = path.join(REPO_ROOT, notice)
  if (existsSync(src)) cpSync(src, path.join(OUT_DIR, notice))
}
// The staged manifest keeps the CLI's full dependency list: profile boot
// heals `$DSH_HOME/profiles/node_modules` links FROM the installation
// anchor's declared dependencies, so bare specifiers in the profile config
// resolve into this staged tree. Without them every entry import fails with
// ERR_MODULE_NOT_FOUND from the profile directory.
writeFileSync(path.join(OUT_DIR, 'package.json'), `${JSON.stringify({
  name: cliManifest.name,
  version: cliManifest.version,
  type: 'module',
  bin: { dsh: 'lib/bin.js' },
  dependencies: cliManifest.dependencies,
}, null, 2)}\n`)
const cliStagedDir = OUT_DIR

// Breadth-first closure walk: prod dependencies plus every peerDependency,
// each resolved through the requester's own node_modules context so pnpm's
// per-instance wiring picks the exact version the requester uses.
const queue = []
for (const name of Object.keys(cliManifest.dependencies ?? {})) queue.push({ name, requesterDir: CLI_DIR, requesterStagedDir: cliStagedDir })
const visited = new Set()
while (queue.length > 0) {
  const { name, requesterDir, requesterStagedDir } = queue.shift()
  const key = `${requesterDir}::${name}`
  if (visited.has(key)) continue
  visited.add(key)
  const instanceDir = resolveInstance(requesterDir, name)
  if (instanceDir === null) {
    const requesterManifest = manifestOf(requesterDir)
    const optionalPeer = (requesterManifest.peerDependencies ?? {})[name] !== undefined
      && (requesterManifest.dependencies ?? {})[name] === undefined
    if (optionalPeer) {
      console.warn(`materialize: skipping unsatisfied optional peer ${name} (requested by ${requesterManifest.name})`)
      continue
    }
    fail(`cannot locate required package ${name} from ${requesterDir}`)
  }
  const stagedDir = stageInstance(name, instanceDir, requesterStagedDir)
  const manifest = manifestOf(instanceDir)
  const deps = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    // Platform native bindings ride optionalDependencies (koffi -> @koromix/koffi-*,
    // node-addon-require-builtin -> *-win32-x64-msvc, sharp -> @img/sharp-*):
    // only the current platform/arch triplet is needed. `includes` covers the
    // extra toolchain suffixes (-msvc, -gnu, -musl).
    ...Object.keys(manifest.optionalDependencies ?? {}).filter(
      dep => dep.includes(`-${process.platform}-${process.arch}`),
    ),
  ]
  for (const dep of deps) {
    if (dep.startsWith('@types/')) continue
    queue.push({ name: dep, requesterDir: instanceDir, requesterStagedDir: stagedDir })
  }
}

console.log(`materialize: staged ${stagedVersions.size} packages; verifying`)
assertLinkFree(OUT_DIR)

// Downstream hotfixes ride every staging (see the script header for why).
const { patchStagedDsh } = await import('./patch-staged-dsh.mjs')
patchStagedDsh(OUT_DIR)

function checkFile(file, label) {
  if (existsSync(file)) return
  fail(`missing ${label}: ${file}`)
}

/** Pass when at least one candidate exists (mirrors node-gyp-build's own lookup). */
function checkAny(files, label) {
  if (files.some(existsSync)) return
  fail(`missing ${label}: none of ${files.join(', ')}`)
}

checkFile(path.join(OUT_DIR, 'lib', 'bin.js'), 'dsh bin')
checkFile(path.join(OUT_DIR, 'config', 'agent-presets'), 'shipped agent presets')
const frontend = path.join(OUT_NODE_MODULES, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
checkFile(frontend, 'web frontend dist')
checkFile(path.join(OUT_NODE_MODULES, '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml'), 'web-app bundle patch')
checkFile(path.join(OUT_NODE_MODULES, '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js'), 'subprocess-local')
// koffi's native binding ships as a platform package (@koromix/koffi-<os>-<arch>),
// not as a `build/` directory inside the koffi package itself.
checkFile(path.join(OUT_NODE_MODULES, '@koromix', `koffi-${process.platform}-${process.arch}`, 'package.json'), `koffi native package (@koromix/koffi-${process.platform}-${process.arch})`)
if (process.platform === 'win32') {
  checkFile(path.join(OUT_NODE_MODULES, 'node-pty', 'build', 'Release', 'conpty', 'conpty.dll'), 'node-pty conpty.dll')
  checkFile(path.join(OUT_NODE_MODULES, 'node-pty', 'build', 'Release', 'conpty', 'OpenConsole.exe'), 'node-pty OpenConsole.exe')
} else if (process.platform === 'darwin') {
  // spawn-helper is a macOS-only build target (binding.gyp gates it on
  // OS=="mac"); it ships prebuilt or compiles to build/Release.
  checkAny([
    path.join(OUT_NODE_MODULES, 'node-pty', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
    path.join(OUT_NODE_MODULES, 'node-pty', 'build', 'Release', 'spawn-helper'),
  ], 'node-pty spawn-helper (darwin)')
} else {
  // Linux compiles pty.node from source at install (prebuilds/ when a
  // prebuilt was selected, build/Release/ when node-gyp rebuilt).
  checkAny([
    path.join(OUT_NODE_MODULES, 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'),
    path.join(OUT_NODE_MODULES, 'node-pty', 'build', 'Release', 'pty.node'),
  ], 'node-pty pty.node')
}

const bin = path.join(OUT_DIR, 'lib', 'bin.js')
execFileSync(process.execPath, [bin, '--version'], { stdio: ['ignore', 'inherit', 'inherit'] })
execFileSync(process.execPath, [bin, 'web', '--dump-config'], { stdio: ['ignore', 'ignore', 'inherit'] })

let files = 0
let bytes = 0
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.isFile()) {
      files += 1
      bytes += statSync(full).size
    }
  }
}
walk(OUT_DIR)

const manifest = {
  generator: 'desktop/scripts/materialize.mjs',
  generatedAt: new Date().toISOString(),
  dshPackage: cliManifest.name,
  dshVersion: cliManifest.version,
  runtimeNode: process.version,
  platform: `${process.platform}-${process.arch}`,
  packages: stagedVersions.size,
  files,
  bytes,
}
writeFileSync(path.join(OUT_DIR, 'materialize-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`materialize: dsh ${manifest.dshVersion} staged (${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB)`)
