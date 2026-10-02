import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { coverAscii, coverCells, coverFromOutput, coverTint } from '../hooks/cover'

const PLAYER = {
  is_playing: true,
  progress_ms: 60000,
  shuffle_state: false,
  device: { name: 'MacBook', volume_percent: 50 },
  repeat_state: 'off',
  item: { id: 'song1', name: 'Song', duration_ms: 180000, artists: [{ name: 'Artist' }], album: { name: 'Album', images: [] } },
}

// Answers Spotify from memory and records each request as "METHOD path".
const fakeSpotify = (on: On) => {
  const calls: string[] = []
  on('ui.open', ($, e) => {
    calls.push(`OPEN ${e.id}`)
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: [] }))
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}${url.search}`)
    const reply = (status: number, json?: unknown) => ({
      value: {
        status,
        ok: status < 300,
        headers: {},
        text: json === undefined ? '' : JSON.stringify(json),
      },
    })
    if (url.pathname === '/v1/me/player' && method === 'GET') return reply(200, PLAYER)
    if (url.pathname === '/v1/search') {
      return reply(200, { tracks: { items: [{ name: 'Lofi Beat', uri: 'spotify:track:1', artists: [{ name: 'Chill' }] }] } })
    }
    if (url.pathname === '/v1/me/player/queue') {
      return reply(200, { queue: [{ name: 'Next Song', artists: [{ name: 'Someone' }] }] })
    }
    return reply(204)
  })
  return calls
}

const connected = { clientId: 'abc', tokens: { access: 't', refresh: 'r', expiresAt: 10 ** 13 } }

test('a new user is told to log in, and setup explains bringing their own app', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  expect((await $.command.run({ command: 'spotify', args: '' })).text).toBe('Not connected. Run /spotify login')
  expect((await $.command.run({ command: 'spotify', args: 'setup' })).text).toContain('/spotify setup <client-id>')
})

test('an account the built-in app does not serve gets a clear explanation', async ($, on) => {
  mock.store(on, { verifier: 'v', authState: 's' })
  mock.clock(on)
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    const reply = (status: number, json: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(json) } })
    if (url.pathname === '/api/token') return reply(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 })
    return reply(403, { error: { status: 403, message: 'Check settings on developer.spotify.com/dashboard, the user may not be registered.' } })
  })
  const { text } = await $.command.run({ command: 'spotify', args: 'code http://127.0.0.1:8888/callback?code=c&state=s' })
  expect(text).toContain('Ask the owner to add your Spotify email')
  expect((await $.command.run({ command: 'spotify', args: 'now' })).text).toBe('Not connected. Run /spotify login')
})

test('when connected, /spotify tells what is playing', async ($, on) => {
  mock.store(on, connected)
  mock.clock(on)
  fakeSpotify(on)
  const { text } = await $.command.run({ command: 'spotify', args: '' })
  expect(text).toBe('Playing: Song — Artist (1:00/3:00) on MacBook, volume 50%')
})

test('the model can search and play a track, and the sidebar opens', async ($, on) => {
  mock.store(on, connected)
  mock.clock(on)
  const calls = fakeSpotify(on)
  const ran = await $.tool.call({ tool: 'mcp__claudify__spotify', action: 'play', query: 'lofi' } as never)
  expect(String(ran.result ?? ran.text)).toContain('Playing Lofi Beat — Chill')
  expect(calls).toContain('PUT /v1/me/player/play')
  expect(calls).toContain('OPEN spotify')
})

const PANE = (bodyColumns: number) => ({
  component: 'Pane' as const,
  requestId: 'spotify',
  props: { title: 'Spotify', isFocused: false, bodyColumns, placement: 'dock', scroll: {}, view: {} } as never,
})

test('the sidebar shows the track, the queue and sets the volume', async ($, on) => {
  mock.store(on, connected)
  mock.clock(on)
  const calls = fakeSpotify(on)
  await $.command.run({ command: 'spotify', args: 'now' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'claudify', surface, ...PANE(36) })
    expect(await ui.find({ type: 'Text', text: /Song/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Album/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Next Song/ })).toBeDefined()
    await ui.press({ key: 'vol-2' })
    expect(calls).toContain('PUT /v1/me/player/volume?volume_percent=30')
    await ui.press({ key: 'repeat' })
    expect(calls.some(c => c.startsWith('PUT /v1/me/player/repeat?state='))).toBe(true)
    calls.length = 0
    await ui.unmount()
  }
})

test('a BMP cover decodes and draws as half blocks and ASCII', async () => {
  // A 2x2 24-bit top-down BMP: red, green / blue, white.
  const header = new Uint8Array(54)
  const view = new DataView(header.buffer)
  header[0] = 0x42
  header[1] = 0x4d
  view.setUint32(10, 54, true)
  view.setInt32(18, 2, true)
  view.setInt32(22, -2, true)
  view.setUint16(28, 24, true)
  const rows = [0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0]
  const bytes = new Uint8Array([...header, ...rows])
  const cover = coverFromOutput('u', btoa(String.fromCharCode(...bytes)))
  expect(cover?.pixels).toEqual([0xff0000, 0x00ff00, 0x0000ff, 0xffffff])
  const words = new Uint32Array(Uint8Array.from(atob(coverCells(cover!, 2)), c => c.charCodeAt(0)).buffer)
  expect(Array.from(words)).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
  expect(coverAscii(cover!, 2)).toHaveLength(1)
  // Average (128, 128, 128) scaled so its brightest channel is 52.
  expect(coverTint(cover!)).toBe('#343434')
})

test('/spotify bg sets and keeps the sidebar background', async ($, on) => {
  mock.store(on, connected)
  mock.clock(on)
  fakeSpotify(on)
  expect((await $.command.run({ command: 'spotify', args: 'bg #1e1e2e' })).text).toBe('Sidebar background: #1e1e2e.')
  expect((await $.command.run({ command: 'spotify', args: 'bg purple' })).text).toContain('Background is #1e1e2e')
  expect((await $.command.run({ command: 'spotify', args: 'bg none' })).text).toBe('Sidebar background: transparent.')
})

test('the bar above the prompt shows only while the sidebar is off screen', async ($, on) => {
  mock.store(on, connected)
  mock.clock(on)
  const calls: string[] = []
  let isPaneShown = false
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  // What the engine draws when the plugin passes the band on.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.panes', () => ({
    value: isPaneShown ? [{ id: 'spotify', title: 'Spotify', isShown: true, isFocused: false, isPlaced: true, plugin: 'claudify' }] : [],
  }) as never)
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    calls.push(`${e.init?.method ?? 'GET'} ${url.pathname}`)
    const json = url.pathname === '/v1/me/player' ? PLAYER : undefined
    return { value: { status: json ? 200 : 204, ok: true, headers: {}, text: json ? JSON.stringify(json) : '' } }
  })
  await $.command.run({ command: 'spotify', args: 'now' })
  for (const surface of ['terminal', 'desktop'] as const) {
    isPaneShown = false
    const band = { plugin: 'claudify', surface, component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: false, bodyColumns: 120 } as never }
    const ui = await $.ui.mount(band)
    expect(await ui.find({ type: 'Text', text: /Song/ })).toBeDefined()
    await ui.press({ key: 'next' })
    expect(calls).toContain('POST /v1/me/player/next')
    await ui.unmount()

    isPaneShown = true
    const hidden = await $.ui.mount(band)
    expect(await hidden.find({ type: 'Text', text: /Song/ })).toBeUndefined()
    await hidden.unmount()
  }
})

test('the sidebar stays closed at start and opens when music starts', async ($, on) => {
  mock.store(on, connected)
  mock.clock(on)
  const opened: string[] = []
  let isPlaying = true
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    const json = url.pathname === '/v1/me/player' ? { ...PLAYER, is_playing: isPlaying } : undefined
    return { value: { status: json ? 200 : 204, ok: true, headers: {}, text: json ? JSON.stringify(json) : '' } }
  })
  // Already playing when the module loads: no sidebar.
  await $.command.run({ command: 'spotify', args: 'now' })
  expect(opened).toEqual([])
  isPlaying = false
  await $.command.run({ command: 'spotify', args: 'now' })
  expect(opened).toEqual([])
  // Playback starts from elsewhere: the sidebar opens.
  isPlaying = true
  await $.command.run({ command: 'spotify', args: 'now' })
  expect(opened).toEqual(['spotify'])
})
