# 6. Estimated effort

Scale:

- **S** — ≤ 1 day for one familiar engineer  
- **M** — 1–3 days  
- **L** — multi-day / multi-PR careful work  

| ID | Title | Effort | Notes |
|----|-------|--------|-------|
| D-M0-01 | CLAUDE.md merge | **S–M** | Careful file merge + tests; edge cases around markers |
| D-M0-02 | Verify endpoint gate | **M** | Behavior change + server tests + docs |
| D-M0-03 | Root resolution | **M** | Many command files; mechanical but must be complete |
| D-M0-04 | Migration packaging | **S** | Copy step + smoke boot test |
| D-M1-04 | Redaction wiring | **S–M** | Layer fix + integration test + optional patterns |
| D-M1-03 | Snapshot schema version | **M** | Serialize/rehydrate + invalidation tests |
| D-M1-02 | Snapshot I/O + timeline slim | **M–L** | Correctness-critical; equality vs full reduce |
| D-M1-01 | Capture signals | **M** | Doctor fields + continue messaging |
| D-M2-01 | Exit codes | **S–M** | Helpers + audit commands + docs |
| D-M2-02 | Shell completion | **S–M** | Commander completion or static generator |
| D-M2-03 | Docs alignment | **S** | README + technical scope page |
| D-M2-04 | npm package | **L** | Prebuilds, publish pipeline, install docs |
| D-M3-01 | Payload evolution | **M** when triggered | Only with a real schema change |

## Milestone totals (order of magnitude)

| Milestone | Effort |
|-----------|--------|
| M0 | **M** overall (≈ 1 week calendar if sequential; ~2–3 days if parallelized) |
| M1 | **M–L** (≈ 1–2 weeks careful ES work) |
| M2 | **M–L** (npm is the long pole) |
| M3 | On demand |

## Risk-adjusted note

Highest schedule risk is **D-M1-02** (easy to break determinism) and **D-M2-04** (native modules / publish). Everything in M0 is well-bounded.
