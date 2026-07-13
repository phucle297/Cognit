# 4. Detailed design docs

Each accepted change has a design under `designs/`. Implement **one design per PR series**. Do not implement until plan approval.

## Index

### Milestone 0

1. [D-M0-01 CLAUDE.md merge](./designs/D-M0-01-claude-md-merge.md)
2. [D-M0-02 Verify endpoint gate](./designs/D-M0-02-verify-endpoint-gate.md)
3. [D-M0-03 Root resolution](./designs/D-M0-03-root-resolution.md)
4. [D-M0-04 Migration packaging](./designs/D-M0-04-migration-packaging.md)

### Milestone 1

5. [D-M1-01 Capture signals](./designs/D-M1-01-capture-signals.md)
6. [D-M1-02 Snapshot I/O](./designs/D-M1-02-snapshot-io.md)
7. [D-M1-03 Snapshot schema version](./designs/D-M1-03-snapshot-schema-version.md)
8. [D-M1-04 Redaction wiring](./designs/D-M1-04-redaction-wiring.md)

### Milestone 2

9. [D-M2-01 Exit codes](./designs/D-M2-01-exit-codes.md)
10. [D-M2-02 Shell completion](./designs/D-M2-02-shell-completion.md)
11. [D-M2-03 Docs alignment](./designs/D-M2-03-docs-alignment.md)
12. [D-M2-04 npm package](./designs/D-M2-04-npm-package.md)

### Milestone 3

13. [D-M3-01 Payload evolution](./designs/D-M3-01-payload-evolution.md)

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
