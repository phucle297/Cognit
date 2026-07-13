# 8. Event-sourcing audit

Scope: local single-user SQLite. Grades: **strong / adequate / weak**.

---

## 1. Reducer purity

| | |
|--|--|
| **Current** | `packages/core/src/reducer.ts` — pure `applyEvent` / `reduce`; no I/O; defensive parse; unknown types → timeline only |
| **Strengths** | Total function; pure; unit-tested heavily |
| **Weaknesses** | Large switch; research ontology expands branches |
| **Improve** | Keep pure; freeze public event set; no rewrite |
| **Fix now?** | No |
| **Can wait?** | Yes |

---

## 2. Replay determinism

| | |
|--|--|
| **Current** | Sort by `(created_at ASC, id ASC)`; ULID tie-break; snapshots rehydrate Maps |
| **Strengths** | Explicit ordering; tests on reducer + integration |
| **Weaknesses** | Snapshot rehydrate is cast-based; timeline content must not depend on wall clock outside event fields |
| **Improve** | **Golden fixtures (D-M1-00)** as permanent gate; then snapshot version (M1-03); snapshot+tail vs full reduce |
| **Fix now?** | **M1-00 first** — before snapshot refactors |
| **Can wait?** | Not past start of M1 |

---

## 3. Event ordering guarantees

| | |
|--|--|
| **Current** | ULID ids; created_at ISO; single-writer-friendly SQLite |
| **Strengths** | Good enough for local CLI concurrency (WAL + busy_timeout) |
| **Weaknesses** | Multi-process writers can interleave; same-ms order relies on ULID |
| **Improve** | Document single-machine multi-process expectations; do not build distributed clocks |
| **Fix now?** | No |
| **Can wait?** | Yes |

---

## 4. Snapshot correctness

| | |
|--|--|
| **Current** | `SnapshotService` writes `state_json`; `_show` uses snapshot+tail; corrupt → full replay |
| **Strengths** | Right design; best-effort auto-snapshot on append (`everyN` default 100) |
| **Weaknesses** | Still loads all events for filter; `foldSession` full-replays; timeline bloat in state |
| **Improve** | M1-02, M1-03 |
| **Fix now?** | M1 (after M0) |
| **Can wait?** | Until sessions grow large |

---

## 5. Snapshot invalidation

| | |
|--|--|
| **Current** | JSON parse failure only; no schema version; no reducer-version stamp |
| **Strengths** | Safe fallback to full replay on parse error |
| **Weaknesses** | Silent partial wrongness if state shape drifts |
| **Improve** | Version field; unknown → ignore snapshot |
| **Fix now?** | M1-03 |
| **Can wait?** | Short-term if reducer freezes |

---

## 6. Snapshot schema evolution

| | |
|--|--|
| **Current** | Unversioned `SessionState` JSON; Map fields listed in `MAP_FIELDS` |
| **Strengths** | Deterministic key sort serialization |
| **Weaknesses** | Adding Map fields easy to forget; no migration of old snapshots |
| **Improve** | Envelope `{ schema_version, state }`; optional drop timeline from snapshot body |
| **Fix now?** | M1 |
| **Can wait?** | Partial — do before intentional SessionState breaks |

---

## 7. Event schema evolution

| | |
|--|--|
| **Current** | Per-type Effect Schemas; versions 1.0.0–1.2.0; `migratePayload` with **identity** transforms |
| **Strengths** | Registry + re-validate pattern is correct |
| **Weaknesses** | Never proven with real field rewrites; easy to think evolution is “done” |
| **Improve** | Keep; add golden fixtures when first non-identity lands (M3) |
| **Fix now?** | No |
| **Can wait?** | Yes until breaking payload change |

---

## 8. Migration strategy (DB + payload)

| | |
|--|--|
| **Current** | SQL migrations 1.0.0–1.3.0 transactional; payload transforms separate; recovery = wipe on incompatible DB (init messaging) |
| **Strengths** | Additive SQL; clear schema_version singleton |
| **Weaknesses** | No downgrade; packaging for server broken (M0-04); wipe is blunt |
| **Improve** | Package migrations; keep additive SQL; avoid wipe unless necessary |
| **Fix now?** | Packaging yes (M0); strategy OK |
| **Can wait?** | Downgrade never required for local tool |

---

## 9. Replay complexity

| | |
|--|--|
| **Current** | Intended O(tail) fold; actual O(n) load + O(n) snapshot size via timeline |
| **Strengths** | Fine for hundreds–thousands events/session |
| **Weaknesses** | Not fine for millions; no projection for continue |
| **Improve** | Tail SQL + slim snapshot (M1-02); no full CQRS |
| **Fix now?** | M1 |
| **Can wait?** | For tiny sessions yes |

---

## 10. Storage abstraction

| | |
|--|--|
| **Current** | `core` pure; `db` better-sqlite3 + raw SQL; drizzle unused |
| **Strengths** | Correct product coupling; no fake portability tax |
| **Weaknesses** | Reviewers may demand Postgres; resist |
| **Improve** | Delete unused drizzle later; do **not** add PG |
| **Fix now?** | No |
| **Can wait?** | Forever unless product changes |

---

## 11. Future SQLite scalability

| | |
|--|--|
| **Current** | WAL, busy_timeout 5s, indexes on hot paths |
| **Strengths** | Appropriate for local multi-process light concurrency |
| **Weaknesses** | Sync better-sqlite3 blocks event loop under heavy verify |
| **Improve** | Keep; optional longer busy_timeout via config if needed; avoid worker threads unless proven need |
| **Fix now?** | No |
| **Can wait?** | Yes |

---

## 12. Search architecture

| | |
|--|--|
| **Current** | In-process ranking + fuse.js on server; CLI search over session texts |
| **Strengths** | Simple, deterministic enough, no infra |
| **Weaknesses** | Not corpus IR; no FTS |
| **Improve** | Only add SQLite FTS5 when measured need |
| **Fix now?** | No |
| **Can wait?** | Yes |

---

## Golden replay (cross-cutting)

| | |
|--|--|
| **Current** | Missing as a product-level gate |
| **Required** | `fixtures/…/events` → `reduce` → `expected-state` on every reducer-touching PR |
| **Design** | [D-M1-00](./designs/D-M1-00-golden-replay.md) |
| **Fix now?** | First item of M1 |
| **Can wait?** | Must not wait until after snapshot I/O |

---

## ES summary

| Area | Grade | Milestone |
|------|-------|-----------|
| Reducer purity | strong | keep |
| Determinism | strong–adequate | **M1-00 golden gate** |
| Ordering | adequate | keep |
| Snapshot correctness | adequate design / weak I/O | M1-02 |
| Invalidation | weak | M1-03 |
| Snapshot evolution | weak | M1-03 |
| Event evolution | adequate plumbing | M3 on demand |
| Migrations | adequate + packaging bug | M0-04 |
| Replay complexity | weak at scale | M1-02 |
| Storage abstraction | intentionally coupled | do not change |
| SQLite scale | adequate | monitor |
| Search | adequate | defer FTS |
