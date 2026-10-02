// What the plugin draws: the sidebar and the bar above the prompt. Each takes
// the surface's elements and the button handlers, so it needs no engine.
import type { ElementTable, Elements } from 'claude-code'

import type { Cover, NowPlaying } from '../types'
import { coverAscii, coverCells } from './cover'
import { clock, progressBar } from './spotify'

export type Actions = {
  prev: () => void
  next: () => void
  toggle: () => void
  shuffle: () => void
  repeat: () => void
  mute: () => void
  volume: (level: number) => void
  open: () => void
}

type Shared = { el: ElementTable; playing: NowPlaying; progress: number; act: Actions }

const Title = ({ el, playing }: Shared) => {
  const { Box, Text } = el
  return (
    <Box flexShrink={1}>
      <Text color="green">♫ </Text>
      <Text bold wrap="truncate-end">
        {playing.title}
      </Text>
      <Text dimColor wrap="truncate-end">
        {' '}— {playing.artist}
      </Text>
    </Box>
  )
}

// The bar above the prompt: one compact row on the left, below a blank row.
export const Bar = (props: Shared & { columns: number }) => {
  const { el, playing, progress, act, columns } = props
  const { Box, Button, Text } = el
  const barWidth = Math.min(20, columns - 90)
  return (
    <Box marginTop={1} gap={2}>
      {Title(props)}
      <Text dimColor>
        {barWidth > 4 ? `${progressBar(progress, playing.durationMs, barWidth)} ` : ''}
        {clock(progress)}/{clock(playing.durationMs)}
      </Text>
      <Box gap={1} flexShrink={0}>
        <Button key="prev" label="⏮" onPress={act.prev} />
        <Button key="toggle" label={playing.isPlaying ? '⏸' : '▶'} variant="primary" onPress={act.toggle} />
        <Button key="next" label="⏭" onPress={act.next} />
        <Button key="open" label="☰" onPress={act.open} />
      </Box>
    </Box>
  )
}

type Frame = { width: number; minHeight?: number; backgroundColor?: string }

export const EmptySidebar = ({ el, frame, isConnected }: { el: ElementTable; frame: Frame; isConnected: boolean }) => {
  const { Box, Text } = el
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1} {...frame}>
      <Text color="green">♫ Spotify</Text>
      <Text dimColor>{isConnected ? 'Nothing playing.' : 'Not connected.'}</Text>
      <Text dimColor>{isConnected ? 'Try /spotify play <song>' : 'Run /spotify login'}</Text>
    </Box>
  )
}

type SidebarProps = Shared & {
  frame: Frame
  art: Cover | null
  queue: string[]
  // Present on the terminal, the one surface that draws colored cells.
  Raster?: Elements['terminal']['Raster']
}

const Artwork = ({ el, art, Raster, columns }: Pick<SidebarProps, 'el' | 'art' | 'Raster'> & { columns: number }) => {
  const { Box, Text } = el
  if (art && Raster) return <Raster key="cover" columns={columns} rows={columns / 2} cells={coverCells(art, columns)} />
  if (art) {
    return (
      <Box flexDirection="column">
        {coverAscii(art, columns).map(line => (
          <Text dimColor>{line}</Text>
        ))}
      </Box>
    )
  }
  return (
    <Box width={columns} height={columns / 2} borderStyle="round" borderDimColor justifyContent="center" alignItems="center">
      <Text dimColor>♫</Text>
    </Box>
  )
}

// Ten clickable steps of 10%, between a mute toggle and -/+ buttons.
const Volume = ({ el, volume, act }: { el: ElementTable; volume: number | null; act: Actions }) => {
  const { Box, Button, Text } = el
  if (volume === null) return <Text dimColor>Volume is fixed on this device</Text>
  return (
    <Box marginTop={1} gap={1}>
      <Button key="mute" label={volume === 0 ? '🔇' : '🔊'} hotkey="m" plain onPress={act.mute} />
      <Button key="vol-down" label="−" plain onPress={() => act.volume(volume - 10)} />
      <Box>
        {Array.from({ length: 10 }, (_, i) => (
          <Button
            key={`vol-${i}`}
            label={(i + 1) * 10 <= volume ? '█' : '░'}
            plain
            dimColor={(i + 1) * 10 > volume}
            onPress={() => act.volume((i + 1) * 10)}
          />
        ))}
      </Box>
      <Button key="vol-up" label="+" plain onPress={() => act.volume(volume + 10)} />
      <Text dimColor>{String(volume).padStart(3)}%</Text>
    </Box>
  )
}

// The sidebar: cover art, track, progress, transport, volume, device, queue.
export const Sidebar = (props: SidebarProps) => {
  const { el, playing, progress, act, frame, queue } = props
  const { Box, Button, Text } = el
  const width = frame.width
  return (
    <Box flexDirection="column" alignItems="center" {...frame}>
      {Artwork({ ...props, columns: Math.min(32, width) & ~1 })}

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
        <Button key="shuffle" label="⇄" hotkey="s" plain dimColor={!playing.shuffle} onPress={act.shuffle} />
        <Button key="prev" label="⏮" hotkey="b" onPress={act.prev} />
        <Button key="toggle" label={playing.isPlaying ? '⏸' : '▶'} hotkey="p" variant="primary" onPress={act.toggle} />
        <Button key="next" label="⏭" hotkey="n" onPress={act.next} />
        <Button
          key="repeat"
          label={playing.repeat === 'track' ? '↻1' : '↻'}
          hotkey="r"
          plain
          dimColor={playing.repeat === 'off'}
          onPress={act.repeat}
        />
      </Box>

      {Volume({ el, volume: playing.volume, act })}
      {playing.device ? (
        <Text dimColor wrap="truncate-end">
          on {playing.device}
        </Text>
      ) : null}

      {queue.length > 0 ? (
        <Box flexDirection="column" marginTop={1} width={width}>
          <Text bold dimColor>
            Up next
          </Text>
          {queue.map((line, i) => (
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
}

// Ghostty's background from its config text, when the config sets one.
export const ghosttyBackground = (config: string) => {
  const hex = config.match(/^\s*background\s*=\s*#?([0-9a-fA-F]{6})\s*$/m)?.[1]
  return hex ? `#${hex.toLowerCase()}` : undefined
}

export const ghosttyConfigs = (home: string) => [
  `${home}/.config/ghostty/config`,
  `${home}/Library/Application Support/com.mitchellh.ghostty/config.ghostty`,
  `${home}/Library/Application Support/com.mitchellh.ghostty/config`,
]

export const GHOSTTY_DEFAULT_BACKGROUND = '#282c34'
