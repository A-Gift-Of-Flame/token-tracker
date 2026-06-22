# token-tracker

Track AI agent token usage across Claude Code, OpenAI Codex CLI, OpenCode,
Gemini CLI, Copilot CLI, Cursor, and manual JSONL logs. Reports include
input/output/cache tokens, model pricing, cost trends, budgets, subscription
subsidy, project grouping, and a localhost dashboard.

token-tracker is local-first and zero-dependency. It reads each agent's own
local logs and stores normalized records as plain JSONL under
`~/.token-tracker/`. Once you sign in, it auto-pushes those records to the
hosted server at **tt.agiftofflame.com** so your usage is aggregated in one
place across every machine.

## Install

One line. Puts `tt` on your PATH, signs you in (GitHub device flow), and
installs an always-on background service so usage syncs forever — no follow-up
commands, nothing to configure, survives reboots and crashes.

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/A-Gift-Of-Flame/token-tracker/master/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/A-Gift-Of-Flame/token-tracker/master/install.ps1 | iex
```

The server is baked in — there is no URL to enter. The installer is idempotent;
re-running just updates and re-checks each step.

Prefer npm, or only want the CLI without the background service:

```bash
npm i -g github:A-Gift-Of-Flame/token-tracker
tt today
```

Requires Node.js >= 22.5.0.

## Supported Sources

| Agent | Collection path |
| --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| OpenAI Codex CLI | `~/.codex/sessions/**/*.jsonl` |
| OpenCode | local OpenCode SQLite database |
| Gemini CLI | `~/.gemini/tmp/*/chats/session-*.jsonl` and history chats |
| Copilot CLI | `~/.copilot/session-state/*/events.jsonl` shutdown events |
| Cursor | `~/.cursor/chats/<chatId>/<agentId>/store.db` |
| Anything else | `tt log` or JSONL files dropped into `~/.token-tracker/inbox/` |

Local models such as ollama, LM Studio, llama.cpp, and vLLM are tracked and
priced at `$0`.

## Common Commands

```bash
tt today
tt week
tt month
tt year
tt all
tt last --last 7

tt month --by agent
tt month --by model
tt month --by project
tt month --trend
tt month --forecast
tt month --vs last
tt month --efficiency
tt month --compact
tt month --json
tt month --no-sync
tt month --offline
```

Reports auto-sync first unless `--no-sync` is passed.

## Local Dashboard

```bash
tt serve
tt serve --port 8080
tt serve --interval 30
```

The dashboard binds to `127.0.0.1`, uses hand-written HTML/CSS/SVG, and runs in
the foreground. Its refresh timer is tied to the `tt serve` process and dies
with Ctrl-C.

## Manual And JSONL Import

```bash
tt log --agent gemini-cli --model gemini-2.5-pro --input 50000 --output 8000
tt export all --ledger --out ledger.jsonl
tt import ledger.jsonl
```

Drop JSONL files into `~/.token-tracker/inbox/` and run `tt sync` for bulk
imports. Native ledger imports dedupe by record id, so re-importing is safe.

## Budgets, Subsidy, And Repricing

```bash
tt budget --set 200
tt budget --set-daily 25
tt subsidy month
tt subsidy --set claude.pro=20,chatgpt.pro=200
tt reprice --dry-run
```

Stored cost is always metered API-equivalent token cost. Subscription subsidy,
budget progress, forecasts, and cache-efficiency metrics are derived views.

## Cloud Sync

The server is hardcoded to **tt.agiftofflame.com**; there is no endpoint to
configure. Sign in once and auto-push is on by default — every `tt sync` (and
the always-on service) pushes new records up automatically. The installer wires
this up for you; the commands below are the manual path.

```bash
tt login                 # GitHub device flow; saves the minted device token
tt login <device-token>  # or paste a token directly (same effect)
tt push                  # push new local records now
tt remote status         # sign-in state + last-push time
tt remote auto-push off  # opt out of automatic push (re-enable with: on)
```

`tt push` uploads local ledger records to `/api/ingest`. Pushes are idempotent —
the server dedupes by record id, so re-pushing never double-counts. Pass
`--no-auto-push` at login if you want to push only manually. Dev-only: set
`TT_ENDPOINT` to point the CLI at a throwaway server instead of production.

## Always-On Background Sync

The installer sets this up for you. To manage it directly:

```bash
tt service install      # install + start the boot service (auto-detects OS)
tt service status       # is it running?
tt service uninstall    # stop and remove it
```

`tt service` installs a real OS supervisor — systemd user unit (Linux), launchd
LaunchAgent (macOS), or Scheduled Task (Windows) — that runs `tt watch`
(sync + push every 60s) with auto-restart, starting on boot. This is the
supported way to keep the dashboard live; you never hand-write a unit file.

For a one-off foreground run instead (Ctrl-C to stop):

```bash
tt watch --interval 60
```

## Discord Rich Presence

token-tracker can publish your live agent usage to Discord as Rich Presence,
agent-agnostic across Claude Code, Codex, Gemini, and OpenCode.

```bash
tt presence                       # foreground; Ctrl-C clears activity
tt presence --source claude       # pick a source: store|claude|codex|gemini|opencode
tt presence install               # opt-in Claude Code hooks for a bounded daemon
```

Presence is truthful by design: it reflects actual live state and never
fabricates fields — stale data shows as stale, session-end-only usage is not
labelled "live", and missing fields are shown as missing rather than invented.
Richness is per-agent (Claude Code is hook-rich; others are live-tail or
session-end), so each agent reports to its real ceiling, not a faked uniform one.

## Data And Privacy

Default local files:

```text
~/.token-tracker/data/YYYY-MM.jsonl
~/.token-tracker/state.json
~/.token-tracker/pricing.json
~/.token-tracker/inbox/
~/.token-tracker/remote.json
~/.token-tracker/presence.json
```

Records stay on the machine until you sign in; after that, auto-push uploads
them to tt.agiftofflame.com on each sync (turn it off with
`tt remote auto-push off`). The other network request is the public LiteLLM
pricing table fetch.

## Development

```bash
npm test
node bin/tt.js --help
npm pack --dry-run
```

## License

MIT
