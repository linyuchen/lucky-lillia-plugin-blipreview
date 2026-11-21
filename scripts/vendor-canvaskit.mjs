// Copies the CanvasKit (Skia WebAssembly) runtime into lib/ so the published package needs no npm dependency for it.
// The .cjs extension keeps Node from treating the CommonJS loader as ESM inside this "type": "module" package.
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const source = dirname(require.resolve('canvaskit-wasm/bin/canvaskit.js'))
const target = join(import.meta.dirname, '..', 'lib', 'vendor', 'canvaskit')
mkdirSync(target, { recursive: true })
copyFileSync(join(source, 'canvaskit.js'), join(target, 'canvaskit.cjs'))
copyFileSync(join(source, 'canvaskit.wasm'), join(target, 'canvaskit.wasm'))
copyFileSync(join(source, '..', 'LICENSE'), join(target, 'LICENSE'))
console.log('Vendored CanvasKit ' + require('canvaskit-wasm/package.json').version + ' into lib/vendor/canvaskit')
