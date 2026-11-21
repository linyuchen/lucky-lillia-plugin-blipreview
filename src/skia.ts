import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { CanvasKit } from 'canvaskit-wasm'

/** What the emulated canvas really returns: canvaskit's typings describe CanvasKit images instead. */
export interface EmulatedImage { readonly width: number; readonly height: number }

export interface Canvas {
  dispose(): void
  /** Throws on bytes Skia cannot decode (JPEG, PNG, WebP, GIF and BMP are supported). */
  decodeImage(bytes: Uint8Array): EmulatedImage
  getContext(type: '2d'): Context2D | null
  loadFont(bytes: ArrayBuffer, descriptors: Record<string, string>): void
  makePath2D(path?: string): Path2D
  toDataURL(codec?: string): string
}

/** The emulated 2D context. It ignores textAlign and textBaseline: use {@link Drawing.text}. */
export type Context2D = Omit<CanvasRenderingContext2D, 'drawImage'> & {
  drawImage(image: EmulatedImage, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void
  drawImage(image: EmulatedImage, dx: number, dy: number): void
}

const makeCanvas = (kit: CanvasKit, width: number, height: number) => kit.MakeCanvas(width, height) as unknown as Canvas

/** The single family every drawing uses: CanvasKit has no system fonts and matches the name exactly. */
export const FONT = 'NotoSansSC'

const require = createRequire(import.meta.url)
const vendored = fileURLToPath(new URL('./vendor/canvaskit/canvaskit.cjs', import.meta.url))
const fontFile = fileURLToPath(new URL('../assets/fonts/NotoSansSC-Regular.otf', import.meta.url))

interface Skia { kit: CanvasKit; middle: number }
let loading: Promise<Skia> | undefined

/**
 * CanvasKit (Skia compiled to WebAssembly) with the bundled font. Loaded once on first use: the font is registered
 * through a canvas that is never disposed, because the emulated canvases share one font table.
 */
function skia(): Promise<Skia> {
  loading ??= (async () => {
    // Published packages carry a vendored copy (scripts/vendor-canvaskit.mjs); the source tree uses the dev dependency.
    const script = existsSync(vendored) ? vendored : require.resolve('canvaskit-wasm/bin/canvaskit.js')
    const init = require(script) as (options: { locateFile(file: string): string }) => Promise<CanvasKit>
    const directory = script.slice(0, Math.max(script.lastIndexOf('/'), script.lastIndexOf('\\')) + 1)
    const kit = await init({ locateFile: file => directory + file })
    const file = readFileSync(fontFile)
    const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
    makeCanvas(kit, 1, 1).loadFont(bytes, { family: FONT, style: 'normal', weight: '400' })
    // The emulated context ignores textBaseline; `middle` puts the centre of the font's line box on y.
    const typeface = kit.Typeface.MakeTypefaceFromData(bytes)
    if (!typeface) throw new Error('无法加载内置字体')
    const font = new kit.Font(typeface, 1)
    const { ascent, descent } = font.getMetrics()
    font.delete()
    typeface.delete()
    return { kit, middle: -(ascent + descent) / 2 }
  })()
  loading.catch(() => { loading = undefined })
  return loading
}

export interface Drawing {
  canvas: Canvas
  context: Context2D
  /**
   * fillText with the alignment the emulation ignores. `middle` is the font size when y is the vertical middle
   * (textBaseline 'middle'); without it y is the alphabetic baseline.
   */
  text(text: string, x: number, y: number, options?: { align?: 'left' | 'center' | 'right'; middle?: number }): void
  png(): Buffer
}

export async function createDrawing(width: number, height: number): Promise<Drawing> {
  const { kit, middle } = await skia()
  const canvas = makeCanvas(kit, width, height)
  const context = canvas.getContext('2d')!
  return {
    canvas,
    context,
    text(text, x, y, { align = 'left', middle: size } = {}) {
      const width = align === 'left' ? 0 : context.measureText(text).width
      context.fillText(text, align === 'right' ? x - width : align === 'center' ? x - width / 2 : x, y + (size ? middle * size : 0))
    },
    png() {
      const url = canvas.toDataURL('image/png')
      return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    },
  }
}

/** Runs a drawing and always releases its WebAssembly memory, which the garbage collector does not track. */
export async function draw<T>(width: number, height: number, task: (drawing: Drawing) => T | Promise<T>): Promise<T> {
  const drawing = await createDrawing(width, height)
  try {
    return await task(drawing)
  } finally {
    drawing.canvas.dispose()
  }
}
