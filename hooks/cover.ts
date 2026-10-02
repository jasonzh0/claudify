import type { Cover } from '../types'

// The resolution a cover is kept at; drawings sample it down to their width.
export const COVER_SIZE = 40

// Downloads the album art and has macOS's sips scale it to a BMP, which is
// trivial to decode here (the hooks environment has no image decoder).
export const FETCH_SCRIPT =
  'd=$(mktemp -d) && curl -sfL "$1" -o "$d/c.jpg" && ' +
  'sips -s format bmp -z "$2" "$2" "$d/c.jpg" --out "$d/c.bmp" >/dev/null && ' +
  'base64 -i "$d/c.bmp"; rm -rf "$d"'

const decodeBase64 = (text: string) => {
  const raw = atob(text.replace(/\s+/g, ''))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

const encodeBase64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

// Reads an uncompressed 24- or 32-bit BMP into 0xRRGGBB pixels, top row first.
const decodeBmp = (bytes: Uint8Array): { width: number; height: number; pixels: number[] } | undefined => {
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = view.getUint32(10, true)
  const width = view.getInt32(18, true)
  const rawHeight = view.getInt32(22, true)
  const bpp = view.getUint16(28, true)
  if (bpp !== 24 && bpp !== 32) return undefined
  const height = Math.abs(rawHeight)
  const isBottomUp = rawHeight > 0
  const stride = Math.ceil((bpp * width) / 32) * 4
  const step = bpp / 8
  const pixels: number[] = []
  for (let y = 0; y < height; y++) {
    const row = offset + (isBottomUp ? height - 1 - y : y) * stride
    for (let x = 0; x < width; x++) {
      const at = row + x * step
      pixels.push(((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at] ?? 0))
    }
  }
  return { width, height, pixels }
}

// The cover a run of FETCH_SCRIPT printed, or undefined when it printed none.
export const coverFromOutput = (url: string, stdout: string): Cover | undefined => {
  const image = stdout.trim() ? decodeBmp(decodeBase64(stdout)) : undefined
  if (!image || image.width !== image.height) return undefined
  return { url, size: image.width, pixels: image.pixels }
}

const rgb = (p: number) => [(p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff] as const
const pack = (r: number, g: number, b: number) => ((Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)) >>> 0

// The average color of some pixels.
const average = (pixels: number[]) => {
  const sum = [0, 0, 0]
  for (const p of pixels) rgb(p).forEach((v, i) => (sum[i]! += v))
  const n = Math.max(1, pixels.length)
  return sum.map(v => v / n) as [number, number, number]
}

// The cover's color over cell (x, y) of a size×size grid laid over it.
const sample = (cover: Cover, size: number, x: number, y: number) => {
  const scale = cover.size / size
  const [x0, y0] = [Math.floor(x * scale), Math.floor(y * scale)]
  const [x1, y1] = [Math.max(x0 + 1, Math.floor((x + 1) * scale)), Math.max(y0 + 1, Math.floor((y + 1) * scale))]
  const pixels: number[] = []
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) pixels.push(cover.pixels[yy * cover.size + xx] ?? 0)
  return pack(...average(pixels))
}

// Raster cells for a cover `columns` wide: each cell an upper half block, its
// foreground the top pixel and its background the bottom one.
export const coverCells = (cover: Cover, columns: number) => {
  const words: number[] = []
  for (let row = 0; row < columns / 2; row++) {
    for (let x = 0; x < columns; x++) words.push(0x2580, sample(cover, columns, x, row * 2), sample(cover, columns, x, row * 2 + 1))
  }
  return encodeBase64(new Uint8Array(Uint32Array.from(words).buffer))
}

// The cover as ASCII art, one character per cell, for surfaces without Raster.
export const coverAscii = (cover: Cover, columns: number) => {
  const ramp = ' .:-=+*#%@'
  const luma = (p: number) => {
    const [r, g, b] = rgb(p)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 256
  }
  return Array.from({ length: columns / 2 }, (_, row) =>
    Array.from({ length: columns }, (_, x) => {
      // A cell is two pixels tall: average their brightness.
      const level = (luma(sample(cover, columns, x, row * 2)) + luma(sample(cover, columns, x, row * 2 + 1))) / 2
      return ramp[Math.min(ramp.length - 1, Math.floor(level * ramp.length))]
    }).join(''),
  )
}

// A dark shade of the cover's average color, for a background that keeps the
// sidebar's text readable: the hue kept, the brightest channel brought to 52.
export const coverTint = (cover: Cover) => {
  const color = average(cover.pixels)
  const scale = 52 / Math.max(1, ...color)
  return `#${pack(...(color.map(v => Math.min(255, v * scale)) as [number, number, number])).toString(16).padStart(6, '0')}`
}
