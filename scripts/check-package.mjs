import { createHash } from 'node:crypto'
import { readFile, mkdir, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const [reportPath, destination] = process.argv.slice(2)
if (!reportPath || !destination) throw new Error('Usage: node scripts/check-package.mjs PACK_JSON DESTINATION')
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
const pkg = await readJson('package.json')
const lock = await readJson('package-lock.json')
for (const [path, entry] of Object.entries(lock.packages)) {
  if (entry.link || (path && !path.startsWith('node_modules/'))) throw new Error('Local path remains in package-lock.json: ' + path)
}
const [pack] = await readJson(reportPath)
if (pack.name !== pkg.name || pack.version !== pkg.version) throw new Error('Packed package identity differs from package.json')
const files = new Set(pack.files.map(file => file.path))
for (const path of [
  'package.json', 'README.md', 'LICENSE',
  pkg.main, pkg.types, pkg.llbot.webui, pkg.llbot.icon, pkg.llbot.details,
  ...(pkg.llbot.screenshots ?? []).map(image => typeof image === 'string' ? image : image.src),
]) {
  if (!files.has(path)) throw new Error('Required package file is missing: ' + path)
}
for (const path of files) {
  if (!/^(lib|src|webui|assets)\//.test(path) && !['package.json', 'README.md', 'LICENSE'].includes(path)) {
    throw new Error('Unexpected file in the npm package: ' + path)
  }
}
for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const [name, range] of Object.entries(pkg[section] ?? {})) {
    if (/^(file:|link:|workspace:)/.test(range)) throw new Error('Local dependency cannot be released: ' + name)
  }
}
const archive = resolve(pack.filename)
const integrity = 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64')
if (integrity !== pack.integrity) throw new Error('Package integrity does not match the npm pack report')
await mkdir(destination, { recursive: true })
await copyFile(archive, join(destination, 'package.tgz'))
console.log(pkg.name + '@' + pkg.version + ': checked ' + files.size + ' files; ready to publish')
