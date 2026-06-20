---
repo_mode: operating
initialized_on: 2026-06-20
last_updated: 2026-06-20
---

# State Driven Development Template Contract

**Purpose:** Stable operating contract for technical projects that use explicit state, evidence, and short active queues.

**Repo scope:** This is the **public client** repo for token-tracker — the `tt`
CLI, local collectors, local dashboard (`tt serve`), and agent-agnostic Discord
presence. The opt-in hosted **cloud server** is a **separate private repo**
(`token-tracker-server`) and is out of scope here; never add server-internal
deploy/VPS/auth detail to this public repo.

This repository supports two modes:
- `bootstrap` for discovery and baseline creation
- `operating` for steady-state delivery

## Read Order

Coding agents should start every repo session by reading:
1. `AGENTS.md`
2. `STATUS.md`
3. `PROJECT_STATE.yaml`
4. `PROJECT_DNA.yaml`
5. `NEXT_ACTIONS.md`

Read `BACKLOG.md` and `WORKLOG.md` when planning or reviewing history.

## Universal Rules

These rules apply in all modes:
- no fake completeness
- no unverified claims presented as fact
- user-facing behavior requires direct verification
- user-facing acceptance requires runtime identity proof, not screenshots alone
- negative searches stay negative: use `not found`, `not currently locatable`, or `not proven`
- screenshots or evidence are required for user-visible changes
- active queue stays short
- history belongs in `WORKLOG.md`, not live state files
- structured state must remain machine-checkable
- end each implementation session with a handoff and hygiene check
- `README.md` is the primary user guide for the project
- never leak server internals into this public repo (VPS host/IP, deploy config,
  session secrets, server auth internals)

## Current Mode

This repo currently operates in: `operating`

State docs established 2026-06-20 as a bespoke client-only StateDD instance, split
out from the private server repo's shared state docs. Client history pre-dating the
split is summarized in `WORKLOG.md`.

## Bootstrap Mode

### When Bootstrap Mode Applies
Use bootstrap mode when:
- the repo is new
- state files do not yet exist
- project truth is unclear
- the user explicitly asks for initialization or re-baselining

### Bootstrap Goal
Establish a truthful operating baseline for the project, including filled state
files and a real backlog, and only then switch the repo to operating mode.

### Bootstrap Procedure
1. Investigate the host system and runtime
2. Investigate the repo structure and implementation reality
3. Ask the user only the minimum strategic questions needed
4. Use the CTO lane for brainstorming, research, contradiction resolution, architecture framing, and backlog shaping
5. Generate and fill the state and governance files truthfully
6. Mark unknowns honestly
7. Create the initial backlog and next-actions queue
8. Update this file to operating mode only when bootstrap is complete
9. Record bootstrap completion in `PROJECT_STATE.yaml` and `WORKLOG.md`

### Bootstrap Honesty Rules
If something is not proven, label it as:
- `observed`
- `unknown`
- `reported`
- `assumed`
- `blocked`
- `stale`
- `invalid`

Do not invent architecture or maturity.

## Operating Mode

### Operating Model
The repo runs in a human-in-the-loop workflow:
- CEO / human provides current state, requirements, priorities, and agent handoffs
- CTO / product-architecture lead reconstructs truth from user-relayed handoffs and pasted context, judges quality, chooses the next best move, and writes the next coding-agent prompt when appropriate
- coding agent implements one coherent step with verification and evidence, then ends with a final handoff for the CTO lane

The CTO role is handled by Claude Opus 4.8 in Claude Code.
Use `prompts/CTO_SESSION_PROMPT.md` as the startup prompt for that lane.
Assume the CTO lane does not have direct repo access unless the human pastes
state, screenshots, or other context into it.

Use the CTO lane for all non-trivial work. Non-trivial means any task involving
multiple files, architecture changes, user-facing behavior, integrations,
migrations, state-structure changes, or work likely to take more than one prompt.
Each non-trivial loop should normally start a fresh coding-agent session.

A valid CTO handoff should define the verified current state, one coherent scope,
required verification, and the exit condition for the implementation step. If
important context is not preserved in repo state files, the CTO prompt must
restate it explicitly for the next coding-agent session.
In operating mode, the scope should usually be a backlog slice or a very small
set of tightly related backlog items.

### CTO Review Standard
Every handoff must be reviewed for:
- contradictions
- overclaims
- missing proof
- brittle logic
- wrong sequencing
- architectural drift
- weak product prioritization

### Coding-Agent Standard
Implementation prompts must:
- name the coding agent (Codex via `codex exec --sandbox workspace-write "<prompt>"`)
- require reading `AGENTS.md` first
- anchor on current verified truth
- define one coherent scope
- forbid overclaiming
- require direct verification
- require runtime identity proof before accepting or investigating user-facing behavior
- require state and doc updates when truth changes
- require screenshots/evidence for user-facing work
- require the coding agent to end with one final handoff message suitable for pasting into the CTO lane
- require the coding agent, when starting in unclear bootstrap mode, to ask the minimum strategic questions needed before implementation

If the tool supports subagents or parallel workers and the task clearly benefits,
the CTO lane may encourage using them. This is optional guidance, not a baseline
workflow requirement.

## State Files

- `STATUS.md` = short human truth snapshot
- `PROJECT_STATE.yaml` = structured current truth
- `PROJECT_DNA.yaml` = stable architecture contract
- `PROJECT_ADAPTER.yaml` = optional project-specific vocabulary/runtime adapter
- `NEXT_ACTIONS.md` = active queue only
- `BACKLOG.md` = strategic roadmap with stable backlog IDs
- `WORKLOG.md` = append-only history
- `docs/EVIDENCE_LOG.md` = proof ledger
- `docs/ACCEPTANCE_FREEZES.md` = accepted user-facing milestone ledger

## Handoff Requirements

Every implementation session ends with:
- what changed
- what was directly verified
- repo path
- branch
- what remains partial or risky
- git head
- process or container serving the verified artifact
- port or endpoint used for verification
- whether the running artifact was rebuilt in this slice
- clean worktree status
- evidence references
- absolute file paths for evidence artifacts when available
- next recommended action
- handoff wording suitable for direct paste into the CTO chat

Use `prompts/FINAL_HANDOFF_TEMPLATE.md` when you need a canonical handoff shape.
Use `prompts/RUNTIME_IDENTITY_CHECKLIST.md` before UI acceptance or regression forensics.
Use `prompts/ACCEPTANCE_FREEZE_TEMPLATE.md` after accepting a user-facing milestone.

## Hygiene Rules

- `STATUS.md` <= 120 lines
- `PROJECT_STATE.yaml` <= 900 lines
- `NEXT_ACTIONS.md` active-only
- `BACKLOG.md` <= 260 lines; shipped detail moves to `WORKLOG.md`
- no roadmap prose in structured state
- no closed history in `STATUS.md`
- run `python3 scripts/check_state_docs.py` before every handoff
