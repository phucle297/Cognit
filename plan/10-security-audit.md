# 10. Security audit (local tool threat model)

## Threat model (in scope)

**Assets:** local reasoning DB, artifacts, env secrets on machine.

**Attackers in scope:**

1. Mistaken operator (`--host 0.0.0.0`, published ports).  
2. Malicious local process / local webpage (same user).  
3. Accidental secret persistence in events/hooks.

**Out of scope:** remote multi-tenant attackers on a public Cognit SaaS (product does not exist).

---

## Findings (local-appropriate)

### 1. Verify endpoint shell — **Valid, fix M0**

- `POST /api/verify` → `sh -c` + full env + no auth.  
- **Mitigation:** default disable HTTP verify OR require `COGNIT_ALLOW_HTTP_VERIFY=1` + loopback-only bind; scrub env; prefer argv.  
- Do **not** add OAuth.

### 2. No auth — **Scope limit**

- Correct for local tool.  
- **Mitigation:** refuse non-loopback bind without explicit insecure flag; document never publish 6971.

### 3. CORS any localhost origin — **Partial**

- Any local page can call API if server listening.  
- **Mitigation (optional M1):** pin dashboard origin; not full auth.

### 4. Redaction incomplete / miswired — **Valid M1**

- Built-ins limited; user patterns likely no-op via Layer bug.  
- Fix wiring + expand common token shapes carefully.

### 5. Artifact logs + child env — **Partial**

- Fold env scrub into M0-02; artifact redaction optional later.

### 6. Hooks write raw tool I/O to inbox — **Accept with caveats**

- Local disk; redact on ingest (when wiring fixed).  
- Document that inbox may hold secrets until processed.

### 7. SQL injection — **Not found as issue**

- Parameterized queries in reviewed paths.

### 8. Path traversal artifacts — **OK**

- Content-addressed hashes.

---

## Recommended hardening only

| Item | Milestone | SaaS-style? |
|------|-----------|-------------|
| Gate verify shell | M0 | No |
| Loopback enforcement honesty | M0/docs | No |
| Redaction wiring | M1 | No |
| Optional origin pin | M1 optional | No |
| Non-root Docker user | M2 packaging | Hygiene only |

## Explicit non-goals

- JWT auth middleware  
- Multi-tenant isolation  
- Network ACLs product  
- Secret vault integration (optional later, not required)
