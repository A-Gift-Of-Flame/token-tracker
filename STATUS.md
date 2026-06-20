# token-tracker Status (public client)

**Updated At:** 2026-06-20
**Execution Mode:** operating
**Project State:** published client (npm `token-tracker`, GitHub install) + presence epic shipped
**Cloud tier:** separate private repo (`token-tracker-server`); this client only talks to it via opt-in `tt login` + `tt push`

## Snapshot

- CLI (`tt`) working end-to-end: sync; day/week/month/year/all reports + `last --last N`, `--trend`, `--compact`, `--vs last` compare, `--efficiency`, `--by project` + `reproject`; `subsidy`, `budget`/`--forecast`, cost ceilings, `reprice`, `export` CSV/MD, manual `log`, inbox import.
- Collectors verified against real local data: Claude Code, OpenCode, Codex (`~/.codex/sessions`), Gemini CLI (`~/.gemini/.../session-*.jsonl`), Copilot CLI (`~/.copilot/session-state/*/events.jsonl`), Cursor (`~/.cursor/chats/.../store.db`, protobuf-in-SQLite; input=context tokens, output=0, $0 subscription).
- Subscription subsidy: flat-plan vs metered. Dynamic plan detection (Codex `chatgpt_plan_type`, Claude `subscriptionType`), web-configurable fees, net + coverage + crossover/break-even. Stored cost stays metered; subsidy is derived.
- Local dashboard (`tt serve`): zero-dep node:http + hand-rolled HTML/CSS/SVG (KPI cards, daily-cost bars, breakdown share bars, subsidy coverage bars, editable fees). Auto-syncs on a foreground unref'd timer (`--interval S`, default 60s, 0 disables) — not a daemon.
- Presence epic shipped: `tt presence` is the sole supported presence path — foreground Discord Rich Presence, opt-in Claude Code hook daemon, live-tail sources (`--source store|claude|codex|gemini|opencode`), and a multi-agent multiplexer (`tt presence --all`, BL-147 slice 1) installable as an optional always-on service (BL-148). The standalone `claude-discord-rpc` plugin was given a final `v0.2.0` deprecation release and archived.
- Live pricing via LiteLLM table (24h cache); local ollama models correctly $0; Claude cache writes priced per TTL tier. Syncs idempotent. Zero dependencies, CommonJS, Node ≥ 22 for `node:sqlite`.
- Distribution: public repo `github.com/A-Gift-Of-Flame/token-tracker`; install via `npm i -g github:A-Gift-Of-Flame/token-tracker`. (Bare npm name is squatted — GitHub install is the official path.)

## Immediate Priorities

1. [BL-147] Finish multi-agent presence beyond slice 1 (user-configurable tier/override).
2. [BL-149] Presence skill-heartbeat signal source (advisory tier, below hooks).
3. [BL-152] `tt serve` dashboard: event/ingest-driven update instead of fixed-timer poll.

## Active Blockers

- None. Presence ADR 0002 ratified; BL-141..145 + BL-147 slice 1 + BL-148 done.

## Notes

- Data lives in `~/.token-tracker/` (override: `TOKEN_TRACKER_DIR`).
- This is the public client repo. The cloud server (auth, ingest API, multi-tenant
  dashboard, deployment) lives in the private `token-tracker-server` repo and must
  never be referenced with server-internal detail here.
- Client-side backlog items are tracked in this repo's `BACKLOG.md`; server-side
  items live in the private server repo.
