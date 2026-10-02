import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NowPlaying } from '../types'
import { COVER_SIZE, coverFromOutput, coverTint, FETCH_SCRIPT } from './cover'
import * as spotify from './spotify'
import type { ApiResult } from './spotify'
import { Bar, EmptySidebar, ghosttyBackground, ghosttyConfigs, GHOSTTY_DEFAULT_BACKGROUND, Sidebar } from './views'
import type { Actions } from './views'

type $ = EngineInterface
type Tokens = { access: string; refresh: string; expiresAt: number }

const PANE = 'spotify'
const POLL_MS = 5000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const REPEAT_NEXT = { off: 'context', context: 'track', track: 'off' } as const

const now = atom({ plugin: 'claudify', key: 'now' } as const, null)
const isConnected = atom({ plugin: 'claudify', key: 'isConnected' } as const, false)
const cover = atom({ plugin: 'claudify', key: 'cover' } as const, null)
const queue = atom({ plugin: 'claudify', key: 'queue' } as const, [])
// The sidebar's background: 'terminal' (the terminal's own color painted over
// Claude Code's darker pane), 'none', 'album', or '#rrggbb'.
const background = atom({ plugin: 'claudify', key: 'background' } as const, 'terminal')
const terminalColor = atom({ plugin: 'claudify', key: 'terminalColor' } as const, null)

// Whether a poll has seen Spotify since the module loaded: music already
// playing then leaves the sidebar closed, music starting later opens it.
let hasPolled = false
let volumeBeforeMute = 50
let listener: { return?: () => unknown } | undefined

const quietly = (work: Promise<unknown>) => void work.catch(() => {})

// ---------- session ----------

const clientIdOf = async ($: $) => ((await $.store.get('clientId')) as string | undefined) ?? spotify.DEFAULT_CLIENT_ID

const disconnect = async ($: $) => {
  await $.store.delete('tokens')
  await update($, isConnected, () => false)
  await update($, now, () => null)
}

// Posts to Spotify's token endpoint and keeps the tokens; an error otherwise.
type TokenResult = { tokens?: Tokens; status?: number; error?: string }

const requestTokens = async ($: $, fields: Record<string, string>, previousRefresh?: string): Promise<TokenResult> => {
  const res = await $.http.fetch(spotify.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: spotify.form({ ...fields, client_id: await clientIdOf($) }),
  })
  const json = spotify.parseJson(res.text)
  if (!res.ok || !json?.access_token) return { status: res.status, error: json?.error_description ?? json?.error ?? res.status }
  const tokens: Tokens = {
    access: json.access_token,
    refresh: json.refresh_token ?? previousRefresh,
    expiresAt: (await $.clock.now()) + (json.expires_in ?? 3600) * 1000,
  }
  await $.store.set('tokens', tokens)
  await update($, isConnected, () => true)
  return { tokens }
}

const getAccessToken = async ($: $, force = false) => {
  const tokens = (await $.store.get('tokens')) as Tokens | undefined
  if (!tokens) return undefined
  if (!force && tokens.expiresAt - 60000 > (await $.clock.now())) return tokens.access
  const got = await requestTokens($, { grant_type: 'refresh_token', refresh_token: tokens.refresh }, tokens.refresh)
  if (got.status === 400 || got.status === 401) await disconnect($)
  return got.tokens?.access
}

// Calls the Web API, refreshing the token once if Spotify says it expired.
const api = async ($: $, method: string, path: string, body?: unknown): Promise<ApiResult> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken($, attempt > 0)
    if (!token) break
    const res = await $.http.fetch(`${spotify.API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? (method === 'GET' ? undefined : '') : JSON.stringify(body),
    })
    if (res.status !== 401) return { status: res.status, json: spotify.parseJson(res.text) }
  }
  return { status: 401, json: { error: { message: 'Not connected. Run /spotify login.' } } }
}

// Finishes a login from the redirected URL (or its query); an error or undefined.
const finishLogin = async ($: $, url: string) => {
  const params = new URLSearchParams(url.slice(url.indexOf('?') + 1).split(/\s/)[0])
  if (params.get('error')) return `Spotify login was refused: ${params.get('error')}`
  const code = params.get('code')
  if (!code) return 'That URL has no "code" in it.'
  const verifier = (await $.store.get('verifier')) as string | undefined
  if (!verifier) return 'No login in progress. Run /spotify login first.'
  if (params.get('state') !== (await $.store.get('authState'))) return 'Login state did not match; run /spotify login again.'

  const got = await requestTokens($, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: spotify.REDIRECT_URI,
    code_verifier: verifier,
  })
  if (got.error) return `Spotify login failed: ${got.error}`
  await $.store.delete('verifier')
  await $.store.delete('authState')
  // A development-mode app logs in any account but serves only the ones its
  // owner added, so ask once now rather than fail quietly on every poll.
  if (spotify.isNotRegistered(await api($, 'GET', '/me'))) {
    await disconnect($)
    return spotify.NOT_REGISTERED
  }
  quietly(poll($))
  return undefined
}

// Listens once on 127.0.0.1:8888 for Spotify's redirect, through the host's nc.
const listenForCallback = ($: $) => {
  void listener?.return?.()
  const stream = $.process.spawn({
    argv: ['nc', '-l', '127.0.0.1', String(spotify.PORT)],
    input: spotify.CALLBACK_RESPONSE,
  })
  listener = stream as unknown as typeof listener
  const timeout = $.clock.after(LOGIN_TIMEOUT_MS, () => void listener?.return?.())
  void (async () => {
    let seen = ''
    try {
      for await (const { stream: pipe, text } of stream) {
        seen += pipe === 'stdout' ? text : ''
        const query = seen.match(/GET \/callback\?(\S+) HTTP/)?.[1]
        if (!query) continue
        timeout.cancel()
        $.ui.toast((await finishLogin($, query)) ?? 'Spotify connected. Enjoy the music!', { timeoutMs: 6000 })
        break
      }
    } catch {
      $.ui.toast('Could not listen for the Spotify login; paste the URL with /spotify code <url>.')
    }
  })()
}

const login = async ($: $) => {
  const verifier = spotify.randomString(64)
  const state = spotify.randomString(16)
  await $.store.set('verifier', verifier)
  await $.store.set('authState', state)
  const url = await spotify.authorizeUrl(await clientIdOf($), verifier, state)
  listenForCallback($)
  let isOpened = false
  for (const opener of ['open', 'xdg-open']) {
    isOpened ||= await $.process.run([opener, url], { timeoutMs: 10000 }).then(r => r.exitCode === 0, () => false)
  }
  return `${isOpened ? 'Opened Spotify in your browser — approve access and come back here.' : 'Open this URL to connect Spotify:'}
${url}

If the browser page does not load after approving, copy its URL and run /spotify code <url>.`
}

const detectTerminalColor = async ($: $) => {
  if ((await $.env.get('TERM_PROGRAM')) !== 'ghostty') return null
  let color: string | undefined
  for (const path of ghosttyConfigs((await $.env.get('HOME')) ?? '')) {
    color = (await $.fs.read(path).then(ghosttyBackground, () => undefined)) ?? color
  }
  return color ?? GHOSTTY_DEFAULT_BACKGROUND
}

// ---------- playback ----------

const openPlayer = ($: $) => $.ui.open({ id: PANE, title: 'Spotify', columns: 36 })

const poll = async ($: $) => {
  if (!(await $.store.get('tokens'))) return
  const r = await api($, 'GET', '/me/player?additional_types=episode')
  if (r.status !== 200 && r.status !== 204) return
  const previous = await read($, now)
  const state = spotify.parsePlayer(r.json, await $.clock.now())
  await update($, now, () => state)
  if (state && previous?.trackId !== state.trackId) {
    const next = spotify.parseQueue((await api($, 'GET', '/me/player/queue')).json)
    await update($, queue, () => next)
    quietly(refreshCover($, state))
  }
  if (hasPolled && state?.isPlaying && !previous?.isPlaying) quietly(openPlayer($))
  hasPolled = true
}

const refreshCover = async ($: $, state: NowPlaying) => {
  const url = state.coverUrl
  if (!url) return update($, cover, () => null)
  if ((await read($, cover))?.url === url) return
  const { stdout } = await $.process.run(['sh', '-c', FETCH_SCRIPT, 'sh', url, String(COVER_SIZE)], { timeoutMs: 15000 })
  await update($, cover, () => coverFromOutput(url, stdout) ?? null)
}

// Runs a player command; when no device is active, wakes one (opening the
// desktop app if needed) and retries on it. An error to show, or undefined.
const control = async ($: $, method: string, path: string, body?: unknown) => {
  const devices = async () => ((await api($, 'GET', '/me/player/devices')).json?.devices ?? []) as { id: string }[]
  let r = await api($, method, `/me/player${path}`, body)
  if (spotify.isNoDevice(r)) {
    let found = await devices()
    if (found.length === 0) await $.process.run(['open', '-g', '-a', 'Spotify'], { timeoutMs: 10000 }).catch(() => {})
    for (let i = 0; i < 6 && found.length === 0; i++) {
      await $.clock.sleep(1500)
      found = await devices()
    }
    const id = found[0]?.id
    if (id) r = await api($, method, `/me/player${path}${path.includes('?') ? '&' : '?'}device_id=${id}`, body)
  }
  $.clock.after(400, () => quietly(poll($)))
  return r.status < 300 ? undefined : spotify.explain(r)
}

// Shows a change at once, before Spotify confirms it, then sends it.
const optimistic = async ($: $, patch: Partial<NowPlaying>, path: string) => {
  await update($, now, p => (p ? { ...p, ...patch } : p))
  return control($, 'PUT', path)
}

const setVolume = ($: $, level: number) => {
  const volume = Math.max(0, Math.min(100, Math.round(level)))
  return optimistic($, { volume }, `/volume?volume_percent=${volume}`)
}

const toggleMute = async ($: $) => {
  const volume = (await read($, now))?.volume ?? 0
  if (volume > 0) volumeBeforeMute = volume
  return setVolume($, volume > 0 ? 0 : volumeBeforeMute)
}

const setShuffle = ($: $, shuffle: boolean) => optimistic($, { shuffle }, `/shuffle?state=${shuffle}`)
const setRepeat = ($: $, repeat: NowPlaying['repeat']) => optimistic($, { repeat }, `/repeat?state=${repeat}`)

const toggle = async ($: $) => {
  const p = await read($, now)
  if (!p) return control($, 'PUT', '/play')
  // Freeze or restart the progress bar where it stands.
  const at = await $.clock.now()
  const patch = { isPlaying: !p.isPlaying, progressMs: spotify.progressAt(p, at), fetchedAt: at }
  return optimistic($, patch, p.isPlaying ? '/pause' : '/play')
}

const playSearch = async ($: $, query: string, type: 'track' | 'playlist') => {
  const r = await api($, 'GET', `/search?type=${type}&limit=5&q=${encodeURIComponent(query)}`)
  const hit = (r.json?.[`${type}s`]?.items ?? []).find(Boolean)
  if (!hit) return `Nothing found on Spotify for "${query}".`
  const error = await control($, 'PUT', '/play', type === 'track' ? { uris: [hit.uri] } : { context_uri: hit.uri })
  quietly(openPlayer($))
  return error ?? spotify.describeHit(hit, type)
}

const describeNow = async ($: $) => {
  await poll($)
  const playing = await read($, now)
  return playing ? spotify.describe(playing) : 'Nothing is playing on Spotify right now.'
}

// ---------- commands ----------

// One entry for both the slash command and the model's tool.
const run = async ($: $, action: string, arg: string): Promise<string> => {
  switch (action) {
    case 'help':
      return spotify.USAGE
    case 'setup': {
      if (!arg) return spotify.SETUP_HELP
      const isDefault = arg === 'default'
      await (isDefault ? $.store.delete('clientId') : $.store.set('clientId', arg))
      await disconnect($) // tokens belong to the app that issued them
      return `${isDefault ? 'Using the built-in app' : 'Client ID saved'}. Now run /spotify login`
    }
    case 'login':
      return login($)
    case 'code':
      return (await finishLogin($, arg)) ?? 'Spotify connected.'
    case 'logout':
      await disconnect($)
      return 'Disconnected from Spotify.'
    case 'bg':
    case 'background': {
      const choice = arg.toLowerCase()
      if (!['terminal', 'none', 'album'].includes(choice) && !/^#[0-9a-f]{6}$/.test(choice)) {
        return `Background is ${await read($, background)}. Usage: /spotify bg terminal|none|album|#rrggbb`
      }
      await $.store.set('background', choice)
      await update($, background, () => choice)
      const terminal = (await read($, terminalColor)) ?? 'transparent'
      return `Sidebar background: ${{ none: 'transparent', terminal: `terminal (${terminal})` }[choice] ?? choice}.`
    }
    case 'close':
      await $.ui.close({ id: PANE })
      return 'Player closed.'
  }

  if (!(await $.store.get('tokens'))) return 'Not connected. Run /spotify login'

  switch (action) {
    case '':
    case 'open':
    case 'player': {
      const { isPlaced } = await openPlayer($)
      return `${await describeNow($)}${isPlaced ? '' : '\n(Widen the terminal to see the player sidebar.)'}`
    }
    case 'now':
    case 'status':
      return describeNow($)
    case 'play':
      if (arg) return playSearch($, arg, 'track')
      quietly(openPlayer($))
      return (await control($, 'PUT', '/play')) ?? 'Resumed.'
    case 'playlist':
      return arg ? playSearch($, arg, 'playlist') : 'Usage: /spotify playlist <search>'
    case 'pause':
      return (await control($, 'PUT', '/pause')) ?? 'Paused.'
    case 'toggle':
      return (await toggle($)) ?? 'Toggled.'
    case 'next':
    case 'skip':
      return (await control($, 'POST', '/next')) ?? 'Skipped.'
    case 'prev':
    case 'previous':
    case 'back':
      return (await control($, 'POST', '/previous')) ?? 'Back one track.'
    case 'vol':
    case 'volume': {
      const level = Number(arg)
      if (!arg || !(level >= 0 && level <= 100)) return 'Usage: /spotify vol <0-100>'
      return (await setVolume($, level)) ?? `Volume ${Math.round(level)}%.`
    }
    case 'mute':
      return (await toggleMute($)) ?? 'Toggled mute.'
    case 'shuffle':
      return (await setShuffle($, arg !== 'off')) ?? `Shuffle ${arg === 'off' ? 'off' : 'on'}.`
    case 'repeat': {
      const repeat = arg || REPEAT_NEXT[(await read($, now))?.repeat ?? 'off']
      if (repeat !== 'off' && repeat !== 'context' && repeat !== 'track') return 'Usage: /spotify repeat off|context|track'
      return (await setRepeat($, repeat)) ?? `Repeat ${repeat}.`
    }
    case 'devices': {
      const devices: any[] = (await api($, 'GET', '/me/player/devices')).json?.devices ?? []
      if (devices.length === 0) return 'No Spotify devices found. Open Spotify somewhere first.'
      return devices.map(d => `${d.is_active ? '▶' : ' '} ${d.name} (${d.type})`).join('\n')
    }
    default:
      return spotify.USAGE
  }
}

// The handlers the drawings' buttons call; a failure shows as a toast.
const actionsFor = ($: $): Actions => {
  const act = (work: () => Promise<string | undefined>) => () =>
    void work().then(error => error && $.ui.toast(error), () => {})
  return {
    prev: act(() => control($, 'POST', '/previous')),
    next: act(() => control($, 'POST', '/next')),
    toggle: act(() => toggle($)),
    shuffle: act(async () => setShuffle($, !(await read($, now))?.shuffle)),
    repeat: act(async () => setRepeat($, REPEAT_NEXT[(await read($, now))?.repeat ?? 'off'])),
    mute: act(() => toggleMute($)),
    volume: level => act(() => setVolume($, level))(),
    open: act(async () => void (await openPlayer($))),
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

    const saved = await $.store.get('background')
    if (typeof saved === 'string') await update($, background, () => saved)
    const detected = await detectTerminalColor($)
    await update($, terminalColor, () => detected)
    await update($, isConnected, () => false)
    if (await $.store.get('tokens')) {
      await update($, isConnected, () => true)
      quietly(poll($))
    }

    $.clock.every(POLL_MS, () => quietly(poll($)))
    // Moves the progress bars along between polls.
    $.clock.every(1000, () => quietly(read($, now).then(p => p?.isPlaying && $.ui.invalidate('ui.render'))))
    return started
  })

  on('command.run', { command: 'spotify' }, async ($, e) => {
    const [action = '', ...rest] = e.args.trim().split(/\s+/)
    return { text: await run($, action.toLowerCase(), rest.join(' ')) }
  })

  on('tool.call', { tool: 'mcp__claudify__spotify' }, async ($, e) => {
    const input = e as unknown as { action?: string; query?: string }
    return { result: await run($, input.action ?? 'now', input.query?.trim() ?? '') }
  })

  // The bar shows only while the sidebar is off screen: redraw on either change.
  on('ui.open', async ($, e, next) => {
    const opened = await next(e)
    $.ui.invalidate('ui.render')
    return opened
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    $.ui.invalidate('ui.render')
    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const playing = await read($, now)
    if (e.props.hasSurvey || !playing) return next(e)
    if ((await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown)) return next(e)
    return Bar({
      el: $.ui.resolve(e),
      playing,
      progress: spotify.progressAt(playing, await $.clock.now()),
      act: actionsFor($),
      columns: Math.max(20, e.props.bodyColumns ?? e.viewport?.columns ?? 80),
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const art = await read($, cover)
    const choice = await read($, background)
    const fill = {
      none: undefined,
      terminal: (await read($, terminalColor)) ?? undefined,
      album: art ? coverTint(art) : undefined,
    }[choice] ?? (choice.startsWith('#') ? choice : undefined)
    // The root box spans the whole body so a background covers it all.
    const frame = {
      width: Math.max(16, e.props.bodyColumns),
      ...(e.props.scroll?.bodyRows ? { minHeight: e.props.scroll.bodyRows } : {}),
      ...(fill ? { backgroundColor: fill } : {}),
    }

    const playing = await read($, now)
    if (!playing) return EmptySidebar({ el, frame, isConnected: await read($, isConnected) })
    return Sidebar({
      el,
      playing,
      progress: spotify.progressAt(playing, await $.clock.now()),
      act: actionsFor($),
      frame,
      art,
      queue: await read($, queue),
      Raster: 'Raster' in el ? el.Raster : undefined,
    })
  })
}
