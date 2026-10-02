import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { coverAscii, coverCells, coverFromOutput, coverTint } from '../hooks/cover'

const PLAYER = {
  is_playing: true,
  progress_ms: 60000,
  shuffle_state: false,
  repeat_state: 'off',
  device: { name: 'MacBook', volume_percent: 50 },
  item: { id: 'song1', name: 'Song', duration_ms: 180000, artists: [{ name: 'Artist' }], album: { name: 'Album', images: [] } },
}

const CONNECTED = { tokens: { access: 't', refresh: 'r', expiresAt: 10 ** 13 } }

const ROUTES: Record<string, unknown> = {
  'GET /v1/search': { tracks: { items: [{ name: 'Lofi Beat', uri: 'spotify:track:1', artists: [{ name: 'Chill' }] }] } },
  'GET /v1/me/player/queue': { queue: [{ name: 'Next Song', artists: [{ name: 'Someone' }] }] },
}

// A session with Spotify, the pane and the store answered from memory. Every
// request lands in `calls` as "METHOD path?query", every pane opened as "OPEN id".
const fake = (on: On, store: Record<string, unknown> = CONNECTED) => {
  const world = { calls: [] as string[], player: PLAYER as object | null, isPaneShown: false, status: 200, error: {} }
  mock.store(on, store)
  mock.clock(on)
  on('ui.open', ($, e) => {
    world.calls.push(`OPEN ${e.id}`)
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({
    value: world.isPaneShown ? [{ id: 'spotify', title: 'Spotify', isShown: true, isFocused: false, isPlaced: true, plugin: 'claudify' }] : [],
  }) as never)
  // What the engine draws when the plugin passes the band on.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    const route = `${e.init?.method ?? 'GET'} ${url.pathname}`
    world.calls.push(`${route}${url.search}`)
    const json =
      route === 'POST /api/token' ? { access_token: 'a', refresh_token: 'r', expires_in: 3600 }
      : world.status !== 200 ? world.error
      : route === 'GET /v1/me/player' ? world.player
      : ROUTES[route]
    const status = world.status !== 200 && route !== 'POST /api/token' ? world.status : json ? 200 : 204
    return { value: { status, ok: status < 300, headers: {}, text: json ? JSON.stringify(json) : '' } }
  })
  return world
}

const spotify = async ($: EngineInterface, args: string) => (await $.command.run({ command: 'spotify', args })).text

test('a new user is told to log in, and setup explains bringing their own app', async ($, on) => {
  fake(on, {})
  expect(await spotify($, '')).toBe('Not connected. Run /spotify login')
  expect(await spotify($, 'setup')).toContain('/spotify setup <client-id>')
})

test('an account the built-in app does not serve gets a clear explanation', async ($, on) => {
  const world = fake(on, { verifier: 'v', authState: 's' })
  world.status = 403
  world.error = { error: { status: 403, message: 'Check settings on developer.spotify.com/dashboard, the user may not be registered.' } }
  expect(await spotify($, 'code http://127.0.0.1:8888/callback?code=c&state=s')).toContain('Ask the owner to add your Spotify email')
  expect(await spotify($, 'now')).toBe('Not connected. Run /spotify login')
})

test('when connected, /spotify tells what is playing', async ($, on) => {
  fake(on)
  expect(await spotify($, '')).toBe('Playing: Song — Artist (1:00/3:00) on MacBook, volume 50%')
})

test('the model can search and play a track, and the sidebar opens', async ($, on) => {
  const { calls } = fake(on)
  const ran = await $.tool.call({ tool: 'mcp__claudify__spotify', action: 'play', query: 'lofi' } as never)
  expect(String(ran.result ?? ran.text)).toContain('Playing Lofi Beat — Chill')
  expect(calls).toContain('PUT /v1/me/player/play')
  expect(calls).toContain('OPEN spotify')
})

test('the sidebar shows the track, the queue and sets the volume', async ($, on) => {
  const { calls } = fake(on)
  await spotify($, 'now')
  const props = { title: 'Spotify', isFocused: false, bodyColumns: 36, placement: 'dock', scroll: {}, view: {} } as never
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'claudify', surface, component: 'Pane', requestId: 'spotify', props })
    for (const text of [/Song/, /Album/, /Next Song/]) expect(await ui.find({ type: 'Text', text })).toBeDefined()
    await ui.press({ key: 'vol-2' })
    expect(calls).toContain('PUT /v1/me/player/volume?volume_percent=30')
    await ui.press({ key: 'repeat' })
    expect(calls.some(c => c.startsWith('PUT /v1/me/player/repeat?state='))).toBe(true)
    await ui.unmount()
  }
})

test('the bar above the prompt shows only while the sidebar is off screen', async ($, on) => {
  const world = fake(on)
  await spotify($, 'now')
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = { plugin: 'claudify', surface, component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: false, bodyColumns: 120 } as never }
    world.isPaneShown = false
    const ui = await $.ui.mount(band)
    expect(await ui.find({ type: 'Text', text: /Song/ })).toBeDefined()
    await ui.press({ key: 'next' })
    expect(world.calls).toContain('POST /v1/me/player/next')
    await ui.unmount()

    world.isPaneShown = true
    const hidden = await $.ui.mount(band)
    expect(await hidden.find({ type: 'Text', text: /Song/ })).toBeUndefined()
    await hidden.unmount()
  }
})

test('the sidebar stays closed at start and opens when music starts', async ($, on) => {
  const world = fake(on)
  const opened = () => world.calls.filter(c => c.startsWith('OPEN'))
  // Already playing when the module loads: no sidebar.
  await spotify($, 'now')
  world.player = { ...PLAYER, is_playing: false }
  await spotify($, 'now')
  expect(opened()).toEqual([])
  // Playback starts from elsewhere: the sidebar opens.
  world.player = PLAYER
  await spotify($, 'now')
  expect(opened()).toEqual(['OPEN spotify'])
})

test('/spotify bg sets and keeps the sidebar background', async ($, on) => {
  fake(on)
  expect(await spotify($, 'bg #1e1e2e')).toBe('Sidebar background: #1e1e2e.')
  expect(await spotify($, 'bg purple')).toContain('Background is #1e1e2e')
  expect(await spotify($, 'bg none')).toBe('Sidebar background: transparent.')
})

test('a BMP cover decodes and draws as half blocks and ASCII', async () => {
  // A 2x2 24-bit top-down BMP: red, green / blue, white.
  const header = new DataView(new ArrayBuffer(54))
  header.setUint16(0, 0x4d42, true)
  header.setUint32(10, 54, true)
  header.setInt32(18, 2, true)
  header.setInt32(22, -2, true)
  header.setUint16(28, 24, true)
  const pixels = [0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0]
  const bytes = new Uint8Array([...new Uint8Array(header.buffer), ...pixels])
  const cover = coverFromOutput('u', btoa(String.fromCharCode(...bytes)))!
  expect(cover.pixels).toEqual([0xff0000, 0x00ff00, 0x0000ff, 0xffffff])
  const words = new Uint32Array(Uint8Array.from(atob(coverCells(cover, 2)), c => c.charCodeAt(0)).buffer)
  expect(Array.from(words)).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
  expect(coverAscii(cover, 2)).toHaveLength(1)
  // Average (128, 128, 128) scaled so its brightest channel is 52.
  expect(coverTint(cover)).toBe('#343434')
})
