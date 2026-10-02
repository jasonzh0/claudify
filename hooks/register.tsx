import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NowPlaying } from '../types'
import { COVER_SIZE, coverAscii, coverCells, coverFromOutput, coverTint, FETCH_SCRIPT } from './cover'

// Spotify Web API with the Authorization Code + PKCE flow: no client secret,
// only the Client ID of an app the person creates in the Spotify dashboard.
const PORT = 8888
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
].join(' ')
const API = 'https://api.spotify.com/v1'
const POLL_MS = 5000
const PANE = 'spotify'
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

const now = atom({ plugin: 'claudify', key: 'now' } as const, null)
const isConnected = atom({ plugin: 'claudify', key: 'isConnected' } as const, false)
const cover = atom({ plugin: 'claudify', key: 'cover' } as const, null)
const queue = atom({ plugin: 'claudify', key: 'queue' } as const, [])
// The sidebar's background: 'terminal' (the terminal's own color painted over
// Claude Code's darker pane), 'none', 'album', or '#rrggbb'.
const background = atom({ plugin: 'claudify', key: 'background' } as const, 'terminal')
const terminalColor = atom({ plugin: 'claudify', key: 'terminalColor' } as const, null)

// Ghostty's own background, read from its config; Ghostty's default when unset.
const GHOSTTY_DEFAULT_BACKGROUND = '#282c34'

const detectTerminalColor = async ($: $): Promise<string | null> => {
  if ((await $.env.get('TERM_PROGRAM')) !== 'ghostty') return null
  const home = await $.env.get('HOME')
  const configs = [
    `${home}/.config/ghostty/config`,
    `${home}/Library/Application Support/com.mitchellh.ghostty/config.ghostty`,
    `${home}/Library/Application Support/com.mitchellh.ghostty/config`,
  ]
  let color: string | null = null
  for (const path of configs) {
    try {
      const text = await $.fs.read(path)
      const match = text.match(/^\s*background\s*=\s*#?([0-9a-fA-F]{6})\s*$/m)
      if (match?.[1]) color = `#${match[1].toLowerCase()}`
    } catch {}
  }
  return color ?? GHOSTTY_DEFAULT_BACKGROUND
}

type $ = EngineInterface
type Tokens = { access: string; refresh: string; expiresAt: number }
type ApiResult = { status: number; json: any }

const SETUP_HELP = [
  'Spotify is not set up yet. One-time setup (about a minute):',
  '  1. Open https://developer.spotify.com/dashboard and create an app.',
  `  2. Add the Redirect URI ${REDIRECT_URI} and tick "Web API".`,
  '  3. Copy the app\'s Client ID and run: /spotify setup <client-id>',
  '  4. Run /spotify login',
].join('\n')

const USAGE = [
  '/spotify                 open the player sidebar',
  '/spotify now             what is playing',
  '/spotify close           close the player sidebar',
  '/spotify bg terminal|none|album|#hex  sidebar background',
  '/spotify setup <id>      save your Spotify app Client ID',
  '/spotify login | logout  connect or disconnect your account',
  '/spotify play [query]    resume, or search a track and play it',
  '/spotify playlist <q>    search a playlist and play it',
  '/spotify pause | toggle | next | prev',
  '/spotify vol <0-100>     set volume',
  '/spotify shuffle on|off  | repeat off|context|track | mute',
  '/spotify devices         list devices',
  '/spotify code <url>      finish login by pasting the redirected URL',
].join('\n')

// ---------- small helpers ----------

const base64url = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const randomString = (length: number) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, b => chars[b % chars.length]).join('')
}

const challengeFor = async (verifier: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))

const form = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const parseJson = (text: string) => {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const openInBrowser = async ($: $, url: string) => {
  for (const argv of [['open', url], ['xdg-open', url]]) {
    try {
      const { exitCode } = await $.process.run(argv, { timeoutMs: 10000 })
      if (exitCode === 0) return true
    } catch {}
  }
  return false
}

// ---------- auth ----------

const saveTokens = async ($: $, json: any, previousRefresh?: string) => {
  const tokens: Tokens = {
    access: json.access_token,
    refresh: json.refresh_token ?? previousRefresh,
    expiresAt: (await $.clock.now()) + (json.expires_in ?? 3600) * 1000,
  }
  await $.store.set('tokens', tokens)
  await update($, isConnected, () => true)
  return tokens
}

const exchangeCode = async ($: $, code: string) => {
  const clientId = (await $.store.get('clientId')) as string | undefined
  const verifier = (await $.store.get('verifier')) as string | undefined
  if (!clientId || !verifier) return 'No login in progress. Run /spotify login first.'

  const res = await $.http.fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  })
  const json = parseJson(res.text)
  if (!res.ok || !json?.access_token) {
    return `Spotify login failed: ${json?.error_description ?? json?.error ?? res.status}`
  }
  await saveTokens($, json)
  await $.store.delete('verifier')
  await $.store.delete('authState')
  void poll($).catch(() => {})
  return undefined
}

// Finishes a login from a redirected URL or its query string; returns an error or undefined.
const finishFromUrl = async ($: $, raw: string) => {
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw
  const params = new URLSearchParams(query.split(/\s/)[0])
  const error = params.get('error')
  if (error) return `Spotify login was refused: ${error}`
  const code = params.get('code')
  if (!code) return 'That URL has no "code" in it.'
  const expected = await $.store.get('authState')
  if (expected && params.get('state') !== expected) return 'Login state did not match; run /spotify login again.'
  return exchangeCode($, code)
}

let listener: { return?: () => unknown } | undefined

// Listens once on 127.0.0.1:8888 for Spotify's redirect, through the host's nc.
const listenForCallback = ($: $) => {
  void listener?.return?.()
  const page =
    '<html><body style="font-family:system-ui;text-align:center;padding-top:4em">' +
    '<h2>Spotify connected to Claude Code</h2><p>You can close this tab.</p></body></html>'
  const response =
    'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n' +
    `Content-Length: ${new TextEncoder().encode(page).length}\r\n\r\n${page}`
  const stream = $.process.spawn({ argv: ['nc', '-l', '127.0.0.1', String(PORT)], input: response })
  listener = stream as unknown as { return?: () => unknown }
  const timeout = $.clock.after(LOGIN_TIMEOUT_MS, () => void listener?.return?.())

  void (async () => {
    let seen = ''
    try {
      for await (const { stream: pipe, text } of stream) {
        if (pipe !== 'stdout') continue
        seen += text
        const match = seen.match(/GET \/callback\?(\S+) HTTP/)
        if (!match?.[1]) continue
        timeout.cancel()
        const error = await finishFromUrl($, match[1])
        $.ui.toast(error ?? 'Spotify connected. Enjoy the music!', { timeoutMs: 6000 })
        break
      }
    } catch {
      $.ui.toast('Could not listen for the Spotify login; paste the URL with /spotify code <url>.')
    }
  })()
}

const getAccessToken = async ($: $, force = false): Promise<string | undefined> => {
  const tokens = (await $.store.get('tokens')) as Tokens | undefined
  if (!tokens) return undefined
  if (!force && tokens.expiresAt - 60000 > (await $.clock.now())) return tokens.access

  const clientId = (await $.store.get('clientId')) as string | undefined
  const res = await $.http.fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: clientId ?? '' }),
  })
  const json = parseJson(res.text)
  if (!res.ok || !json?.access_token) {
    if (res.status === 400 || res.status === 401) {
      await $.store.delete('tokens')
      await update($, isConnected, () => false)
    const savedBackground = await $.store.get('background')
    if (typeof savedBackground === 'string') await update($, background, () => savedBackground)
    const detected = await detectTerminalColor($)
    await update($, terminalColor, () => detected)
      await update($, now, () => null)
    }
    return undefined
  }
  return (await saveTokens($, json, tokens.refresh)).access
}

const api = async ($: $, method: string, path: string, body?: unknown): Promise<ApiResult> => {
  let token = await getAccessToken($)
  if (!token) return { status: 401, json: { error: { message: 'Not connected. Run /spotify login.' } } }

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await $.http.fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? (method === 'GET' ? undefined : '') : JSON.stringify(body),
    })
    if (res.status === 401 && attempt === 0) {
      token = await getAccessToken($, true)
      if (!token) break
      continue
    }
    return { status: res.status, json: parseJson(res.text) }
  }
  return { status: 401, json: { error: { message: 'Spotify session expired. Run /spotify login.' } } }
}

const explain = (r: ApiResult) => {
  const reason = r.json?.error?.reason
  if (reason === 'PREMIUM_REQUIRED' || r.status === 403) {
    return 'Spotify only allows playback control for Premium accounts.'
  }
  if (reason === 'NO_ACTIVE_DEVICE' || r.status === 404) {
    return 'No active Spotify device. Open Spotify on any device and try again.'
  }
  return r.json?.error?.message ?? `Spotify answered ${r.status}.`
}

// ---------- playback ----------

const poll = async ($: $) => {
  if (!(await $.store.get('tokens'))) return
  const r = await api($, 'GET', '/me/player?additional_types=episode')
  if (r.status === 204 || (r.status === 200 && !r.json?.item)) {
    await update($, now, () => null)
    return
  }
  if (r.status !== 200) return
  const item = r.json.item
  const images = (item.album?.images ?? item.images ?? []) as { url: string; width: number }[]
  const previous = await read($, now)
  const state: NowPlaying = {
    trackId: item.id ?? item.uri ?? item.name,
    title: item.name,
    artist: item.artists?.map((a: { name: string }) => a.name).join(', ') ?? item.show?.name ?? '',
    album: item.album?.name ?? item.show?.name ?? '',
    // The smallest image at least 64px wide: the cover is drawn at 40px.
    coverUrl: [...images].sort((a, b) => a.width - b.width).find(i => i.width >= 64)?.url ?? images[0]?.url ?? null,
    isPlaying: Boolean(r.json.is_playing),
    progressMs: r.json.progress_ms ?? 0,
    durationMs: item.duration_ms ?? 0,
    fetchedAt: await $.clock.now(),
    device: r.json.device?.name ?? '',
    volume: r.json.device?.volume_percent ?? null,
    shuffle: Boolean(r.json.shuffle_state),
    repeat: r.json.repeat_state ?? 'off',
  }
  await update($, now, () => state)
  if (previous?.trackId !== state.trackId) {
    await refreshQueue($).catch(() => {})
    void refreshCover($, state).catch(() => {})
  }
  // Music starting anywhere (the Spotify app, a phone) brings the sidebar up.
  if (state.isPlaying && !previous?.isPlaying) void openPlayer($).catch(() => {})
}

const fetchCover = async ($: $, url: string) => {
  try {
    const { stdout } = await $.process.run(['sh', '-c', FETCH_SCRIPT, 'sh', url, String(COVER_SIZE)], {
      timeoutMs: 15000,
    })
    return coverFromOutput(url, stdout)
  } catch {
    return undefined
  }
}

const refreshQueue = async ($: $) => {
  const q = await api($, 'GET', '/me/player/queue')
  const next = ((q.json?.queue ?? []) as any[]).slice(0, 5).map(
    t => `${t.name} — ${t.artists?.map((a: { name: string }) => a.name).join(', ') ?? t.show?.name ?? ''}`,
  )
  await update($, queue, () => next)
}

const refreshCover = async ($: $, state: NowPlaying) => {
  const current = await read($, cover)
  if (!state.coverUrl) {
    await update($, cover, () => null)
  } else if (current?.url !== state.coverUrl) {
    const fetched = await fetchCover($, state.coverUrl)
    await update($, cover, () => fetched ?? null)
  }
}

// The track's position now, moved on from the last poll while it plays.
const progressAt = (playing: NowPlaying, at: number) =>
  Math.min(playing.durationMs, playing.progressMs + (playing.isPlaying ? Math.max(0, at - playing.fetchedAt) : 0))

// Writes a change to the player state at once, before Spotify confirms it.
const patchNow = ($: $, patch: Partial<NowPlaying>) =>
  update($, now, playing => (playing ? { ...playing, ...patch } : playing))

const setVolume = async ($: $, level: number) => {
  const clamped = Math.max(0, Math.min(100, Math.round(level)))
  await patchNow($, { volume: clamped })
  return control($, 'PUT', `/me/player/volume?volume_percent=${clamped}`)
}

let volumeBeforeMute = 50

const toggleMute = async ($: $) => {
  const volume = (await read($, now))?.volume ?? 0
  if (volume > 0) volumeBeforeMute = volume
  return setVolume($, volume > 0 ? 0 : volumeBeforeMute)
}

const REPEAT_NEXT = { off: 'context', context: 'track', track: 'off' } as const

const cycleRepeat = async ($: $) => {
  const state = REPEAT_NEXT[(await read($, now))?.repeat ?? 'off']
  await patchNow($, { repeat: state })
  return control($, 'PUT', `/me/player/repeat?state=${state}`)
}

const toggleShuffle = async ($: $) => {
  const isOn = !(await read($, now))?.shuffle
  await patchNow($, { shuffle: isOn })
  return control($, 'PUT', `/me/player/shuffle?state=${isOn}`)
}

// Runs a player command; when no device is active, wakes one (opening the
// desktop app if needed) and retries on it.
const control = async ($: $, method: string, path: string, body?: unknown): Promise<string | undefined> => {
  let r = await api($, method, path, body)
  if (r.json?.error?.reason === 'NO_ACTIVE_DEVICE' || r.status === 404) {
    let devices = (await api($, 'GET', '/me/player/devices')).json?.devices ?? []
    if (devices.length === 0) {
      try {
        await $.process.run(['open', '-g', '-a', 'Spotify'], { timeoutMs: 10000 })
      } catch {}
      for (let i = 0; i < 6 && devices.length === 0; i++) {
        await $.clock.sleep(1500)
        devices = (await api($, 'GET', '/me/player/devices')).json?.devices ?? []
      }
    }
    if (devices.length > 0) {
      const sep = path.includes('?') ? '&' : '?'
      r = await api($, method, `${path}${sep}device_id=${encodeURIComponent(devices[0].id)}`, body)
    }
  }
  $.clock.after(400, () => void poll($).catch(() => {}))
  return r.status >= 200 && r.status < 300 ? undefined : explain(r)
}

const search = async ($: $, query: string, type: 'track' | 'playlist') => {
  const r = await api($, 'GET', `/search?type=${type}&limit=5&q=${encodeURIComponent(query)}`)
  return ((r.json?.[`${type}s`]?.items ?? []) as any[]).filter(Boolean)[0]
}

const playQuery = async ($: $, query: string, type: 'track' | 'playlist') => {
  const hit = await search($, query, type)
  if (!hit) return `Nothing found on Spotify for "${query}".`
  const error = await control($, 'PUT', '/me/player/play', type === 'track' ? { uris: [hit.uri] } : { context_uri: hit.uri })
  if (error) return error
  const by = type === 'track' ? hit.artists?.map((a: { name: string }) => a.name).join(', ') : hit.owner?.display_name
  return `Playing ${type === 'playlist' ? 'playlist ' : ''}${hit.name}${by ? ` — ${by}` : ''}`
}

const describeNow = async ($: $) => {
  await poll($)
  const playing = await read($, now)
  if (!playing) return 'Nothing is playing on Spotify right now.'
  return (
    `${playing.isPlaying ? 'Playing' : 'Paused'}: ${playing.title} — ${playing.artist} ` +
    `(${clock(playing.progressMs)}/${clock(playing.durationMs)})` +
    (playing.device ? ` on ${playing.device}` : '') +
    (playing.volume === null ? '' : `, volume ${playing.volume}%`)
  )
}

const toggle = async ($: $) => {
  const playing = await read($, now)
  if (playing) {
    // Freeze or restart the bar where it stands, then tell Spotify.
    const at = await $.clock.now()
    await patchNow($, { isPlaying: !playing.isPlaying, progressMs: progressAt(playing, at), fetchedAt: at })
  }
  return control($, 'PUT', playing?.isPlaying ? '/me/player/pause' : '/me/player/play')
}

const openPlayer = ($: $) => $.ui.open({ id: PANE, title: 'Spotify', columns: 36 })

// One entry for both the slash command and the model's tool.
const run = async ($: $, action: string, arg: string): Promise<string> => {
  if (action === 'setup') {
    if (!arg) return SETUP_HELP
    await $.store.set('clientId', arg.trim())
    return 'Client ID saved. Now run /spotify login'
  }
  if (action === 'help') return USAGE
  if (action === 'login') {
    const clientId = (await $.store.get('clientId')) as string | undefined
    if (!clientId) return SETUP_HELP
    const verifier = randomString(64)
    const state = randomString(16)
    await $.store.set('verifier', verifier)
    await $.store.set('authState', state)
    const url =
      'https://accounts.spotify.com/authorize?' +
      form({
        response_type: 'code',
        client_id: clientId,
        scope: SCOPES,
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: await challengeFor(verifier),
        state,
      })
    listenForCallback($)
    const isOpened = await openInBrowser($, url)
    return [
      isOpened ? 'Opened Spotify in your browser — approve access and come back here.' : 'Open this URL to connect Spotify:',
      url,
      '',
      'If the browser page does not load after approving, copy its URL and run /spotify code <url>.',
    ].join('\n')
  }
  if (action === 'code') {
    return (await finishFromUrl($, arg)) ?? 'Spotify connected.'
  }
  if (action === 'logout') {
    await $.store.delete('tokens')
    await update($, isConnected, () => false)
    await update($, now, () => null)
    return 'Disconnected from Spotify.'
  }

  if (!(await $.store.get('tokens'))) {
    return (await $.store.get('clientId')) ? 'Not connected. Run /spotify login' : SETUP_HELP
  }

  switch (action) {
    case '':
    case 'player':
    case 'open': {
      const opened = await openPlayer($)
      const text = await describeNow($)
      return opened.isPlaced ? text : `${text}\n(Widen the terminal to see the player sidebar.)`
    }
    case 'bg':
    case 'background': {
      const choice = arg.toLowerCase()
      if (!['terminal', 'none', 'album'].includes(choice) && !/^#[0-9a-f]{6}$/.test(choice)) {
        return `Background is ${await read($, background)}. Usage: /spotify bg terminal|none|album|#rrggbb`
      }
      await $.store.set('background', choice)
      await update($, background, () => choice)
      const terminal = await read($, terminalColor)
      const shown = choice === 'none' ? 'transparent' : choice === 'terminal' ? `terminal (${terminal ?? 'transparent'})` : choice
      return `Sidebar background: ${shown}.`
    }
    case 'close':
      await $.ui.close({ id: PANE })
      return 'Player closed.'
    case 'now':
    case 'status':
      return describeNow($)
    case 'play': {
      const text = arg ? await playQuery($, arg, 'track') : ((await control($, 'PUT', '/me/player/play')) ?? 'Resumed.')
      void openPlayer($).catch(() => {})
      return text
    }
    case 'playlist': {
      if (!arg) return 'Usage: /spotify playlist <search>'
      const text = await playQuery($, arg, 'playlist')
      void openPlayer($).catch(() => {})
      return text
    }
    case 'pause':
      return (await control($, 'PUT', '/me/player/pause')) ?? 'Paused.'
    case 'toggle':
      return (await toggle($)) ?? 'Toggled.'
    case 'next':
    case 'skip':
      return (await control($, 'POST', '/me/player/next')) ?? 'Skipped.'
    case 'prev':
    case 'previous':
    case 'back':
      return (await control($, 'POST', '/me/player/previous')) ?? 'Back one track.'
    case 'vol':
    case 'volume': {
      const level = Math.round(Number(arg))
      if (!arg || !Number.isFinite(level) || level < 0 || level > 100) return 'Usage: /spotify vol <0-100>'
      return (await setVolume($, level)) ?? `Volume ${level}%.`
    }
    case 'mute':
      return (await toggleMute($)) ?? 'Toggled mute.'
    case 'shuffle': {
      const isOn = arg !== 'off'
      await patchNow($, { shuffle: isOn })
      return (await control($, 'PUT', `/me/player/shuffle?state=${isOn}`)) ?? `Shuffle ${isOn ? 'on' : 'off'}.`
    }
    case 'repeat': {
      if (!arg) return (await cycleRepeat($)) ?? `Repeat ${(await read($, now))?.repeat ?? 'off'}.`
      if (arg !== 'off' && arg !== 'context' && arg !== 'track') return 'Usage: /spotify repeat off|context|track'
      await patchNow($, { repeat: arg })
      return (await control($, 'PUT', `/me/player/repeat?state=${arg}`)) ?? `Repeat ${arg}.`
    }
    case 'devices': {
      const devices = ((await api($, 'GET', '/me/player/devices')).json?.devices ?? []) as any[]
      if (devices.length === 0) return 'No Spotify devices found. Open Spotify somewhere first.'
      return devices.map(d => `${d.is_active ? '▶' : ' '} ${d.name} (${d.type})`).join('\n')
    }
    default:
      return USAGE
  }
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'spotify',
      description: 'Spotify: connect, play, pause, skip, search',
      argumentHint: '(opens player) | play [query] | pause | next | prev | vol <n> | help',
      immediate: true,
    })
    await $.tool.register({
      name: 'spotify',
      description:
        "Controls the user's Spotify playback. Use when the user asks to play, pause, skip, change volume, " +
        'or asks what is playing. "play" with a query searches for a track; "playlist" searches a playlist ' +
        '(good for moods like "lofi focus" or "deep work"). "setup" saves the Client ID given as query; ' +
        '"login" opens the browser to connect the account.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['now', 'play', 'playlist', 'pause', 'next', 'prev', 'volume', 'mute', 'shuffle', 'repeat', 'open', 'setup', 'login'],
          },
          query: {
            type: 'string',
            description:
              'Search text for play/playlist, a number for volume, on/off for shuffle, off/context/track for repeat, the Client ID for setup',
          },
        },
        required: ['action'],
      },
    })
    await update($, isConnected, () => false)
    if (await $.store.get('tokens')) {
      await update($, isConnected, () => true)
      void poll($).catch(() => {})
      // Unasked, the surface seats it only where it fits as a sidebar.
      void openPlayer($).catch(() => {})
    }
    $.clock.every(POLL_MS, () => void poll($).catch(() => {}))
    // Moves the progress bars along between polls.
    $.clock.every(1000, () => {
      void read($, now).then(playing => {
        if (playing?.isPlaying) $.ui.invalidate('ui.render')
      })
    })

    return started
  })

  on('command.run', { command: 'spotify' }, async ($, e) => {
    const [action = '', ...rest] = e.args.trim().split(/\s+/)
    return { text: await run($, action.toLowerCase(), rest.join(' ')) }
  })

  on('tool.call', { tool: 'mcp__claudify__spotify' }, async ($, e) => {
    const input = e as unknown as { action?: string; query?: string }
    return { result: await run($, input.action ?? 'now', input.query ?? '') }
  })

  // The sidebar: cover art, track, progress, transport, volume, device, queue.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const playing = await read($, now)
    const width = Math.max(16, e.props.bodyColumns)
    const art = await read($, cover)
    const choice = await read($, background)
    const fill =
      choice === 'none'
        ? undefined
        : choice === 'terminal'
          ? ((await read($, terminalColor)) ?? undefined)
          : choice === 'album'
            ? art
              ? coverTint(art)
              : undefined
            : choice
    // The root box spans the whole body so a background covers it all.
    const frame = {
      width,
      ...(e.props.scroll?.bodyRows ? { minHeight: e.props.scroll.bodyRows } : {}),
      ...(fill ? { backgroundColor: fill } : {}),
    }

    if (!playing) {
      const isLinked = await read($, isConnected)
      return (
        <Box flexDirection="column" alignItems="center" paddingY={1} {...frame}>
          <Text color="green">♫ Spotify</Text>
          <Text dimColor>{isLinked ? 'Nothing playing.' : 'Not connected.'}</Text>
          <Text dimColor>{isLinked ? 'Try /spotify play <song>' : 'Run /spotify login'}</Text>
        </Box>
      )
    }

    const queued = await read($, queue)
    const progress = progressAt(playing, await $.clock.now())
    const artColumns = Math.min(32, width) & ~1
    const volume = playing.volume
    const segments = 10
    const repeatLabel = playing.repeat === 'track' ? '↻1' : '↻'

    let artwork
    if (!art) {
      artwork = (
        <Box width={artColumns} height={artColumns / 2} borderStyle="round" borderDimColor justifyContent="center" alignItems="center">
          <Text dimColor>♫</Text>
        </Box>
      )
    } else if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      artwork = <Raster key="cover" columns={artColumns} rows={artColumns / 2} cells={coverCells(art, artColumns)} />
    } else {
      artwork = (
        <Box flexDirection="column">
          {coverAscii(art, artColumns).map(line => (
            <Text dimColor>{line}</Text>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" alignItems="center" {...frame}>
        {artwork}
        <Box flexDirection="column" alignItems="center" marginTop={1} width={width}>
          <Text bold wrap="truncate-end">
            {playing.title}
          </Text>
          <Text wrap="truncate-end">{playing.artist}</Text>
          <Text dimColor italic wrap="truncate-end">
            {playing.album}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>{clock(progress)} </Text>
          <Text color="green">{progressBar(progress, playing.durationMs, Math.max(4, width - 12))}</Text>
          <Text dimColor> {clock(playing.durationMs)}</Text>
        </Box>

        <Box marginTop={1} gap={1}>
          <Button key="shuffle" label="⇄" hotkey="s" plain dimColor={!playing.shuffle} onPress={() => act($, () => toggleShuffle($))} />
          <Button key="prev" label="⏮" hotkey="b" onPress={() => act($, () => control($, 'POST', '/me/player/previous'))} />
          <Button
            key="toggle"
            label={playing.isPlaying ? '⏸' : '▶'}
            hotkey="p"
            variant="primary"
            onPress={() => act($, () => toggle($))}
          />
          <Button key="next" label="⏭" hotkey="n" onPress={() => act($, () => control($, 'POST', '/me/player/next'))} />
          <Button
            key="repeat"
            label={repeatLabel}
            hotkey="r"
            plain
            dimColor={playing.repeat === 'off'}
            onPress={() => act($, () => cycleRepeat($))}
          />
        </Box>

        {volume === null ? (
          <Text dimColor>Volume is fixed on this device</Text>
        ) : (
          <Box marginTop={1}>
            <Button key="mute" label={volume === 0 ? '🔇' : '🔊'} hotkey="m" plain onPress={() => act($, () => toggleMute($))} />
            <Text> </Text>
            <Button key="vol-down" label="−" plain onPress={() => act($, () => setVolume($, volume - 10))} />
            <Text> </Text>
            {Array.from({ length: segments }, (_, i) => (
              <Button
                key={`vol-${i}`}
                label={(i + 1) * 10 <= volume ? '█' : '░'}
                plain
                dimColor={(i + 1) * 10 > volume}
                onPress={() => act($, () => setVolume($, (i + 1) * 10))}
              />
            ))}
            <Text> </Text>
            <Button key="vol-up" label="+" plain onPress={() => act($, () => setVolume($, volume + 10))} />
            <Text dimColor> {String(volume).padStart(3)}%</Text>
          </Box>
        )}

        {playing.device ? (
          <Text dimColor wrap="truncate-end">
            on {playing.device}
          </Text>
        ) : null}

        {queued.length > 0 ? (
          <Box flexDirection="column" marginTop={1} width={width}>
            <Text bold dimColor>
              Up next
            </Text>
            {queued.slice(0, 5).map((line, i) => (
              <Text dimColor wrap="truncate-end">
                {i + 1}. {line}
              </Text>
            ))}
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text dimColor>p play · n/b skip · s shuffle · r repeat · m mute</Text>
        </Box>
      </Box>
    )
  })
}

// Runs a control from a press and shows what went wrong, if anything.
const act = async ($: $, fn: () => Promise<string | undefined>) => {
  const error = await fn()
  if (error) $.ui.toast(error)
}

const progressBar = (progress: number, duration: number, width: number) => {
  const at = duration ? Math.min(width - 1, Math.floor((progress / duration) * width)) : 0
  return `${'━'.repeat(at)}●${'─'.repeat(Math.max(0, width - at - 1))}`
}
