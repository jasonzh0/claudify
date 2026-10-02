export type NowPlaying = {
  trackId: string
  title: string
  artist: string
  album: string
  coverUrl: string | null
  isPlaying: boolean
  progressMs: number
  durationMs: number
  // When progressMs was read, so the drawing can move the bar between polls.
  fetchedAt: number
  device: string
  volume: number | null
  shuffle: boolean
  repeat: 'off' | 'context' | 'track'
}

// The album art, sampled to a square of RGB pixels (0xRRGGBB), row-major.
export type Cover = { url: string; size: number; pixels: number[] }

declare module 'claude-code' {
  interface PluginState {
    claudify: {
      now: NowPlaying | null
      cover: Cover | null
      queue: string[]
      isConnected: boolean
      background: string
      terminalColor: string | null
    }
  }
}
