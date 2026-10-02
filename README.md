# claudify

Spotify inside Claude Code. Connect your account, keep a player sidebar next to
your session, and control playback with `/spotify` or by asking Claude
("put on some lofi focus music").

- Sidebar with album cover art (colored block art; ASCII on surfaces without
  graphics), title, artist, album, live progress bar, queue and device
- Controls: play/pause, next/previous, shuffle, repeat, volume bar, mute
  (keys `p` `n` `b` `s` `r` `m` when the sidebar has focus)
- Opens by itself when music starts
- Background that matches your terminal (Ghostty detected), the album's color,
  or any hex color

Playback control needs Spotify Premium; cover art uses macOS's `sips`.

## Install

Claude Code loads it from a plugin folder. Add this to the `env` block of
`~/.claude/settings.json`:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claudify"
```

or run `claude --plugin-dir /path/to/claudify`.

## Connect Spotify (one time)

1. Create an app at https://developer.spotify.com/dashboard
2. Add the Redirect URI `http://127.0.0.1:8888/callback` and tick "Web API"
3. In Claude Code: `/spotify setup <client-id>`, then `/spotify login`

No client secret is needed (Authorization Code with PKCE).

## Commands

```
/spotify                        open the player sidebar
/spotify play [query]           resume, or search a track and play it
/spotify playlist <query>       search a playlist and play it
/spotify pause | toggle | next | prev
/spotify vol <0-100> | mute
/spotify shuffle on|off | repeat off|context|track
/spotify bg terminal|none|album|#rrggbb
/spotify devices | now | close | logout | help
```

## Develop

```
claude plugin validate .
claude plugin test .
```
