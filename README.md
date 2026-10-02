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

In a terminal:

```
claude plugin marketplace add jasonzh0/claudify
claude plugin install claudify@claudify
```

or inside Claude Code: `/plugin marketplace add jasonzh0/claudify`, then
`/plugin install claudify@claudify`. Restart Claude Code to load it.

## Log in

```
/spotify login
```

Your browser opens Spotify's consent page; approve it and you're connected.

The built-in claudify Spotify app is in Spotify's development mode, which only
serves accounts its owner has added (up to 25). If Spotify refuses your account,
ask to be added, or use your own app (about a minute, no limit):

1. Create an app at https://developer.spotify.com/dashboard
2. Add the Redirect URI `http://127.0.0.1:8888/callback` and tick "Web API"
3. `/spotify setup <client-id>`, then `/spotify login`

No client secret is involved anywhere (Authorization Code with PKCE); tokens
stay in Claude Code's plugin storage on your machine.

## Develop

Load a checkout instead of the installed copy with
`claude --plugin-dir /path/to/claudify`, or set `CLAUDE_CODE_PLUGIN_DIRS` in the
`env` block of `~/.claude/settings.json`.

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
/spotify setup <client-id> | setup default
```

## Test

```
claude plugin validate .
claude plugin test .
```
