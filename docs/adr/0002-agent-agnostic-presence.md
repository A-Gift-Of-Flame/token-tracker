# ADR 0002 — agent-agnostic Discord Rich Presence (opt-in presence daemon)

- **Status:** Accepted (amended 2026-06-16)
- **Date:** 2026-06-15
- **Backlog:** BL-140 (gates BL-142 → BL-144, all presence code), BL-147
  (amends arbitration, run model, and signal tiers)
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

## Amendment 2026-06-16 (BL-147)

BL-147 supersedes the original §5 last-active-wins arbitration and the original
"Aggregate concurrent agents" rejection. The physical Discord limit is unchanged:
there is still one activity per `client_id`. The truthful rendering model is now
**primary-headline + background-aggregate**: one real headline agent at its full
ceiling, plus a separately-labelled aggregate tail for the other live agents.

BL-147 also supersedes the Claude-only daemon framing. Presence is a single
opt-in multiplexing daemon/service mode that sees all live sources, tracks each
source independently, and renders the one Discord slot from that whole live set.

Finally, BL-147 adds layered signal tiers and closes the Cursor gap flagged in
the epic / ADR 0002 §2. Skills may contribute advisory heartbeats, but the
daemon owns Discord IPC; Cursor is recorded as session-end ceiling with
not-priced `$0` subscription cost.

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
| Cursor | **Session-end only** — final usage/project after shutdown where records exist; cost is not-priced `$0`. | Cursor is subscription-priced rather than per-token priced in token-tracker, and no truthful live surface is assumed. |

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
- **Daemon/service path:** a single opt-in presence daemon multiplexes all live
  sources at once. This is required because Discord exposes one activity per
  `client_id`, the headline+aggregate view needs every live source visible to one
  process, and per-agent daemons would fight over the one Discord IPC socket.
  Presence may be a second boot service or a flag/mode on the existing `tt watch`
  loop; the implementation choice is deferred.

The daemon carve-out inherits DRPC's proven model:

- **Auto-launch on watched source start:** a deterministic start signal such as
  DRPC's `SessionStart` hook may launch the single daemon/service, which detaches
  with ignored stdio and calls `unref()`, then exits so the watched agent is not
  blocked.
- **Per-source auto-clear when each watched agent dies:** every live source is
  tracked and cleared independently. One agent ending updates the
  headline/aggregate set without killing presence for the others. Shutdown is
  detected per source by three signals, in order of precision:
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
- **Concurrent agents → one Discord slot, primary-headline +
  background-aggregate.** Discord exposes a single activity per `client_id`. That
  physical limit is unchanged.

  The headline is the agent the user is steering. It is chosen by interactivity
  tier: hook-rich / interactive sources (for example Claude Code) rank above
  autonomous / background sources (for example a backgrounded Codex job).
  Tiebreak within a tier is most-recent activity.

  The background aggregate tail is a compact line summarizing the other live
  agents, for example `+N bg · $TOTAL · TOK`, where every number is a real sum,
  labelled as an aggregate of the background agents. Numbers are never attributed
  to the headline agent; no cross-attribution is allowed.

  Worked example:

  ```text
  Claude · tracker (CTO)
  +1 Codex bg · $6.10 · 1.4M tok
  ```

  Degradation rules are explicit: a solo agent renders headline only, with no
  tail. If N agents are live and none is interactive, the most-recent agent is the
  headline and the tail renders `+(N-1) bg`.

  This supersedes last-active-wins because the user's real workflow can have a
  steered foreground agent and truthful background work at the same time. The
  original objection to aggregation was that merging "cannot truthfully merge
  per-agent activity/tokens/cost." This model does not merge per-agent activity
  into a blended fiction: it shows one real headline at full ceiling plus a
  separately-labelled real aggregate. No number is faked or mis-attributed.
  Rejected only: blended presence that fuses agents into one implied session.
  Deferred: making the interactivity tier or an explicit headline override
  user-configurable.
- **Passive:** the daemon reads agent logs/status files only, never mutates
  source files, never writes prompts, never touches the model, and consumes zero
  model tokens.

The token-tracker implementation must preserve these properties. Anything that
outlives the watched agent, runs without user opt-in, or writes back into agent
state violates this ADR.

### 6. Signal tiers are layered; a skill is a signal, not the daemon.

A skill cannot be the integration. Skills are stateless / in-context and cannot
hold a persistent Discord IPC socket. The daemon owns Discord IPC.

A skill may be a thin cross-harness heartbeat emitter. For example, on session
start or turn it may run `tt presence signal --agent codex --project X`, writing
an inbox/signal file that the daemon consumes. This has low token overhead: one
instruction plus one shell call per session. It also works on any harness that
supports skills or agent-instructions, not only Claude.

That signal is advisory. It is model-discretion, less reliable than
deterministic hooks, and spends the user's model tokens. Presence must never
depend on it for a "live" claim because §1 truthfulness still binds.

Authoritative to advisory signal tiers:

`hooks (Claude) > skill-heartbeat (Codex / other harnesses with skills) > live-tail (file watch) > session-end`

A Claude-only skill/plugin wrapper is explicitly rejected as the integration. It
would re-couple presence to Claude like the deprecated `claude-discord-rpc`.
Presence stays agent-agnostic in `tt`; a skill is permitted only as a signal
source.

### 7. `claude-discord-rpc` is formally deprecated into token-tracker.

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
  exception to the no-background-daemon invariant. It may auto-launch only for
  watched active sources, must be single-instance guarded, and must clear each
  source independently when that source dies.
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
- Concurrent agents can now show a truthful foreground headline plus labelled
  background totals instead of hiding all background work.
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
- Concurrent agents still collapse to one Discord slot (§5); the aggregate tail
  is compact and intentionally less rich than the headline.
- Skill-heartbeat signals spend model tokens and are advisory only; hooks and
  source files remain more authoritative for live claims (§6).
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
- **Aggregate concurrent agents into one blended presence.** Rejected:
  Discord's single activity per `client_id` plus its two-line activity format
  cannot truthfully fuse multiple agents into one implied session. The labelled
  primary-headline + background-aggregate form is adopted in §5 because it keeps
  the headline real and labels background totals as aggregate values.
- **Claude-only skill/plugin wrapper as the integration.** Rejected: re-couples
  presence to Claude like the deprecated `claude-discord-rpc`. Skills may only be
  advisory heartbeat sources (§6); the daemon remains agent-agnostic in `tt`.
- **Redact project/cost by default on Discord.** Rejected for now: exposure is the
  user's responsibility on an opt-in public surface (§1); a per-field hide toggle
  remains an optional future convenience, not a mandatory default.
- **Register a dedicated token-tracker Discord app now.** Deferred: reusing the
  existing `claude-discord-rpc` app id (§3) ships presence with zero new
  registration; a dedicated app id is a later config swap, not architecture.
