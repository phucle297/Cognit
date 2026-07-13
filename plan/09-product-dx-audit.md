# 9. Product / DX audit

Product boundary: local-first single-user CLI memory for AI assistants.

---

## CLI UX

| Aspect | Assessment | Action |
|--------|------------|--------|
| Public surface | Good — curated help + `--internal` | Keep |
| Dual names (`observe` vs `observation`) | Confusing for humans; OK for AI | Document aliases; no forced rename now |
| Help text | Generally clear | Keep improving per command |
| Discoverability | Public set OK; power features hidden | OK |
| `--root` | **Broken** | M0-03 |
| `--json` | Good for AI | Keep |
| Exit codes | Inconsistent | M2-01 |
| Completion | Missing | M2-02 |

---

## Installation

| Aspect | Assessment | Action |
|--------|------------|--------|
| Clone + pnpm + build + link | Works; high friction | M2-04 |
| Node 22+ | OK for 2026 tool | Document |
| better-sqlite3 native | Host install required | Keep; document; prebuilds later |
| `scripts/up.sh` vs README link | Divergent | Align docs M2-03 |
| Docker compose | Server path better than root Dockerfile | Fix stale paths in M2 packaging |

---

## Documentation

| Aspect | Assessment | Action |
|--------|------------|--------|
| README product pitch | Clear five concepts | Keep pitch |
| README vs internal ontology | Divergence | M2-03 honesty |
| Technical docs | Strong under `docs/technical/` | Keep current |
| CONVENTIONS.md | Stale layout | Fix opportunistically |
| Scope (single-user) | Understated risks of multi-user misuse | Security + README M2 |

---

## First-run experience

| Step | Status | Action |
|------|--------|--------|
| `cognit init` | Works | Fix CLAUDE.md M0-01 |
| Auto hooks | Works when tools present | Keep |
| First observation | Works in cwd | M0-03 for out-of-tree |
| `continue` empty | Friendly onboarding text | Enhance with capture tips M1-01 |
| `doctor` | Excellent baseline | Extend M1-01 |

---

## Hooks & inbox

| Aspect | Assessment | Action |
|--------|------------|--------|
| Atomic inbox write | Strong | Keep |
| Passive ≠ durable without process | Documented | Keep honesty; doctor backlog count |
| Hook content quality | Tool noise vs cognition | Don’t pretend hooks replace decisions |
| Global settings mutation | Acceptable for local tools | Keep idempotent installer |

---

## Doctor

Strength: structured checks, skip/ok/fail.  
Gap: no capture rate / last event age / inbox depth. → M1-01.

---

## Continue

Strength: ranked memories, trust markers, tests.  
Gap: uses `sessions.show` (snapshot path) — good; depends on root resolution; empty state should nudge capture. → M0-03 + M1-01.

---

## Product conclusions

1. DX is **AI-cwd-first** today; make it **flag-honest** (root) and **scriptable** (exit codes).  
2. Do not redesign capture around guaranteed compliance — make honesty + doctor the product.  
3. Installation is the main adoption wall after correctness bugs.
