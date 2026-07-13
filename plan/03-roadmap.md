# 3. Roadmap

Each milestone is **independently releasable**. Stop after any milestone and still have a better Cognit than before.

---

## Milestone 0 — Critical bug fixes

**Goal:** Nothing documented is silently wrong; local HTTP cannot casual-RCE; install does not vandalize user configs; server boots from dist.

| ID | Work | PR type |
|----|------|---------|
| D-M0-01 | CLAUDE.md merge / no clobber | `fix` |
| D-M0-02 | Verify endpoint gate + env scrub | `fix` / `security` |
| D-M0-03 | Unified `--root` / `COGNIT_ROOT` | `fix` |
| D-M0-04 | Server migration packaging | `fix` |

**Exit criteria**

- [ ] Re-init never deletes non-Cognit content in project agent instructions.
- [ ] HTTP verify cannot run shell unless explicitly enabled and bind is loopback.
- [ ] `cognit --root /path observation "…"` and `COGNIT_ROOT=/path cognit continue` work from any cwd.
- [ ] Server dist loads migrations without ENOENT.
- [ ] Regression tests for each fix; suite green.

**Release note angle:** “Correctness and safety for local single-user use.”

---

## Milestone 1 — Reliability

**Goal:** Months of solo use remain trustworthy; redaction works as documented; large sessions degrade gracefully.

| ID | Work | PR type |
|----|------|---------|
| D-M1-04 | Redaction wiring + modest pattern expansion | `fix` |
| D-M1-03 | Snapshot schema version + invalidation | `feat` (compat) |
| D-M1-02 | Snapshot tail query + slim timeline | `perf` / `fix` |
| D-M1-01 | Capture reliability signals | `feat` |

**Exit criteria**

- [ ] User `redaction.patterns` apply on append (integration test).
- [ ] Snapshots carry schema version; unknown → full replay.
- [ ] `_show` does not load all events when snapshot exists.
- [ ] `doctor` reports capture health basics.
- [ ] Snapshot+tail equals full reduce (determinism tests).

**Release note angle:** “Trust local memory under real workloads.”

---

## Milestone 2 — DX & distribution

**Goal:** Power users can install and script Cognit without monorepo archaeology.

| ID | Work | PR type |
|----|------|---------|
| D-M2-01 | Exit code contract | `fix` / `docs` |
| D-M2-03 | README + technical docs scope alignment | `docs` |
| D-M2-02 | Shell completion | `feat` |
| D-M2-04 | Publishable CLI package | `chore` / `feat` |

**Exit criteria**

- [ ] Documented exit codes; tests for 0/1/2 classes.
- [ ] README states single-user local scope clearly.
- [ ] `cognit completion fish|bash|zsh` works.
- [ ] Install path without full monorepo clone (or equivalent binary).

**Release note angle:** “Installable power-user tool.”

---

## Milestone 3 — Long-term (opportunistic)

| ID | Work | When |
|----|------|------|
| D-M3-01 | Non-identity payload transforms + golden fixtures | When a real breaking payload change is required |
| FTS5 | Only if search fails on real corpora | Deferred |
| Ontology freeze/delete | Product decision | Deferred |
| Gravity unify / delete sdk | Cleanup | Anytime low priority |

**Deliberately excluded:** PostgreSQL, multi-tenant auth, Kafka, CQRS rewrite, dashboard redesign.

---

## Suggested tags (after implementation)

| After | Tag sketch |
|-------|------------|
| M0 | `0.1.0` — correctness |
| M1 | `0.2.0` — reliability |
| M2 | `0.3.0` — DX / package |
