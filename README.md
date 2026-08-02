# CC Meter

A tray widget for Windows that shows how much of your **Claude Code** and **Codex**
rate limits you have burned, and how fast you are burning them.

Not a cost tracker. It answers the only question that matters mid-session: *am I
going to hit the wall before this window resets?*

![CC Meter compact strip](docs/strip.png)

## What it shows

For each limit window: percent used, a bar, the reset time, and a **pace** badge.

Pace is the useful part. `1.0x` means you are burning quota exactly in step with
the clock, so you will run out precisely at the reset. `0.3x` means you are
coasting. `1.6x` means you will hit the wall early, and roughly how early.

- **Claude Code** - 5-hour window, weekly all-models, and weekly per-model
  (Opus, Fable, whichever your plan scopes). The per-model split is real, it
  comes from the same source the `/usage` screen uses.
- **Codex** - the account-wide windows Codex currently reports. One shared
  pool; some plans expose only a weekly window, and CC Meter never invents a
  missing one.

Two modes: a compact strip that docks against the top edge of the screen (with
optional auto-hide until you touch the edge), and a full panel with countdowns.

## Install

Download `CCMeter-Setup-x.y.z.exe` from
[Releases](../../releases) and run it. It lives in the tray, not the taskbar.

**The installer is unsigned**, so Windows SmartScreen will show
"Windows protected your PC". Click **More info** -> **Run anyway**. If you would
rather not trust a binary from a stranger on the internet, build it yourself
from the source below. That is the honest answer and it is why the source is
here.

## Where the numbers come from

CC Meter has no hosted service. It makes the Claude usage request to Anthropic
from your machine with your own OAuth token.
For Codex, it asks the installed Codex CLI for the current account snapshot;
Codex handles its own authenticated OpenAI request. CC Meter never reads the
Codex authentication token.

**Claude**: reads the standard Claude Code OAuth token from
`~/.claude/.credentials.json` and calls
`https://api.anthropic.com/api/oauth/usage` directly when the local cache is
older than ten minutes. It writes the response to
`~/.claude/usage-cache.json` and honours the cache lock. No status-line script
is required.

**Codex**: launches the local Codex app-server and calls
`account/rateLimits/read`, cached for five minutes. This returns the current
account-wide windows even when this machine's session files are old. If an
older Codex version does not expose that method, CC Meter falls back to recent
files under `~/.codex/sessions/` and discards every window whose reset time has
already passed.

### About that token

CC Meter reads your Claude OAuth token off disk and sends it to
`api.anthropic.com` and nowhere else. It is never logged, never stored anywhere
new, and never transmitted to any host but Anthropic's. The direct Claude
network path is isolated in `refreshClaudeUsage()` in `server.mjs`. Codex
authentication and account requests remain inside the installed Codex CLI.

The usage endpoint is undocumented and rate-limited (observed: HTTP 429 with a
~57 minute `Retry-After`). CC Meter refreshes at most once every 10 minutes,
honours `Retry-After` exactly, backs off exponentially on failure, and persists
that backoff across restarts so relaunching cannot hammer a locked-out endpoint.
Being undocumented, the endpoint may change or stop working without notice.

## Local HTTP server

The UI is served from `http://localhost:7373`, and `GET /usage.json` returns the
local usage data. Browser cross-origin access is disabled by default. If you
want to drive another display, set `CCMETER_CORS_ORIGIN` to that display's
specific origin before starting the server. No token or session content is
returned by this endpoint.

## Build it yourself

```bash
npm install
npm test          # isolated Claude and Codex fixture test
npm start        # dev
npm run dist     # unsigned NSIS installer -> dist/
```

Requires Node 20+ and Windows. macOS and Linux are untested; the tray behaviour
and the screen-edge dock are Windows-shaped.

## Limitations

- Windows only, for now.
- Only works with an OAuth (subscription) Claude Code login. API-key users have
  no plan limits to display.
- Live Codex readings require a Codex CLI version that exposes
  `account/rateLimits/read`. Older versions use the filtered session-log
  fallback and update only when Codex writes a session file.
- No auto-update. Watch the releases page.

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with, endorsed by, or supported by Anthropic or OpenAI.
