// electron-builder afterPack hook: copy the materialized dsh closure into the
// packaged resources. extraResources cannot be used for this: its file matcher
// applies the default node_modules exclusions, silently dropping the closure's
// dependency tree (observed: only 17 files copied). A plain fs copy is the
// only behavior we can fully rely on.
const { cpSync } = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  const source = path.join(context.packager.projectDir, '.staging', 'dsh')
  const dest = path.join(context.appOutDir, 'resources', 'dsh')
  if (!require('node:fs').existsSync(path.join(source, 'lib', 'bin.js'))) {
    throw new Error(`after-pack: staged closure missing at ${source}; run \`node scripts/materialize.mjs\` first`)
  }
  cpSync(source, dest, { recursive: true, dereference: true })
  const { statSync } = require('node:fs')
  const bytes = statSync(dest).size
  console.log(`after-pack: closure copied to resources/dsh (${(bytes / 1024 / 1024).toFixed(1)} MiB)`)
}
