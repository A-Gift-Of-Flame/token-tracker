# BL-141 live-richness audit

Date: 2026-06-16

Scope: read-only feasibility audit for per-agent Discord Rich Presence ceilings.
No collectors, presence adapters, engine, renderer, or tests were modified.

Evidence labels:

- host-verified: confirmed from read-only source files on this host.
- code-derived: confirmed from collector or presence-source code in this repo.
- prior-verified: carried from already-shipped BL-142/143 evidence for Claude Code.
- not proven: not confirmed from available source/code evidence.

## Summary matrix

| Agent | Activity | Model | Tokens | Cost | Project | Write timing | Verified ceiling |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | host/prior-verified live hook-rich: tool/thinking/responding from transcript content | host/prior-verified live | host/prior-verified live totals | code-derived live estimated API cost | host/prior-verified live | Hook launch plus transcript tail; daemon polls every 1s | `hook-rich` |
| Codex | host-verified live-tail raw events: `response_item:function_call` and `reasoning`; current collector does not emit activity | host-verified live-tail via `turn_context` | host-verified live-tail after each completed turn via `token_count` | code-derived live-tail estimated from token-tracker pricing | host-verified live-tail raw `cwd`; current collector does not emit project | Append-only JSONL complete-line tail; byte-offset reusable | `live-tail` |
| Gemini CLI | not proven as current activity; only completed response/thought line is present | host-verified live-tail per completed turn | host-verified live-tail per completed turn | code-derived live-tail estimated from token-tracker pricing | code-derived live-tail from session path | Append-only JSONL complete-line tail; byte-offset reusable | `live-tail` |
| OpenCode | host-verified live-tail via `part`/`event` rows (`step-start`, `reasoning`, `tool`, `step-finish`) | host-verified live-tail assistant rows | host-verified live-tail assistant rows / step-finish parts | host-verified source has `cost`; collector-derived pricing estimate also possible | host-verified live-tail from message path/session directory; current collector does not emit project | SQLite cursor by `time_created`; rows appear per message/part, not only session end | `live-tail` |
| Copilot CLI | host-verified partial live turn events, but usage-rich state only at shutdown | host-verified live plus shutdown final | host-verified full counts only at `session.shutdown` | code-derived session-end estimated from token-tracker pricing | host-verified live from `session.start` | Event JSONL has live events, but usable full metrics are shutdown-only | `session-end` |
| Cursor | not found as live activity | host-verified from assistant blob, effectively session snapshot | host-verified session snapshot: context-window input only; output not stored | host/code-verified not-priced subscription `$0`, not API cost | host-verified from root blob project URL | SQLite `store.db`; usable context-token snapshot is not proven live and collector treats one record per agentId | `session-end` |

## ADR 0002 §2 result

- Claude Code: confirms ADR 0002 §2 "Full" endpoint; normalized audit label is `hook-rich`.
- Codex: confirms ADR 0002 §2 `live log-tail` ceiling. Caveat: current collector usage projection omits activity and project even though raw rollout lines expose both.
- Gemini CLI: confirms ADR 0002 §2 `live log-tail` ceiling for model/tokens/cost/project. Activity remains not proven beyond completed response lines.
- OpenCode: confirms ADR 0002 §2 `live log-tail` ceiling. Caveat: current collector omits project and activity even though the DB has path/session and part/event rows.
- Copilot CLI: confirms ADR 0002 §2 `session-end only` ceiling for full usage/cost.
- Cursor: ADR 0002 §2 has no Cursor row. Audit adds Cursor as `session-end`; if ADR 0002 is revised, add a Cursor row stating `session-end`, output tokens not locally stored, cost not-priced subscription `$0`.

No ADR 0002 §2 row was silently rewritten in this slice. The only flagged ADR correction is the missing Cursor row.

## Claude Code

Status: prior-verified/completeness row only. Claude Code was shipped in BL-143 at the hook-rich ceiling and was not re-derived here.

Evidence:

- `src/presence/claude-source.js:78-91` derives activity from transcript content (`tool_use`, `thinking`, `text`).
- `src/presence/claude-source.js:119-143` accumulates model, usage totals, and estimated cost from assistant transcript entries.
- `src/presence/claude-source.js:146-183` emits status, project, model, activity, tokens, estimated cost, timestamps, and missing markers.
- `src/presence/claude-source.js:193-221` polls the transcript source every 1s and emits changed states.

Per-field extractability:

- Activity: live hook-rich, prior-verified.
- Model: live hook-rich, prior-verified.
- Tokens: live hook-rich, prior-verified.
- Cost: live estimated, code-derived via `costFor`; not exact.
- Project: live hook-rich from transcript `cwd`, prior-verified.

Write timing:

- Hook-driven daemon starts from Claude SessionStart and tails transcript writes. This is not merely a collector sync path.

Verified ceiling:

- `hook-rich`.
- Confirms ADR 0002 §2 "Full" endpoint using the normalized audit term `hook-rich`.

Reuse note for BL-144:

- Already shipped in BL-143. No BL-144 adapter work needed except arbitration with other sources.

## Codex

Source surface: `~/.codex/sessions/**/*.jsonl`.

Code evidence:

- `src/collectors/codex.js:3-8` documents append-only rollout files and `token_count` usage events.
- `src/collectors/codex.js:16-18` locates `~/.codex/sessions`.
- `src/collectors/codex.js:38-52` uses file byte offsets and consumes only complete lines.
- `src/collectors/codex.js:58-64` tracks model from `turn_context`/`session_meta` and reads `payload.info.last_token_usage` from `token_count`.
- `src/collectors/codex.js:66-77` emits token counts but no project/activity fields.
- `src/collectors/index.js:25-34` prices collector records through `costFor`.

Host evidence:

- Host sample file: `/home/agiftofflame/.codex/sessions/2026/06/16/rollout-2026-06-16T00-32-46-019ecd6a-72e9-7ce0-bf7c-4a86f7b35c47.jsonl`.
- Host-verified usage/model: line 5 has `turn_context` model `gpt-5.5`; lines 16, 27, 38, 50, 61, and 73 have `event_msg`/`token_count` with `input`, `output`, `cached`, and sometimes `reasoning` usage.
- Host-verified project/activity raw fields: line 1 `session_meta` and line 5 `turn_context` include `cwd`; lines 10-12 and many later lines are `response_item:function_call` with `name:"exec_command"`; reasoning lines are also present.
- Host-verified timing: the same rollout had 148 complete lines and the sampled `token_count` at line 141 was followed by 7 more complete lines, proving usable usage lines appear before file end in a still-appendable rollout. This does not prove sub-token streaming; it proves per-completed-turn live-tail.

Per-field extractability:

- Activity: host-verified live-tail from raw `response_item:function_call` names and `response_item:reasoning`. Current collector does not emit it.
- Model: host-verified live-tail from `turn_context.payload.model`.
- Tokens: host-verified live-tail at completed-turn granularity from `payload.info.last_token_usage`.
- Cost: code-derived live-tail estimated metered cost from token-tracker pricing after each token_count record; not exact source cost.
- Project: host-verified live-tail raw `cwd` in `session_meta`/`turn_context`. Current collector does not emit it.

Write timing:

- Append-only JSONL, complete-line, byte-offset tail. Usable token usage arrives per completed turn as `token_count`, not session-end-only.

Verified ceiling:

- `live-tail`.
- Confirms ADR 0002 §2 `live log-tail`. The implementation note is that BL-144 must parse more than the current collector record projection to include activity/project.

Reuse note for BL-144:

- Reuse the byte-offset complete-line tail and token/model parse. Extend the raw rollout parser for `cwd`, `response_item:function_call`, and reasoning/activity events.

## Gemini CLI

Source surface: `~/.gemini/{tmp,history}/*/chats/session-*.jsonl`.

Code evidence:

- `src/collectors/gemini-cli.js:3-10` documents per-turn `type:"gemini"` usage and the available token fields.
- `src/collectors/gemini-cli.js:18-35` scans `tmp` and `history` chat session JSONL files.
- `src/collectors/gemini-cli.js:37-54` parses `type:"gemini"`, model, and token usage.
- `src/collectors/gemini-cli.js:57-83` uses byte offsets, complete-line reads, and project from the path.
- `src/collectors/index.js:25-34` prices collector records through `costFor`.

Host evidence:

- Host sample files exist under `/home/agiftofflame/.gemini/tmp/*/chats/session-*.jsonl`.
- Host-verified usage rows:
  - `/home/agiftofflame/.gemini/tmp/tmp/chats/session-2026-06-13T21-40-f33c2ca1.jsonl` line 5: `type:"gemini"`, model `gemini-3-flash-preview`, tokens `{input:13066, output:3, cached:11875, thoughts:330, tool:0, total:13399}`.
  - `/home/agiftofflame/.gemini/tmp/tmp/chats/session-2026-06-13T21-39-4292eaae.jsonl` line 5: `type:"gemini"`, model `gemini-3-flash-preview`, tokens `{input:13065, output:2, cached:0, thoughts:40, tool:0, total:13107}`.
- Host-verified timing: each sampled session file had a user line, then the `type:"gemini"` usage line, then one metadata/update line. This proves per-turn completed-response writes, not session-end-only.
- Host-verified activity limitation: sampled line keys are `id`, `timestamp`, `type`, `content`, `thoughts`, `tokens`, and `model`; no tool name or current turn-boundary signal was found in the sampled `gemini` usage line.

Per-field extractability:

- Activity: not proven as current live activity. A completed response/thoughts line exists after the turn, but no tool name/current action signal was found.
- Model: host-verified live-tail per completed turn.
- Tokens: host-verified live-tail per completed turn.
- Cost: code-derived live-tail estimated metered cost from token-tracker pricing; not exact source cost.
- Project: code-derived live-tail from the session path project component.

Write timing:

- Append-only JSONL, complete-line, byte-offset tail. Usable model/tokens appear per completed turn, not only at session shutdown.

Verified ceiling:

- `live-tail`.
- Confirms ADR 0002 §2 `live log-tail` for model/tokens/cost/project. Activity remains lower than Claude/Codex/OpenCode.

Reuse note for BL-144:

- Reuse existing `sessionFiles`, byte-offset logic, and `parseLine` for model/tokens/project. Do not invent tool/activity names unless a later format sample proves them.

## OpenCode

Source surface: `~/.local/share/opencode/opencode.db` through `node:sqlite`.

Code evidence:

- `src/collectors/opencode.js:3-6` documents assistant message rows and token shape.
- `src/collectors/opencode.js:22-26` opens the DB read-only and queries `message` rows by `time_created > ?`.
- `src/collectors/opencode.js:31-45` emits assistant message model/provider/tokens; current collector does not emit project/activity.
- `src/collectors/index.js:25-34` prices collector records through `costFor`.

Host evidence:

- Host DB: `/home/agiftofflame/.local/share/opencode/opencode.db`.
- Host-verified schema has `message`, `part`, `event`, `session`, and `project` tables.
- Host-verified assistant rows in session `ses_152b03907ffetr4IGrUdd3y9iC` contain repeated token-bearing assistant messages with `time_created`/`time.completed`, model `qwen3-8b-12gb`, provider `ollama`, and path `/home/agiftofflame/projects/learning/cisco_ccna`.
- Host-verified session rows carry `directory`, `path`, `model`, `cost`, and aggregate token columns.
- Host-verified `part` rows carry live activity-ish records: `step-start`, `reasoning`, `tool` with tool `bash`, and `step-finish` with `tokens`/`cost`.
- Host-verified timing: multiple token-bearing assistant rows exist within one session with increasing `time_created`, and subsequent part/message rows follow. This is per-message/part DB writing, not a single shutdown summary.

Per-field extractability:

- Activity: host-verified live-tail from `part`/`event` rows (`step-start`, `reasoning`, `tool`, `step-finish`).
- Model: host-verified live-tail from assistant message rows and session rows.
- Tokens: host-verified live-tail from assistant message rows and `step-finish` parts.
- Cost: host-verified source rows have `cost`; current collector also supports code-derived estimated pricing through token-tracker. For local providers such as `ollama`, cost is exact `$0`; for hosted providers, BL-144 should prefer source `cost` only if its semantics are confirmed, otherwise label token-tracker pricing as estimated.
- Project: host-verified live-tail from assistant `path.cwd` and session `directory`/`path`. Current collector does not emit it.

Write timing:

- SQLite rows are inserted/updated per message/part with `time_created` cursors. Usable rows are not session-end-only.

Verified ceiling:

- `live-tail`.
- Confirms ADR 0002 §2 `live log-tail`. OpenCode can be richer than the current collector projection if BL-144 reads `part`/`event`/`session` in addition to `message`.

Reuse note for BL-144:

- Reuse the DB open and `time_created` cursor idea, but use a broader read path than the current collector: `part`/`event` for activity and `session` or message `path.cwd` for project.

## Copilot CLI

Source surface: `~/.copilot/session-state/*/events.jsonl`.

Code evidence:

- `src/collectors/copilot-cli.js:3-13` documents `session.shutdown` as the event carrying full per-model token counts and notes sessions without shutdown are skipped/retried.
- `src/collectors/copilot-cli.js:47-55` records `session.start` cwd but returns `null` when no shutdown event exists.
- `src/collectors/copilot-cli.js:73-94` emits one record per model from shutdown `modelMetrics`.
- `src/collectors/index.js:25-34` prices collector records through `costFor`.

Host evidence:

- Host sample file: `/home/agiftofflame/.copilot/session-state/48a49b21-194e-4130-b1ad-d731e23dbecd/events.jsonl`.
- Host-verified live event rows: line 1 `session.start` with `cwd:"/tmp"`; line 2 `session.model_change` with `newModel:"claude-haiku-4.5"`; line 5 `assistant.turn_start`; line 6 `assistant.message` with model and `outputTokens`; line 7 `assistant.turn_end`.
- Host-verified shutdown row: line 8 `session.shutdown` contains `modelMetrics.claude-haiku-4.5.usage` with `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens`.

Per-field extractability:

- Activity: host-verified partial live turn events exist, but this is not sufficient for usage-rich presence.
- Model: host-verified live from `session.model_change`/`assistant.message`, with final model at shutdown.
- Tokens: host-verified full usage only at `session.shutdown`. `assistant.message.outputTokens` is partial and does not include full input/cache usage.
- Cost: code-derived estimated metered cost only after shutdown metrics are available; source has no exact dollar cost in the collector path.
- Project: host-verified live from `session.start.context.cwd`.

Write timing:

- The JSONL event stream is live for turn/model/project events, but the collector's usable full model metrics are shutdown-only. Sessions without shutdown are intentionally skipped and retried.

Verified ceiling:

- `session-end`.
- Confirms ADR 0002 §2 `session-end only` for full usage/cost. A future presence source may show a modest active/stale Copilot shell from turn events, but it must not present tokens/cost as live.

Reuse note for BL-144:

- Reuse `parseSession` for final summaries. A live presence adapter would need a separate event-tail path for turn/model/project, and must gate tokens/cost until `session.shutdown`.

## Cursor

Source surface: `~/.cursor/chats/<chatId>/<agentId>/store.db`.

Code evidence:

- `src/collectors/cursor.js:3-23` documents Cursor's two-table DB, context-window input token proxy, missing output tokens, model source, project source, and subscription cost behavior.
- `src/collectors/cursor.js:66-79` extracts context-window tokens and project URL from the root protobuf blob.
- `src/collectors/cursor.js:101-145` reads `meta`, `latestRootBlobId`, root blob, assistant JSON blobs for model, and returns a session snapshot.
- `src/collectors/cursor.js:149-180` emits one record per `agentId`, with provider `cursor`, `input=contextTokens`, `output=0`, and optional project.

Host evidence:

- Host DB: `/home/agiftofflame/.cursor/chats/d42b9c57d24cf5db3bd8d332dc35437f/d36205ea-a78b-40af-bc3e-4b1356173fea/store.db`.
- Host-verified schema through read-only immutable SQLite URI: tables `blobs (id TEXT PRIMARY KEY, data BLOB)` and `meta (key TEXT PRIMARY KEY, value TEXT)`.
- Host-verified `meta` row decodes to `agentId:"d36205ea-a78b-40af-bc3e-4b1356173fea"`, `latestRootBlobId`, `createdAt:1781386747699`, and `isRunEverything:true`.
- Host-verified collector parse over the immutable URI returned model `composer-2.5-fast`, context tokens `15531`, project `tmp`, and timestamp `2026-06-13T21:39:07.699Z`.
- Host-verified assistant JSON blob contains `providerOptions.cursor.modelName:"composer-2.5-fast"`.
- Host sidecar `meta.json` says `hasConversation:true`, `createdAtMs:1781386747699`, and `updatedAtMs:1781386754875`.

Per-field extractability:

- Activity: not found. No current tool/turn activity field was found in the collector path or host metadata inspected for this audit.
- Model: host-verified from assistant JSON blobs, effectively a session snapshot.
- Tokens: host-verified context-window input snapshot only. Output tokens are not stored locally.
- Cost: host/code-verified not-priced subscription `$0` (`provider:"cursor"` is not in LiteLLM; `priced=false`). This is not exact API cost.
- Project: host-verified from root blob project URL.

Write timing:

- The DB and `meta.json` have update timestamps, but usable context-token richness is not proven as a mid-session live stream. The collector is one-record-per-agentId and code comments call the context token count "the context size at session end."

Verified ceiling:

- `session-end`.
- ADR 0002 §2 had no Cursor row. This audit adds Cursor as session-end/not-priced, not a live-tail target.

Reuse note for BL-144:

- Do not put Cursor in the initial live-tail set. If Cursor presence is added later, reuse `parseSession` for a final/stale snapshot only unless a live Cursor write surface is separately proven.

