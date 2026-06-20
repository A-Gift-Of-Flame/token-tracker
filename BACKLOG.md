# BACKLOG - Strategic Roadmap (public client)

**Product:** token-tracker (CLI client)
**Execution Mode:** operating
**Updated At:** 2026-06-20 (client-only state docs established, split from the private
server repo. This backlog tracks CLIENT work — CLI, collectors, local dashboard,
presence, and the client-side cloud touchpoints `tt login`/`tt push`. Server-side
items, cloud ingest/auth/dashboard, deploy, and security review live in the private
`token-tracker-server` repo.)

## Purpose

This backlog tracks medium-term CLIENT work using stable backlog IDs.
Reference these IDs from `NEXT_ACTIONS.md`. Shipped detail lives in `WORKLOG.md`.

## EPIC: agent-agnostic Discord presence

Pivot locked 2026-06-15. Presence is folded into the public client as an
AGENT-AGNOSTIC feature; the standalone `claude-discord-rpc` plugin is deprecated and
archived. Governing principle: **richness and truthfulness above all** — push each
agent to its real richness ceiling, never fabricate/overstate; stale or session-end
data is never shown as live. Per-agent ceilings (ADR 0002, BL-141): Claude Code =
hook-rich; Codex/Gemini/OpenCode = live-tail; Copilot CLI / Cursor = session-end.
Daemon carve-out: opt-in, bounded, single-instance, clears when the watched agent
pid dies. Discord IPC is hand-rolled `node:net` (zero-dep).

## NOW

- [BL-147] Multi-agent Discord presence — "always works" across concurrent agents.
  Slice 1 shipped (`PresenceMultiplexer` + `renderMultiplexActivity`, `tt presence
  --all`): headline by interactivity tier + recency tiebreak, labelled background
  aggregate, per-source liveness. Remaining: make the tier/override
  user-configurable; wire the multiplexer into the live source set. Arbitration =
  primary-headline + background-aggregate; run model = ONE multiplexing daemon
  (one IPC socket per client id). Client-side.

- [BL-149] Presence skill-heartbeat signal source — `tt presence signal --agent X
  --project Y` writing an inbox/signal file the daemon consumes, plus a thin
  cross-harness skill that emits it on session start/turn. Advisory tier only (below
  hooks), per ADR 0002 §6 — presence must not depend on it for a "live" claim. Low
  token overhead by design. Client-side.

- [BL-152] `tt serve` dashboard — event/ingest-driven update instead of a fixed
  timer poll. Today `src/server.js` injects `POLL_MS` and the page runs
  `setInterval(() => { if (!document.hidden) { load(); loadFees(); } }, POLL_MS)`
  while the server-side timer separately re-runs `sync()` — data updates on a clock,
  not when new data lands. Unlike the cloud server, `tt serve` is a SINGLE process
  owning both ingest and the dashboard, so an in-process "data changed" event → SSE
  push is trivial (no per-tenant fan-out). Task: audit the poll path; push to open
  tabs via SSE on non-empty `sync()`; keep a slow poll only as fallback. Honour the
  no-daemon invariant (SSE lives inside the foreground `tt serve`). Truthfulness: a
  fallback poll must still say "as of last poll". Client-side.

## LATER

- Standalone binaries (Node SEA) as a distribution polish — possible future, not
  pursued. Related: BL-137.

## DONE

Shipped client work. Full detail in `WORKLOG.md`; presence audit in
`docs/presence/bl-141-live-richness-audit.md`; presence ADR in `docs/adr/0002`.

- [BL-148] Presence run-model wiring — multiplexed presence installable as an
  always-on service (`token-tracker-presence` → `tt presence --all`), a second
  dedicated service (NOT a flag on the sync watcher). Opt-in via `tt service install
  --presence` / `TT_PRESENCE=1`. Shipped 2026-06-16.
- [BL-147 slice 1] PresenceMultiplexer + renderMultiplexActivity + `tt presence
  --all`. Shipped 2026-06-16.
- [BL-145] `claude-discord-rpc` deprecated: final `v0.2.0` release + README redirect
  to `tt presence`, repo archived read-only. Shipped 2026-06-16.
- [BL-144] Agent-agnostic live-tail presence sources (Codex, Gemini CLI, OpenCode) +
  `tt presence --source store|claude|codex|gemini|opencode`. Shipped 2026-06-16.
- [BL-143] Claude Code hook-rich presence daemon — `tt presence
  install|uninstall|launch|daemon|session-end`, bounded transcript-tail daemon with
  `/proc` liveness + PID-reuse guard. Shipped 2026-06-16.
- [BL-142] Presence engine core + foreground `tt presence` baseline — zero-dep DRPC
  IPC port (`node:net`), pluggable source seam, truthful renderer, clean SIGTERM
  clear. Shipped 2026-06-15.
- [BL-141] Per-agent live-richness audit — `docs/presence/bl-141-live-richness-audit.md`,
  6-agent feasibility matrix. Shipped 2026-06-16.
- [BL-140] Presence DNA amendment + ADR 0002 ratified (design-only). 2026-06-15.
- [BL-140] Automatic push (client side) — persisted `autoPush` in `remote.json`,
  `tt login --auto-push`, `tt remote auto-push on|off`, `tt sync` tail-hook push;
  non-fatal on offline. Sync-hook path, no scheduler/daemon. Shipped 2026-06-16.
- [BL-139] Repo split — public client repo live (clean history), npm
  `token-tracker@1.0.1`. Client is the sole home for `bin/`+`src/`. 2026-06-15.
- [BL-137] Distribution — GitHub-only install
  (`npm i -g github:A-Gift-Of-Flame/token-tracker`); bare npm name is squatted.
  README install updated, Node floor ≥22.5. Shipped 2026-06-16.
- [BL-132] CLI GitHub OAuth device-flow login (client half) — `tt login --github
  --endpoint URL [--auto-push]`. Server endpoints tracked in the server repo.
  Shipped 2026-06-16.
- [BL-129] CLI push client — `src/remote.js`: `loadRemote`/`saveRemote`, `tt login`,
  `tt push [--since|all]`, `tt remote status`; 0600 config, high-water mark, posts
  ledger records. Shipped 2026-06-15.
- [BL-123] Copilot CLI collector — `~/.copilot/session-state/*/events.jsonl`,
  per-session shutdown metrics; pricing dot→dash fix. Shipped 2026-06-14.
- [BL-122] Cursor collector — `~/.cursor/chats/.../store.db` (protobuf-in-SQLite);
  input=context tokens, output=0, $0 subscription. Shipped 2026-06-14.
- [BL-121] Historical project backfill (`reproject`). Shipped 2026-06-13.
- [BL-120] `tt serve` foreground auto-sync — unref'd in-process timer, `--interval S`,
  hidden-tab-paused page poll (`POLL_MS`). Shipped 2026-06-13.
- [BL-119] Multi-machine merge — `export --ledger` JSONL + `tt import`. 2026-06-13.
- [BL-118] CSV/Markdown export (`tt export`). Shipped 2026-06-13.
- [BL-117] Subsidy crossover / break-even verdict. Shipped 2026-06-13.
- [BL-116] Efficiency metrics (`--efficiency`). Shipped 2026-06-13.
- [BL-115] Period compare (`--vs last`). Shipped 2026-06-13.
- [BL-114] Daily/monthly cost ceilings. Shipped 2026-06-13.
- [BL-113] Run-rate forecast (`--forecast`). Shipped 2026-06-13.
- [BL-112] Per-project attribution (`--by project`). Shipped 2026-06-13.
- [BL-111] Subscription subsidy + dashboard redesign — `src/subscriptions.js`,
  zero-dep SVG dashboard. Shipped 2026-06-13.
- [BL-110] Local dev server (`tt serve`, localhost, no daemon). Shipped 2026-06-13.
- [BL-108] Collector smoke tests. Shipped 2026-06-13.
- [BL-107] Gemini CLI collector — `~/.gemini/.../session-*.jsonl`. Shipped 2026-06-14.
- [BL-106] `tt reprice` — recompute stored cost from current pricing. 2026-06-13.
- [BL-105] Budget awareness — monthly budget, consumed line. Shipped 2026-06-13.
- [BL-104] Reporting upgrades — `--last N`, `--trend`, `--compact`. Shipped 2026-06-13.
- [BL-103] Codex collector — `~/.codex/sessions`, real rollout ingests. 2026-06-13.
- [BL-102] Cache-write tier pricing (Claude 1h/5m). Shipped 2026-06-13.
- [BL-101] Published to GitHub. Shipped 2026-06-13.
