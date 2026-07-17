# 4. Detailed design docs

Each accepted change has a design under `designs/`. Implement **one design per PR series**. Do not implement until plan approval.

## Index

### Milestone 0

1. [D-M0-01 CLAUDE.md merge](./designs/D-M0-01-claude-md-merge.md)
2. [D-M0-02 Verify endpoint gate](./designs/D-M0-02-verify-endpoint-gate.md)
3. [D-M0-03 Root resolution](./designs/D-M0-03-root-resolution.md)
4. [D-M0-04 Migration packaging](./designs/D-M0-04-migration-packaging.md)

### Milestone 1 (order binding)

5. [D-M1-00 Golden replay](./designs/D-M1-00-golden-replay.md) — **first**
6. [D-M1-04 Redaction wiring](./designs/D-M1-04-redaction-wiring.md)
7. [D-M1-03 Snapshot schema version](./designs/D-M1-03-snapshot-schema-version.md)
8. [D-M1-02 Snapshot I/O](./designs/D-M1-02-snapshot-io.md)
9. [D-M1-01 Capture signals](./designs/D-M1-01-capture-signals.md) — **last**

### Milestone 2

9. [D-M2-01 Exit codes](./designs/D-M2-01-exit-codes.md)
10. [D-M2-02 Shell completion](./designs/D-M2-02-shell-completion.md)
11. [D-M2-03 Docs alignment](./designs/D-M2-03-docs-alignment.md)
12. [D-M2-04 npm package](./designs/D-M2-04-npm-package.md)

### Milestone 3

13. [D-M3-01 Payload evolution](./designs/D-M3-01-payload-evolution.md)

### Milestone 4

14. [D-M4-00 Inbox ingestion OOB](./designs/D-M4-00-inbox-ingestion-oob.md)

### Milestone 5

15. [D-M5-00 Semantic events](./designs/D-M5-00-semantic-events.md)

### Milestone 6

16. [D-M6-00 Dual store: raw_events + domain events (Option A)](./designs/D-M6-00-raw-events-store.md) — DB schema **1.4.0**, payload `CURRENT_VERSION` stays **1.3.0**; Timeline Summary \| Raw evidence; `cognit raw backfill`

## Design template (used by all)

Every design answers:

- Problem
- Current implementation
- Alternatives considered
- Chosen solution
- Migration strategy
- Risk
- Rollback strategy
- Tests required
