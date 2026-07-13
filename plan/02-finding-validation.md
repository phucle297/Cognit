# 2. Finding validation table

Each review finding is treated as a **hypothesis**. Status is validated against the tree at review time (`2026-07-13`).

Legend:

- **Valid** — reproduces in code; fix accepted into roadmap
- **Partial** — direction right; severity or mechanism adjusted
- **Invalid** — incorrect, out of scope as a defect, or already fine
- **Scope limit** — true observation, but not a defect given product boundary

---

## P0 hypotheses

| Finding | Status | Severity | Evidence | Recommendation |
|---------|--------|----------|----------|----------------|
| **CLAUDE.md overwrite on init/re-init** | **Valid** | **P0 / Critical product** | `apps/cli/src/commands/init.ts:91-93,110-114` always `writeFile` full `CLAUDE_MD`. Re-init path refreshes even when config exists. Tests require overwrite. | Merge marked section or write sidecar; never clobber whole file. [D-M0-01](./designs/D-M0-01-claude-md-merge.md) |
| **`POST /api/verify` unauthenticated shell** | **Valid** | **P0 / Critical local safety** | `apps/server/src/routes/verify.ts:192-196` uses `["sh","-c",command]`, `env: process.env`, no auth. | Gate: require loopback + explicit enable (or disable HTTP verify by default); scrub env; prefer argv-array. [D-M0-02](./designs/D-M0-02-verify-endpoint-gate.md) |
| **`--root` / `COGNIT_ROOT` broken** | **Valid** | **P0 / High correctness** | Global `--root` on program; `init`/`doctor` use `optsWithGlobals()`; `continue`/`observation`/`decision` use `opts.root` only. Reproduced out-of-tree failure. | Central `resolveProjectRoot(command)`. [D-M0-03](./designs/D-M0-03-root-resolution.md) |
| **Server migration packaging broken** | **Valid** | **P0 / High packaging** | CLI has `copy-migrations`; server tsup does not. `migrations.ts` loads SQL via `import.meta.url`. `node apps/server/dist/index.js` → ENOENT. | Mirror CLI copy or inline SQL. [D-M0-04](./designs/D-M0-04-migration-packaging.md) |

---

## ES hygiene (promoted into M1)

| Finding | Status | Severity | Evidence | Recommendation |
|---------|--------|----------|----------|----------------|
| **No golden replay corpus** | **Valid (gap)** | **P1 architecture** | Reducer unit tests exist; no frozen `events → expected state` fixtures re-run as a gate | Add [D-M1-00](./designs/D-M1-00-golden-replay.md) **before** snapshot PRs |

---

## P1 hypotheses

| Finding | Status | Severity | Evidence | Recommendation |
|---------|--------|----------|----------|----------------|
| **Capture reliability (LLM must call CLI)** | **Partial / Scope-aware** | **P1 product honesty** | Design: CLAUDE.md verbs + optional hooks→inbox. Not a code bug; value is probabilistic. | Add **signals**, don’t invent compliance magic. [D-M1-01](./designs/D-M1-01-capture-signals.md) |
| **npm package / distribution friction** | **Valid** | **P1 distribution** | Private monorepo `0.0.0`; clone+build+link. | Publishable CLI after M0. [D-M2-04](./designs/D-M2-04-npm-package.md) |
| **README alignment / ontology divergence** | **Partial** | **P1 docs** | README five shapes vs internal research ontology; public CLI already hides many verbs. | Align docs; freeze visibility; no forced mass delete. [D-M2-03](./designs/D-M2-03-docs-alignment.md) |
| **Snapshot optimization (full SELECT \*)** | **Valid** | **P1 scale** | `_show` loads all events then filters tail (`session-service.ts:363-393`). `takeIfDue` loads all. | Tail query + slim timeline. [D-M1-02](./designs/D-M1-02-snapshot-io.md) |
| **Snapshot schema version** | **Valid** | **P1 ES maturity** | `state_json` unversioned; rehydrate hardcodes Map fields. Corrupt JSON → full replay (good). | Version envelope + invalidate. [D-M1-03](./designs/D-M1-03-snapshot-schema-version.md) |
| **Exit code contract** | **Partial** | **P1 DX** | Mix of 1/2; undocumented; commander missing-arg → 1. | Document + helpers. [D-M2-01](./designs/D-M2-01-exit-codes.md) |
| **Shell completion** | **Valid (gap)** | **P1 DX** | No completion generation found. | `cognit completion …`. [D-M2-02](./designs/D-M2-02-shell-completion.md) |
| **User redaction patterns not applied** | **Valid** | **P1 safety** | `Layer.provide(RedactorLiveWithDefault, redactionConfig)` — WithDefault already R=never → provide no-op (`live.ts:96-97`). | `Layer.provide(RedactorLive, redactionConfig)`. [D-M1-04](./designs/D-M1-04-redaction-wiring.md) |
| **Incomplete built-in redaction** | **Partial** | **P1 low-medium** | Built-ins miss bare `sk-`, `ghp_`, etc. | Expand carefully with tests. Bundle with M1-04. |
| **Artifacts unredacted + full child env** | **Partial** | **P1 local safety** | Server verify passes `process.env`; artifact logs raw stdout. | Scrub env in D-M0-02; optional artifact redaction later. |

---

## P2 hypotheses

| Finding | Status | Severity | Evidence | Recommendation |
|---------|--------|----------|----------|----------------|
| **Ontology simplification** | **Partial / can wait** | P2 | Large internal surface; public help already trimmed. | Prefer docs + visibility freeze over mass delete. |
| **Payload migration evolution unproven** | **Partial** | P2 | Identity transforms only; plumbing exists. | Non-identity when needed. [D-M3-01](./designs/D-M3-01-payload-evolution.md) |
| **FTS needed now** | **Invalid as urgent work** | P2 | fuse.js + ranking fine for solo corpora. | Defer until real pain. |
| **Storage portability (Postgres)** | **Invalid as work item** | — | Product = local SQLite; core pure enough. | **Do not implement.** |
| **No multi-user / no auth** | **Scope limit** | — | Explicit product decision. | Document threat model; harden loopback only. |
| **Dependency on CLAUDE.md** | **Scope limit + partial defect** | — | Compliance intentional; overwrite is the defect. | Fix overwrite only. |
| **Gravity dual implementation** | **Valid but defer** | P2 | Package zeros axes; server reimplements. | Unify later. |
| **Dead packages/sdk** | **Valid cleanup** | P2 | Unused stub. | Delete in cleanup PR. |
| **Dashboard dual trees / ConfigView** | **Partial** | P2 | Placeholders exist. | After CLI kernel. |
| **Server dashboard static path** | **Partial** | P2 | Monorepo-relative path. | Fix with packaging. |
| **Root Dockerfile stale paths** | **Valid** | P2 | `packages/cli` references. | Fix in M2 packaging. |
| **CONVENTIONS.md stale** | **Valid docs** | P2 | Layout outdated. | Docs milestone. |

---

## Severity ranking (accepted only)

1. CLAUDE.md clobber  
2. Verify shell gate  
3. `--root` resolution  
4. Migration packaging (server)  
5. **Golden replay fixtures**  
6. Redaction wiring  
7. Snapshot schema version  
8. Snapshot I/O + timeline slim  
9. Capture signals  
10. Exit codes  
11. Docs alignment  
12. Shell completion  
13. npm package  
14. Payload evolution (on demand)
