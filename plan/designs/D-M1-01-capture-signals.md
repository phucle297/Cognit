# D-M1-01 — Capture reliability signals

**Schedule:** **Last in M1.** Does not change event-sourcing architecture; must not jump ahead of D-M1-00…D-M1-02.

## Problem

Product value depends on AI tools calling Cognit verbs. That is intentional, not a bug — but users cannot see whether capture is happening. Empty memory looks like “product works” when it may mean “model never wrote.”

## Current implementation

- CLAUDE.md / hooks instruct models.
- Hooks land in inbox until `inbox --process|--watch`.
- `doctor` checks tree/db/hooks/server, not capture activity.
- `continue` has friendly empty onboarding.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| A. Force capture via always-on agent middleware | Higher fill rate | Out of scope / invasive |
| B. **Observability only** (doctor + continue) | Honest, small | Doesn’t increase capture |
| C. Background daemon required | Passive ingest | Against “no server required” |

## Chosen solution

**B — signals only:**

1. `doctor` adds rows:
   - events count (project)
   - last event age
   - active session event count
   - inbox pending file count / error count
   - optional: “no events in 7d while project active” warning
2. `continue` empty / sparse state:
   - if zero observations+decisions: tip to verify CLAUDE.md block / model compliance
3. No attempt to auto-call LLM.

## Migration strategy

- Additive CLI output. JSON doctor fields version carefully if `--json` exists.

## Risk

- Noise in doctor for brand-new projects. Mitigation: soft warnings, not hard fail.

## Rollback strategy

- Revert; remove rows.

## Tests required

- doctor JSON/text includes new fields in fixture project with N events.
- empty project warning severity correct.
