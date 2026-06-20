# EVIDENCE LOG (public client)

Proof ledger for user-facing client claims. Each entry links an artifact or
command output to the specific claim it supports. Server-side evidence lives in the
private `token-tracker-server` repo.

## Entries

- ID: EV-2026-06-16-001
  File: docs/presence/bl-141-live-richness-audit.md
  Title: Per-agent live-richness audit
  Source/System: docs
  Action: read-only feasibility audit of 6 agents' presence ceilings
  Shows:
    - Claude Code = hook-rich; Codex/Gemini/OpenCode = live-tail; Copilot CLI / Cursor = session-end
  Proves:
    - presence richness ceilings are per-agent, not uniform (binds the truthfulness principle)
  Type: docs
  as_of: 2026-06-16

- ID: EV-2026-06-16-002
  File: null
  Title: Presence epic test suites green
  Source/System: test
  Action: ran `node --test` after presence slices (BL-142/143/144/147/148) and client mirror
  Shows:
    - presence engine, Claude daemon, live-tail sources, multiplexer, and service builders pass
  Proves:
    - presence is shipped and regression-covered in the client
  Type: integration
  as_of: 2026-06-16

## Entry Format

```yaml
- ID: EV-YYYY-MM-DD-NNN
  File: /absolute/path/to/artifact (or null)
  Title: short description
  Source/System: browser | api | test | log | screenshot | docs
  Action: what was done
  Shows:
    - visible fact 1
  Proves:
    - why the artifact matters
  Type: source-data | integration | docs | gap
  as_of: YYYY-MM-DD
  Notes: optional context
```
