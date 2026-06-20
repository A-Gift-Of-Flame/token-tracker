# ACCEPTANCE FREEZES (public client)

Ledger of user-accepted, user-facing client milestones. A freeze records what the
user accepted, the runtime identity it was accepted against, and the regression
guard that protects it.

## Freezes

- ID: AF-2026-06-13-001
  Milestone: Subscription subsidy + zero-dep dashboard (BL-111)
  Accepted: 2026-06-13 by user
  Runtime identity: `node bin/tt.js subsidy` + `tt serve` localhost, this checkout
  Regression guard: subsidy test suite; dashboard render assertions
  Notes: stored cost stays metered; subsidy derived at report time

## Entry Format

```yaml
- ID: AF-YYYY-MM-DD-NNN
  Milestone: backlog id + short description
  Accepted: date + who
  Runtime identity: repo path / process / port the artifact was accepted against
  Regression guard: the test or check that protects it
  Notes: optional
```
