# Cognit production-quality plan (local-first scope)

**Status:** M0–M2 **implemented** on `main`; M3 opportunistic cleanup **landed**
(gravity unify, `packages/sdk` removed, D-M3-01 process docs + test-local
non-identity path). Production payload transforms remain identity until a
real wire break is required.  
**Date:** 2026-07-13 (status refresh 2026-07-13)  
**Tracker:** `Cognit-01f`  
**Scope:** Single-user, local SQLite, CLI-first memory engine. Not SaaS. Not multi-tenant.

This directory is the implementation roadmap derived from architecture review findings, **validated against the codebase**. Findings that did not hold up are rejected with evidence.

## How to use this plan

1. Read [01-executive-summary.md](./01-executive-summary.md).
2. Skim [02-finding-validation.md](./02-finding-validation.md) for accept/reject decisions.
3. Use [03-roadmap.md](./03-roadmap.md) for release milestones and current status.
4. Designs under [designs/](./designs/) describe the shipped or on-demand work.
5. Respect [07-do-not-change.md](./07-do-not-change.md) — preserve kernel strengths.

## Document index

| # | Document | Purpose |
|---|----------|---------|
| 01 | [Executive summary](./01-executive-summary.md) | Verdict, scope, priorities |
| 02 | [Finding validation table](./02-finding-validation.md) | Valid / partial / invalid for every hypothesis |
| 03 | [Roadmap](./03-roadmap.md) | M0–M3 independently releasable milestones |
| 04 | [Detailed designs index](./04-detailed-designs.md) | Pointers into `designs/*` |
| 05 | [Dependency graph](./05-dependency-graph.md) | Order and blockers |
| 06 | [Effort estimates](./06-effort-estimates.md) | S / M / L |
| 07 | [Do not change](./07-do-not-change.md) | Sacred architecture |
| 08 | [Event-sourcing audit](./08-event-sourcing-audit.md) | 12 ES dimensions |
| 09 | [Product / DX audit](./09-product-dx-audit.md) | CLI, install, hooks, doctor |
| 10 | [Security audit (local tool)](./10-security-audit.md) | Hardening within local threat model |

## Design docs (accepted work)

| ID | Milestone | Title |
|----|-----------|-------|
| [D-M0-01](./designs/D-M0-01-claude-md-merge.md) | M0 | CLAUDE.md merge / no clobber |
| [D-M0-02](./designs/D-M0-02-verify-endpoint-gate.md) | M0 | Verify endpoint local safety |
| [D-M0-03](./designs/D-M0-03-root-resolution.md) | M0 | `--root` / `COGNIT_ROOT` fix |
| [D-M0-04](./designs/D-M0-04-migration-packaging.md) | M0 | Server migration packaging |
| [D-M1-00](./designs/D-M1-00-golden-replay.md) | M1 | Golden replay fixtures (ES gate) |
| [D-M1-04](./designs/D-M1-04-redaction-wiring.md) | M1 | User redaction wiring fix |
| [D-M1-03](./designs/D-M1-03-snapshot-schema-version.md) | M1 | Snapshot schema version |
| [D-M1-02](./designs/D-M1-02-snapshot-io.md) | M1 | Snapshot tail I/O + timeline slim |
| [D-M1-01](./designs/D-M1-01-capture-signals.md) | M1 | Capture reliability signals |
| [D-M2-01](./designs/D-M2-01-exit-codes.md) | M2 | Exit code contract |
| [D-M2-02](./designs/D-M2-02-shell-completion.md) | M2 | Shell completion |
| [D-M2-03](./designs/D-M2-03-docs-alignment.md) | M2 | README / scope alignment |
| [D-M2-04](./designs/D-M2-04-npm-package.md) | M2 | Publishable CLI package |
| [D-M3-01](./designs/D-M3-01-payload-evolution.md) | M3 | Payload migration evolution (when needed) |

## Implementation rules (binding)

- Prefer **one design / one logical change** per PR series.
- Every PR: tests + docs + backwards compatibility + migration notes if needed.
- Never combine unrelated changes.
- Prefer iterative improvements over rewrites.
- Reject over-engineering: no microservices, Kafka, forced Postgres, generic repositories, DI sprawl.
- Do **not** invent a production payload version bump only to prove the migration runner ([D-M3-01](./designs/D-M3-01-payload-evolution.md)).

## Product boundary (non-negotiable)

Cognit is production-quality when:

- A single developer on one machine can trust memory write/read.
- Install and CLI flags work as documented.
- Local server cannot become casual RCE via misconfig.
- Event log remains source of truth; reducer stays pure.

Cognit is **not** incomplete because it lacks multi-user auth or Postgres.
