// Spotify's side of things that needs no engine: login URLs, parsing the Web
// API's answers, and the text the plugin shows.
import type { NowPlaying } from '../types'

export const PORT = 8888
export const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`
export const API = 'https://api.spotify.com/v1'
export const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing'

// The claudify Spotify app. PKCE needs no secret, so a Client ID is safe to
// ship; Spotify lets an app in development mode serve the 25 users its owner
// adds in the dashboard, so anyone else brings their own with /spotify setup.
export const DEFAULT_CLIENT_ID = '82881264abd946b889b4d5bca7d72446'

export type ApiResult = { status: number; json: any }

export const SETUP_HELP = `Use your own Spotify app (about a minute, no user limit):
  1. Open https://developer.spotify.com/dashboard and create an app.
  2. Add the Redirect URI ${REDIRECT_URI} and tick "Web API".
  3. Copy the app's Client ID and run: /spotify setup <client-id>
  4. Run /spotify login
To go back to the built-in app: /spotify setup default`

export const NOT_REGISTERED = `Spotify refused this account for the built-in claudify app: while it is in
development mode Spotify only lets accounts its owner has added use it.
Ask the owner to add your Spotify email, or use your own app:

${SETUP_HELP}`

export const USAGE = `/spotify                 open the player sidebar
/spotify now             what is playing
/spotify close           close the player sidebar
/spotify play [query]    resume, or search a track and play it
/spotify playlist <q>    search a playlist and play it
/spotify pause | toggle | next | prev
/spotify vol <0-100> | mute
/spotify shuffle on|off | repeat off|context|track
/spotify bg terminal|none|album|#rrggbb   sidebar background
/spotify devices         list devices
/spotify login | logout  connect or disconnect your account
/spotify setup <id>      use your own Spotify app (setup default: the built-in one)
/spotify code <url>      finish login by pasting the redirected URL`

// The page the browser shows after Spotify redirects back, as nc's reply.
const PAGE =
  '<html><body style="font-family:system-ui;text-align:center;padding-top:4em">' +
  '<h2>Spotify connected to Claude Code</h2><p>You can close this tab.</p></body></html>'
export const CALLBACK_RESPONSE =
  'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n' +
  `Content-Length: ${new TextEncoder().encode(PAGE).length}\r\n\r\n${PAGE}`

export const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()

export const randomString = (length: number) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), b => chars[b % chars.length]).join('')
}

export const authorizeUrl = async (clientId: string, verifier: string, state: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `https://accounts.spotify.com/authorize?${form({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  })}`
}

export const parseJson = (text: string) => {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const names = (artists?: { name: string }[]) => artists?.map(a => a.name).join(', ')

// GET /me/player's answer as the player's state, or null when nothing plays.
export const parsePlayer = (json: any, fetchedAt: number): NowPlaying | null => {
  const item = json?.item
  if (!item) return null
  const images: { url: string; width: number }[] = item.album?.images ?? item.images ?? []
  return {
    trackId: item.id ?? item.uri ?? item.name,
    title: item.name,
    artist: names(item.artists) ?? item.show?.name ?? '',
    album: item.album?.name ?? item.show?.name ?? '',
    // The smallest image at least 64px wide: the cover is drawn at 40px.
    coverUrl: [...images].sort((a, b) => a.width - b.width).find(i => i.width >= 64)?.url ?? images[0]?.url ?? null,
    isPlaying: Boolean(json.is_playing),
    progressMs: json.progress_ms ?? 0,
    durationMs: item.duration_ms ?? 0,
    fetchedAt,
    device: json.device?.name ?? '',
    volume: json.device?.volume_percent ?? null,
    shuffle: Boolean(json.shuffle_state),
    repeat: json.repeat_state ?? 'off',
  }
}

export const parseQueue = (json: any): string[] =>
  ((json?.queue ?? []) as any[]).slice(0, 5).map(t => `${t.name} — ${names(t.artists) ?? t.show?.name ?? ''}`)

export const describeHit = (hit: any, type: 'track' | 'playlist') => {
  const by = type === 'track' ? names(hit.artists) : hit.owner?.display_name
  return `Playing ${type === 'playlist' ? 'playlist ' : ''}${hit.name}${by ? ` — ${by}` : ''}`
}

export const describe = (p: NowPlaying) =>
  `${p.isPlaying ? 'Playing' : 'Paused'}: ${p.title} — ${p.artist} (${clock(p.progressMs)}/${clock(p.durationMs)})` +
  (p.device ? ` on ${p.device}` : '') +
  (p.volume === null ? '' : `, volume ${p.volume}%`)

export const isNotRegistered = (r: ApiResult) => r.status === 403 && /registered/i.test(r.json?.error?.message ?? '')

export const isNoDevice = (r: ApiResult) => r.json?.error?.reason === 'NO_ACTIVE_DEVICE' || r.status === 404

// Why a player command failed, in words the person can act on.
export const explain = (r: ApiResult) => {
  if (isNotRegistered(r)) return NOT_REGISTERED
  if (r.json?.error?.reason === 'PREMIUM_REQUIRED' || r.status === 403) {
    return 'Spotify only allows playback control for Premium accounts.'
  }
  if (isNoDevice(r)) return 'No active Spotify device. Open Spotify on any device and try again.'
  return r.json?.error?.message ?? `Spotify answered ${r.status}.`
}

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// The track's position at `at`, moved on from the last poll while it plays.
export const progressAt = (p: NowPlaying, at: number) =>
  Math.min(p.durationMs, p.progressMs + (p.isPlaying ? Math.max(0, at - p.fetchedAt) : 0))

export const progressBar = (progress: number, duration: number, width: number) => {
  const at = duration ? Math.min(width - 1, Math.floor((progress / duration) * width)) : 0
  return `${'━'.repeat(at)}●${'─'.repeat(Math.max(0, width - at - 1))}`
}
