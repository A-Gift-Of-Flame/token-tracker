# WORKLOG (public client)

**Purpose:** Append-only history for completed CLIENT work.

Use this file for dated session notes, verification summaries, and references to
evidence artifacts. Server-side history lives in the private `token-tracker-server`
repo. Full per-commit detail is in `git log`.

## 2026-06-20 — Client state docs established (split from private server repo)

Stood up a bespoke client-only StateDD instance in this public repo: AGENTS.md,
STATUS.md, PROJECT_STATE.yaml, PROJECT_DNA.yaml, PROJECT_ADAPTER.yaml,
NEXT_ACTIONS.md, BACKLOG.md, WORKLOG.md, docs/EVIDENCE_LOG.md,
docs/ACCEPTANCE_FREEZES.md, prompts/, and scripts/check_state_docs.py. Content is
scoped to the client (CLI, collectors, local dashboard, presence, client-side cloud
touchpoints); server-internal deploy/auth/VPS detail is deliberately excluded so the
public repo stays clean. Backlog items were split: client items tracked here,
server items remain in the private server repo. `python3 scripts/check_state_docs.py`
green.

## 2026-06-16 — Presence epic shipped and closed

- BL-148: multiplexed presence installable as an always-on service
  (`token-tracker-presence` → `tt presence --all`), a second dedicated service so
  the sync watcher stays isolated. Opt-in via `tt service install --presence` /
  `TT_PRESENCE=1`. Pure unit/plist/task builders unit-tested.
- BL-147 slice 1: `PresenceMultiplexer` + `renderMultiplexActivity` exposed as
  `tt presence --all` — headline by interactivity tier + recency tiebreak, labelled
  background aggregate, per-source liveness. ADR 0002 amended for the three locked
  decisions (arbitration, one multiplexing daemon, layered signal tiers).
- BL-145: deprecated `claude-discord-rpc` — final `v0.2.0` release with a README
  redirect to `tt presence`, repo archived read-only.
- BL-144: agent-agnostic live-tail sources (Codex, Gemini CLI, OpenCode) +
  `tt presence --source store|claude|codex|gemini|opencode`. Codex tails newest
  rollout JSONL; Gemini emits `activity:null`+`missing:["activity"]` (no proven
  activity signal); OpenCode reads `opencode.db` read-only with $0 only for confirmed
  local providers. Tests: `test/presence-live-sources.test.js`.
- BL-143: Claude Code hook-rich presence daemon — `tt presence
  install|uninstall|launch|daemon|session-end`; bounded transcript-tail daemon,
  cleanup precedence = SessionEnd marker → `/proc` liveness w/ PID-reuse guard → idle
  timeout. Runtime under `~/.token-tracker/presence-daemon`.
- BL-141: per-agent live-richness audit — `docs/presence/bl-141-live-richness-audit.md`.

## 2026-06-16 — Distribution + client cloud touchpoints

- BL-137: GitHub-only install resolved — bare npm `token-tracker` is squatted, so the
  official path is `npm i -g github:A-Gift-Of-Flame/token-tracker`; verified
  end-to-end. README install updated, Node floor ≥22.5.
- BL-140 (auto-push): persisted `autoPush` in `remote.json`, `tt login --auto-push`,
  `tt remote auto-push on|off`, `tt sync` tail-hook push (non-fatal offline). Sync-hook
  path — no OS scheduler, no daemon. `test/auto-push.test.js`.
- BL-132: CLI GitHub OAuth device-flow login (`tt login --github`). Server endpoints
  are in the private server repo.

## 2026-06-15 — Presence foundation

- BL-142: presence engine core + foreground `tt presence` baseline — zero-dep DRPC
  IPC port (`node:net`, framed JSON, READY gate, SET_ACTIVITY, PING/PONG), pluggable
  source seam, truthful local-store renderer, clears `activity:null` on Ctrl-C/SIGTERM.
- BL-140: presence DNA amendment + ADR 0002 ratified (design-only).
- BL-139: public client repo published with clean history; npm `token-tracker@1.0.1`;
  client is the sole home for `bin/` + `src/`.

## 2026-06-13/14 — Local core build (condensed)

Earlier shipped local-client work (Claude Code + scheduled sessions):
- Collectors: Codex (BL-103), Gemini CLI (BL-107), Copilot CLI (BL-123), Cursor
  (BL-122) on top of Claude Code + OpenCode + inbox.
- Pricing: cache-write TTL tiers (BL-102), `tt reprice` (BL-106), LiteLLM 24h cache.
- Reporting: `--last N`/`--trend`/`--compact` (BL-104), `--vs last` compare (BL-115),
  `--efficiency` (BL-116), `--by project` + `reproject` backfill (BL-112/121),
  `--forecast` (BL-113), cost ceilings (BL-114), CSV/MD export (BL-118).
- Subsidy: `src/subscriptions.js` dynamic plan detection + web-configurable fees +
  net/coverage/crossover (BL-111/117), budget awareness (BL-105).
- Local dashboard: `tt serve` (BL-110) + reskin/SVG graphs (BL-111) + foreground
  auto-sync timer (BL-120). Multi-machine merge `export --ledger` + `tt import`
  (BL-119). Collector smoke tests (BL-108).
- BL-101: published to GitHub.

Full per-slice detail and evidence references for this period predate the doc split
and remain in the private server repo's WORKLOG and in `git log`.
