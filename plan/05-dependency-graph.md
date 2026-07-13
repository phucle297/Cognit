# 5. Dependency graph

## Visual order

```text
M0 (parallelizable after approval)
├── D-M0-01 CLAUDE.md merge          ── independent
├── D-M0-02 verify endpoint gate     ── independent
├── D-M0-03 root resolution          ── independent (touches many CLI files)
└── D-M0-04 migration packaging      ── independent

M1 (strict order — architecture before capture)
├── D-M1-00 golden replay            ── FIRST; gates all later M1 ES work
├── D-M1-04 redaction wiring         ── after goldens exist (does not mutate reducer)
├── D-M1-03 snapshot schema version  ── AFTER goldens; before I/O rewrite
├── D-M1-02 snapshot I/O + timeline  ── AFTER D-M1-03; MUST keep goldens green
└── D-M1-01 capture signals          ── LAST; product-only, no ES architecture change

M2
├── D-M2-01 exit codes               ── better AFTER D-M0-03 (shared CLI plumbing)
├── D-M2-03 docs alignment           ── independent; can start anytime after M0
├── D-M2-02 shell completion         ── AFTER D-M0-03 (root flags must work)
└── D-M2-04 npm package              ── AFTER D-M0-04 (bundle correctness)

M3
└── D-M3-01 payload evolution        ── only when needed; no hard dep
```

## Hard blockers

| Task | Blocked by | Why |
|------|------------|-----|
| D-M1-04 / D-M1-03 / D-M1-02 | D-M1-00 golden replay | ES mutations need a frozen compare gate |
| D-M1-02 snapshot I/O | D-M1-03 + D-M1-00 | Version format first; goldens prove entity equality after slim timeline |
| D-M1-01 capture signals | none hard (prefer after ES M1) | Does not change architecture; schedule last |
| D-M2-02 completion | D-M0-03 | Completing `--root` before teaching shells bad flags |
| D-M2-04 npm package | D-M0-04 | Publishing broken server/cli packaging multiplies damage |
| D-M2-01 exit codes | D-M0-03 (soft) | Root failures must map to consistent codes |

## Soft / preferred order

1. Land all M0 before any M1 (release train).
2. Within M0: no order required; **prefer D-M0-03 early** if parallel capacity is low (unblocks testing other CLI fixes out-of-tree).
3. Within M1 (strict): golden replay → redaction → snapshot version → snapshot I/O → capture signals.
4. Do not parallelize D-M1-02 with D-M1-03.
5. Capture (D-M1-01) must not jump ahead of snapshot work — it is UX only.
6. M2 docs can start in parallel with M1 if staffing allows (no code conflict).

## What does NOT block

- Ontology simplification does not block any milestone.
- FTS does not block.
- Postgres port does not exist as work.
- Dashboard polish does not block CLI production quality.
