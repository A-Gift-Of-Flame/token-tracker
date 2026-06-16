# ADR 0002 — agent-agnostic Discord Rich Presence (opt-in presence daemon)

- **Status:** Accepted (ratified by user 2026-06-15)
- **Date:** 2026-06-15
- **Backlog:** BL-140 (gates BL-142 → BL-144, all presence code)
- **Deciders:** user (ratified), coding-agent session
- **Scope:** design contract only — no runtime code in this slice.

## Context

token-tracker is a local-first, zero-dependency CLI (`tt`) that reads each AI
agent's own on-disk logs, normalizes usage into JSONL records, prices them, and
reports in the terminal or localhost dashboard. Its client invariant is explicit:
no background daemon in the CLI client.

The user wants to fold the existing `claude-discord-rpc` idea into token-tracker
as an **agent-agnostic Discord Rich Presence** feature. That creates a real
tension: live presence needs a process that stays connected to Discord IPC while
an agent session is active. Taken naively, that is a background daemon in the
client and collides with the invariant.

The decision is how to preserve the default client promise while allowing the
richest truthful presence each agent can support. This mirrors ADR 0001: the
invariant is not deleted or quietly weakened; a bounded, opt-in subsystem is
named explicitly and constrained tightly.

BL-139..145 also lock the distribution pivot: the server stays private, the
public client ships on npm, and the separate `claude-discord-rpc` plugin is
deprecated in favor of `tt presence` once the presence feature ships.

## Decision

### 1. Richness and truthfulness are the governing principle.

Presence must push each agent to its real richness ceiling, but **never
fabricate, guess, or overstate**. Presence reflects actual live state:

- no fake "live" status when data is stale or session-end-only;
- estimated cost is labelled as estimated, exact cost only when exact;
- missing fields remain missing, not invented;
- truthful-but-modest beats impressive-but-wrong.

This binds every presence slice: BL-141 (audit), BL-142 (foreground engine),
BL-143 (Claude hook-rich daemon), and BL-144 (agent-agnostic live-tail sources).

**Exposure is a separate axis from accuracy.** Truthfulness governs *correctness*,
not *visibility*. Discord Rich Presence is a public surface: enabling presence may
surface real `project` (repo basename) and real `cost` to the user's Discord
audience. This is **accepted, not redacted by default** — controlling who sees
their Discord activity is the user's responsibility, and presence is opt-in. The
data shown is real; the decision to broadcast it is the user's. A per-field
exposure toggle (hide project / hide cost) is a possible future convenience, not a
required default.

### 2. Per-agent richness ceiling is not uniform.

The table below is **provisional pending the BL-141 feasibility audit**, which
verifies each agent's actual live write surface. BL-141 may downgrade a ceiling
(e.g. an agent that writes less live than assumed); it may not invent richness an
agent's logs do not expose. The Claude=full and Copilot=session-end endpoints are
firm; the live log-tail middle is the part BL-141 confirms.

| Agent | Presence ceiling | Reason |
| --- | --- | --- |
| Claude Code | **Full** — hook-enabled live activity, tools, thinking, tokens, model, cost, project. SessionStart launches the presence path; later Claude-specific hooks/status surfaces may drive richer updates. | Claude Code has hooks and live transcript/statusline surfaces. DRPC proves the high-richness path for Claude today. |
| Codex | **Live log-tail** — model, tokens, cost, project at about 1-2s lag. | Existing collector parse logic can be reused over live session logs; no Claude-style hooks are known. |
| Gemini | **Live log-tail** — model, tokens, cost, project at about 1-2s lag. | Existing collector parse logic can be reused over live chat logs; no Claude-style hooks are known. |
| OpenCode | **Live log-tail** — model, tokens, cost, project at about 1-2s lag. | Existing collector parse logic can be reused over its live source; no Claude-style hooks are known. |
| Copilot CLI | **Session-end only** — final model/tokens/cost/project after shutdown. | Usable metrics are written only at `session.shutdown`; no truthful live data is available. |

The richness gap is intrinsic. "Same as Claude" is reachable only for Claude
unless another agent exposes equivalent live hooks. Copilot's limitation is a
documented ceiling, not a bug.

### 3. Discord IPC is a zero-dependency `node:net` port from DRPC.

Presence uses the DRPC IPC contract, implemented with Node builtins only:

- Transport: `node:net` local IPC socket / named pipe.
- Frame format: `[opcode int32 LE][length int32 LE][utf8 JSON payload]`.
- Opcodes: `HANDSHAKE = 0`, `FRAME = 1`, `CLOSE = 2`, `PING = 3`, `PONG = 4`.
- Socket discovery:
  - Windows named pipes: `\\?\pipe\discord-ipc-{0..9}`;
  - POSIX candidates under `XDG_RUNTIME_DIR`, `TMPDIR`, `TMP`, `TEMP`, and
    `/tmp`;
  - Discord install prefixes: plain, `snap.discord/`, and
    `app/com.discordapp.Discord/`;
  - socket names: `discord-ipc-{0..9}`.
- Handshake payload: `{ v: 1, client_id }`. **`client_id` reuses the existing
  registered `claude-discord-rpc` Discord application id for now** — DRPC is being
  deprecated into `tt`, so its app id (and its presence icon/name) carry over with
  zero new registration. Registering a dedicated token-tracker Discord application
  (own name/icon) is deferred; it is a config swap, not an architectural change.
- READY-gated connect: presence may not send activity until Discord returns
  `evt: "READY"`.
- Activity command shape:

```json
{
  "cmd": "SET_ACTIVITY",
  "args": { "pid": 12345, "activity": {} },
  "nonce": "random-uuid"
}
```

- Clear activity sends the same command with `activity: null`.
- `PING` frames are answered with `PONG` carrying the same payload.
- `CLOSE` frames end the socket.

This preserves the zero-dependency invariant: no Discord RPC package is added.

### 4. Presence-source abstraction feeds one renderer.

Presence has one rendering engine and one adapter per agent. Each adapter:

- declares its ceiling: `live`, `log-tail`, or `session-end`;
- reuses the corresponding collector's parse logic where possible;
- emits a normalized presence state: agent, project, model, activity, tokens,
  cost, estimate/exact flags, timestamps, and missing-field markers;
- never mutates the source agent's files.

This is the design seam that lets BL-142 foreground `tt presence`, BL-143 Claude
hook-daemon presence, and BL-144 live-tail adapters all feed one Discord renderer
without duplicating activity formatting.

### 5. The presence-daemon carve-out is opt-in, bounded, and passive.

The default install starts **zero** presence processes. No daemon runs unless the
user enables presence. With presence disabled, the no-daemon client invariant is
fully intact.

There are two presence execution paths:

- **Foreground path:** `tt presence`, like `tt serve`, runs in the foreground and
  clears on Ctrl-C. This path is invariant-clean without any carve-out.
- **Daemon path:** the Claude/full-richness path may auto-launch a detached
  presence daemon on watched-agent start. This is the additive part that needs
  the explicit carve-out.

The daemon carve-out inherits DRPC's proven model:

- **Auto-launch on agent start:** DRPC's `SessionStart` hook runs `launcher.js`,
  which spawns `daemon.js` detached with ignored stdio and calls `unref()`, then
  exits so the hook does not block the agent.
- **Auto-clear / self-exit when the watched agent dies:** shutdown is detected
  by three signals, in order of precision:
  1. clean exit marker: DRPC's `SessionEnd` hook writes `ENDED_FILE`;
  2. PID liveness: `live.json` pins the real Claude PID; `pidAlive()` uses
     `process.kill(pid, 0)` and, on Linux, verifies `/proc/<pid>/comm` and
     `/proc/<pid>/cmdline` with a `claude` / `claude-code` regex to defeat PID
     reuse;
  3. idle-timeout fallback: `IDLE_EXIT_MS` for non-Linux, unknown PID, or stale
     sessions.

  **Truthfulness under weak liveness (non-Linux).** Without `/proc`, a crashed
  agent that never wrote a clean `ENDED_FILE` marker can leave presence showing a
  "live" agent until `IDLE_EXIT_MS` elapses — a temporary overstatement against §1.
  To bound it: `IDLE_EXIT_MS` is kept short on non-Linux, and presence prefers a
  freshness signal — activity is rendered from the agent's last write timestamp, so
  a stalled session degrades to a stale/idle indication rather than a confident
  "live now" while the timeout runs out. Linux paths keep the precise `/proc` check.
- **Single-instance guard:** DRPC uses a pidfile lock. The lock records both PID
  and daemon script path so the launcher can replace a stale daemon from an older
  plugin version instead of leaving stale code running.
- **Concurrent agents → one Discord slot, last-active-wins.** Discord exposes a
  single activity per `client_id`. Multiple agents may run at once (e.g. Claude and
  Codex). Presence does **not aggregate** them: aggregation would cram two agents
  into Discord's two activity lines (less richness each) and cannot truthfully merge
  per-agent activity/tokens/cost. Instead the single presence slot reflects the
  **most-recently-active** agent — the one whose source emitted the latest event —
  at that agent's full ceiling. Backgrounded agents are not shown; this is truthful
  (it shows exactly one real current focus) rather than a blended fiction.
  Rejected: aggregate/multiplex (richness + truthfulness loss, see §1).
- **Passive:** the daemon reads agent logs/status files only, never mutates
  source files, never writes prompts, never touches the model, and consumes zero
  model tokens.

The token-tracker implementation must preserve these properties. Anything that
outlives the watched agent, runs without user opt-in, or writes back into agent
state violates this ADR.

### 6. `claude-discord-rpc` is formally deprecated into token-tracker.

The separate `claude-discord-rpc` plugin/repo is superseded by token-tracker's
agent-agnostic presence subsystem. Presence moves into the public `tt` client so
Claude, Codex, Gemini, OpenCode, Copilot CLI, and future collectors can share one
renderer and one truthfulness contract.

The actual npm publish, archive action, and user-facing deprecation notice are
deferred to BL-145. This ADR ratifies the architectural decision only.

## Invariants ratified (see PROJECT_DNA.yaml)

Local-core invariants remain binding by default, and new presence invariants are
added:

- Default client: no background daemon, no database, no server deployment, no
  implicit telemetry. Presence disabled means zero presence processes.
- Foreground presence: `tt presence` is foreground-only, like `tt serve`, and
  needs no daemon exception.
- Daemon presence: the opt-in presence daemon is the sole bounded client-side
  exception to the no-background-daemon invariant. It may auto-launch only for a
  watched active agent, must be single-instance guarded, and must clear/self-exit
  when that agent dies.
- Read-only: presence is passive over agent logs/status surfaces and never
  mutates source files or model state.
- Zero-dep: Discord IPC is hand-rolled with `node:net`; no runtime dependency is
  added.
- Truthfulness: presence never fabricates or overstates live state; estimated
  values and missing fields are represented honestly.

The `is_not` block keeps `background_daemon` and annotates it as the default CLI
client promise, with the opt-in cloud server and opt-in presence daemon carved
out explicitly.

## Consequences

**Positive**

- The default install and default client behavior remain daemon-free.
- The richest Claude Code presence remains possible because the daemon exception
  is explicit instead of hidden.
- Codex, Gemini, OpenCode, Copilot CLI, and future agents get presence through
  the same renderer without pretending their live surfaces are equal.
- DRPC's useful zero-dep IPC and liveness model are preserved while retiring a
  fragmented Claude-only plugin.
- Truthfulness becomes an enforceable design constraint for all downstream
  presence slices.

**Negative / risks**

- A client-side daemon exception increases implementation risk and must stay
  tightly fenced.
- Per-agent output will look uneven. That is intentional, but it may disappoint
  users expecting Claude-level richness everywhere.
- Live-tail adapters can lag or miss fields depending on each agent's write
  timing and log format.
- `/proc` PID verification is Linux-specific; non-Linux paths rely on clean
  markers, short idle-timeout, and freshness-based degradation (§5) to avoid
  overstating a dead session as live.
- Presence is a public surface: real `project` and `cost` can be broadcast to the
  user's Discord audience. Accepted by design (§1) — exposure is the user's
  responsibility, presence is opt-in, and an optional per-field hide is deferred.
- Concurrent agents collapse to one Discord slot (last-active-wins, §5); a
  backgrounded agent is not reflected until it next emits activity.
- Discord IPC is an unofficial local IPC contract and may drift; the zero-dep
  implementation must handle connection failure and reconnect conservatively.

## Alternatives considered

- **Foreground-only / no daemon.** Rejected: invariant-clean, but it loses live
  Claude richness unless the user manually keeps `tt presence` running for every
  session. That fails the stated goal of maximum truthful richness.
- **Keep DRPC as a separate plugin.** Rejected: fragmented, Claude-locked, and
  duplicates a renderer token-tracker can make agent-agnostic.
- **Relax the no-daemon invariant outright.** Rejected: dishonest for the same
  reason ADR 0001 rejected a blanket server relaxation. The default client still
  is not a daemon. The truthful model is a named, opt-in, bounded carve-out.
- **Use a Discord RPC npm package.** Rejected: breaks the zero-dependency
  invariant when DRPC already proves a small `node:net` implementation is enough.
- **Pretend all agents can be "same as Claude."** Rejected: false. Claude's
  ceiling comes from Claude-specific hooks/status surfaces; other agents only get
  what their own live surfaces expose.
- **Aggregate concurrent agents into one presence.** Rejected: Discord's single
  activity per `client_id` plus its two-line activity format means merging agents
  loses per-agent richness and cannot truthfully combine activity/tokens/cost.
  Last-active-wins (§5) shows one real current focus at full ceiling instead.
- **Redact project/cost by default on Discord.** Rejected for now: exposure is the
  user's responsibility on an opt-in public surface (§1); a per-field hide toggle
  remains an optional future convenience, not a mandatory default.
- **Register a dedicated token-tracker Discord app now.** Deferred: reusing the
  existing `claude-discord-rpc` app id (§3) ships presence with zero new
  registration; a dedicated app id is a later config swap, not architecture.
