# token-tracker

Track AI agent token usage across Claude Code, OpenAI Codex CLI, OpenCode,
Gemini CLI, Copilot CLI, Cursor, and manual JSONL logs. Reports include
input/output/cache tokens, model pricing, cost trends, budgets, subscription
subsidy, project grouping, and a localhost dashboard.

token-tracker is local-first and zero-dependency. It reads each agent's own
local logs, stores normalized records as plain JSONL under `~/.token-tracker/`,
and sends no usage data anywhere unless you explicitly configure and run
`tt push`.

## Install

```bash
npm i -g token-tracker
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

## Optional Remote Push

Remote push is opt-in. The public CLI does not include the hosted server code and
does not ship a baked-in endpoint.

```bash
tt login <device-token> --endpoint https://your-token-tracker.example
tt push
tt remote status
```

`tt push` uploads local ledger records to `/api/ingest` on the endpoint you
configured. Pushes are explicit and idempotent; the server dedupes by record id.

## Data And Privacy

Default local files:

```text
~/.token-tracker/data/YYYY-MM.jsonl
~/.token-tracker/state.json
~/.token-tracker/pricing.json
~/.token-tracker/inbox/
~/.token-tracker/remote.json
```

The only default network request is the public LiteLLM pricing table fetch.
Usage data leaves the machine only when you configure a remote and run
`tt push`.

## Development

```bash
npm test
node bin/tt.js --help
npm pack --dry-run
```

## License

MIT
