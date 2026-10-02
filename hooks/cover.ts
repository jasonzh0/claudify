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

// Averages the cover's pixels over the cell [x0, x1) × [y0, y1) of a size×size grid.
const sample = (cover: Cover, size: number, x: number, y: number) => {
  const scale = cover.size / size
  const x0 = Math.floor(x * scale)
  const y0 = Math.floor(y * scale)
  const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale))
  const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale))
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const p = cover.pixels[yy * cover.size + xx] ?? 0
      r += (p >> 16) & 0xff
      g += (p >> 8) & 0xff
      b += p & 0xff
      n++
    }
  }
  return ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)) >>> 0
}

// Raster cells for a cover `columns` wide: each cell an upper half block, its
// foreground the top pixel and its background the bottom one.
export const coverCells = (cover: Cover, columns: number) => {
  const rows = columns / 2
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < columns; x++) {
      const at = (row * columns + x) * 3
      words[at] = 0x2580
      words[at + 1] = sample(cover, columns, x, row * 2)
      words[at + 2] = sample(cover, columns, x, row * 2 + 1)
    }
  }
  return encodeBase64(new Uint8Array(words.buffer))
}

// The cover as ASCII art, one character per cell, for surfaces without Raster.
export const coverAscii = (cover: Cover, columns: number) => {
  const ramp = ' .:-=+*#%@'
  const rows = columns / 2
  const lines: string[] = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    for (let x = 0; x < columns; x++) {
      // A cell is twice as tall as wide: average its two pixel rows.
      const a = sample(cover, columns, x, row * 2)
      const b = sample(cover, columns, x, row * 2 + 1)
      const luma = (p: number) => 0.2126 * ((p >> 16) & 0xff) + 0.7152 * ((p >> 8) & 0xff) + 0.0722 * (p & 0xff)
      const level = (luma(a) + luma(b)) / 2 / 256
      line += ramp[Math.min(ramp.length - 1, Math.floor(level * ramp.length))]
    }
    lines.push(line)
  }
  return lines
}

// A dark shade of the cover's average color, for a background that keeps the
// sidebar's text readable: the hue kept, the brightness brought down to ~20%.
export const coverTint = (cover: Cover) => {
  let r = 0
  let g = 0
  let b = 0
  for (const p of cover.pixels) {
    r += (p >> 16) & 0xff
    g += (p >> 8) & 0xff
    b += p & 0xff
  }
  const n = Math.max(1, cover.pixels.length)
  ;[r, g, b] = [r / n, g / n, b / n]
  const scale = 52 / Math.max(1, r, g, b)
  const hex = (v: number) => Math.round(Math.min(255, v * scale)).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}
