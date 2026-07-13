# 1. Executive summary

## Verdict

Cognit’s **kernel is sound** for its intended product:

- local-first
- single-user
- SQLite
- append-only event log
- pure reducer
- CLI-first

The codebase already has unusually strong tests for a `0.0.0` monorepo. Core write/read loops (`init` → observation/decision → `continue` / `search` → `doctor`) work when the process cwd is the project root and the CLI dist was built with migrations.

**Production-quality within scope** is blocked not by missing multi-tenant architecture, but by a short list of **correctness, safety, and packaging defects**, plus a few **event-sourcing maturity** gaps that matter even for solo use.

## What “production-quality” means here

In scope:

| Requirement | Status today |
|-------------|--------------|
| Deterministic local memory | Mostly yes (kernel) |
| Documented CLI flags work | **No** (`--root` broken) |
| Install does not destroy user agent config | **No** (CLAUDE.md overwrite) |
| Optional local HTTP server is safe under local threat model | **Partial** (verify RCE surface) |
| Server/CLI bundles self-contained | **Partial** (CLI ok; server migrations missing) |
| Capture is honest about reliability | Partial (depends on AI compliance) |
| Long sessions remain usable | Partial (snapshot design good; I/O not) |

Out of scope (by product decision — **not defects**):

- Multi-user auth / multi-tenant SaaS
- Live multi-machine sync
- PostgreSQL / generic storage portability
- Full CQRS / Kafka / distributed bus

## Validated priorities

### Milestone 0 — Critical bug fixes (ship first)

1. **CLAUDE.md overwrite** on `init` / re-init — destroys existing project agent instructions.
2. **`POST /api/verify`** runs `sh -c` with full env, no auth — local RCE if process is reachable.
3. **`--root` / `COGNIT_ROOT`** documented but ignored on most write/read commands.
4. **Server migration packaging** — server dist cannot load SQL migrations; CLI already copies them.

### Milestone 1 — Reliability (architecture before product signals)

Order is intentional: **architecture gates first**, capture honesty last.

5. **Golden replay fixtures** — frozen event logs → expected state; every reducer-touching PR re-runs.
6. User redaction patterns wiring (Effect Layer override currently no-op).
7. Snapshot schema version + invalidation.
8. Snapshot path: tail SQL load + slim timeline in snapshots.
9. Capture signals in `doctor` / continue empty-state honesty (does not change ES architecture).

### Milestone 2 — DX & distribution

9. Exit-code contract.
10. Shell completion.
11. README/scope alignment (local-first honesty; five concepts vs internal ontology).
12. Publishable npm CLI (still local-first; not SaaS).

### Milestone 3 — Long-term (only when needed)

13. Non-identity payload transforms when a real breaking change appears.
14. FTS only if search over large corpora becomes a real pain.
15. **Reject** storage portability work unless product scope changes.

## Explicit rejections

| Hypothesis | Decision |
|------------|----------|
| Need Postgres abstraction “for ES purity” | **Reject** — SQLite is the product; core already storage-agnostic enough |
| Need multi-user auth for production | **Reject** — out of scope; document threat model instead |
| Ontology must be simplified immediately | **Defer (P2)** — hide internal surface is enough for now |
| Gravity dual-path is P0 | **Resolved (M3)** — single scorer in `@cognit/gravity` |
| Dead `packages/sdk` | **Resolved (M3)** — package deleted |

## Architecture stance

**Preserve:** event log as source of truth, pure reducer, WAL SQLite, local bind defaults, CLI as primary surface, small iterative PRs.

**Do not introduce:** microservices, distributed buses, forced CQRS layers, repository frameworks, Postgres “just in case.”

## Recommendation

M0–M2 shipped; M3 cleanup (gravity unify, sdk delete, payload evolution process) landed. Remaining M3 items (FTS, ontology freeze, real non-identity payload break) stay **on demand**.

**Do not rewrite Cognit.** Harden the kernel you already have.
