// Downstream hotfix applied to the staged dsh runtime after every
// materialize: the Win32 folder-picker worker decodes the picked path with
// `koffi.view(address, ...)`, which wraps COM-allocated memory in an
// EXTERNAL ArrayBuffer. Electron's Node enables the V8 sandbox, which
// rejects external backing stores outside the sandbox cage; koffi's error
// path then aborts the worker via napi_fatal_error before it can report
// over IPC, surfacing in the GUI as
//   directory picker failed: win32 folder dialog worker exited before
//   reporting a result
// The fix reads the string with plain FFI calls (lstrlenW + RtlMoveMemory)
// into a JS-heap Buffer instead. Remove this script once the staged dsh
// release ships the equivalent fix upstream (the already-fixed marker below
// then makes this a no-op).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER_REL = path.join(
  'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs',
)
// Present both in this patch and in the upstream fix: skip when either landed.
const ALREADY_FIXED_MARKER = 'lstrlenW'
// The bug signature, stable across upstream tweaks to the surrounding loop
// (rc.2 used a single-byte NUL check, 0.1.2-alpha.1 checks both UTF-16
// bytes): any worker still decoding via koffi.view carries the crash.
const BUGGY_MARKER = 'koffi.view(address'
// The whole stock function, whatever its loop condition: from the opening
// line through the first closing brace at column 0 (the body never dedents
// that far).
const STOCK_FUNCTION = /function readUtf16\(koffi, address\) \{[\s\S]*?\n\}/
const PATCHED = `function readUtf16(koffi, address) {
	// Hotfix (dsh-white): koffi.view wraps native memory in an EXTERNAL
	// ArrayBuffer, which Electron's V8 sandbox rejects with a fatal napi
	// error. Copy instead: lstrlenW for the length, then RtlMoveMemory
	// into a JS-heap Buffer.
	const kernel32 = koffi.load("kernel32.dll");
	const lstrlenW = kernel32.func("__stdcall", "lstrlenW", "int32", ["void *"]);
	const rtlMoveMemory = kernel32.func("__stdcall", "RtlMoveMemory", "void", [
		"void *",
		"void *",
		"uintptr"
	]);
	const chars = lstrlenW(address);
	if (chars <= 0) return "";
	const bytes = Buffer.alloc(chars * 2);
	rtlMoveMemory(bytes, address, chars * 2);
	return bytes.toString("utf16le");
}`

/**
 * Apply the picker hotfix to the staged runtime under `outDir`.
 * Idempotent: silently skips an already-fixed worker, fails loudly when the
 * staged file matches neither the stock nor the fixed shape (upstream moved
 * — a human must re-derive this patch rather than ship a silently broken
 * picker).
 * @param {string} outDir - the staged dsh root (`.staging/dsh`).
 */
export function patchStagedDsh(outDir) {
  const worker = path.join(outDir, WORKER_REL)
  if (!existsSync(worker)) {
    console.warn(`patch-staged-dsh: ${WORKER_REL} not staged; skipping picker hotfix`)
    return
  }
  const text = readFileSync(worker, 'utf8')
  if (text.includes(ALREADY_FIXED_MARKER)) {
    console.log('patch-staged-dsh: picker worker already fixed; nothing to do')
    return
  }
  if (!text.includes(BUGGY_MARKER) || !STOCK_FUNCTION.test(text)) {
    console.error('patch-staged-dsh: staged worker.cjs matches neither the stock nor the fixed readUtf16; upstream changed — re-derive this hotfix before shipping')
    process.exit(1)
  }
  writeFileSync(worker, text.replace(STOCK_FUNCTION, PATCHED))
  console.log('patch-staged-dsh: applied V8-sandbox picker hotfix to staged worker.cjs')
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const outDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.staging', 'dsh')
  patchStagedDsh(outDir)
}
