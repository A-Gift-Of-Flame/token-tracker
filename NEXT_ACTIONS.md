# NEXT_ACTIONS - Active Execution Queue

**Updated At:** 2026-06-20 (client state docs established; presence follow-ups queued)
**Execution Mode:** operating
**Max Items:** 10

## Active Work

- [BL-147] Multi-agent Discord presence — beyond slice 1.
  - **Owner:** unassigned.
  - **Next action:** make the headline interactivity tier / override
    user-configurable; wire the multiplexer into the live source set.
  - **Exit criteria:** concurrent agents arbitrate to one slot with a
    user-tunable headline; `node --test` green; truthfulness invariants held.

- [BL-152] `tt serve` dashboard event/ingest-driven update.
  - **Owner:** unassigned.
  - **Next action:** audit the current `POLL_MS` setInterval path in
    `src/server.js`; make the dashboard update when `sync()` ingests new records
    (in-process event → SSE), keep a slow poll only as fallback.
  - **Exit criteria:** dashboard refreshes on data landing, not just on the clock;
    no-daemon invariant held; `node --test` green.

## Blocked / Decision-Needed

- None.

## Queue Rules

- Keep this file short.
- List only active, open work.
- Remove completed items immediately.
- Every active item must reference a backlog ID like `[BL-101]`.
- Include owner, next action, and exit criteria when items exist.
