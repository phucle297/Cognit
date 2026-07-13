# 7. Things that should NOT be changed

These are intentional strengths. Do not “improve” them into a different product.

## Sacred kernel

| Decision | Why keep it |
|----------|-------------|
| **Append-only event log as source of truth** | Enables replay, audit, resume |
| **Pure reducer in `packages/core`** | Determinism, testability, storage independence of domain |
| **SQLite + WAL for local storage** | Correct for single-user local-first; zero ops |
| **Session-scoped state fold** | Matches investigation sessions |
| **CLI as primary write path** | Matches AI tool integration model |
| **No SaaS / no multi-tenant auth** | Scope boundary; simplifies threat model |
| **Loopback-default server** | Local dashboard without accounts |
| **ULID event ids + `(created_at, id)` order** | Stable deterministic order |
| **Inbox atomic write + processed/_error sidecars** | Robust external capture |
| **Redaction at append chokepoint** | Defense in depth for secrets |
| **Public CLI surface vs `--internal`** | Discoverability without deleting power features |
| **Auto-session on first write** | Reduces ceremony for AI callers |
| **Export/import tar for portability** | Multi-machine without live sync |

## Do not introduce

- Microservices or multi-process “platform”
- Kafka / NATS / distributed event bus
- PostgreSQL “abstraction layer” without product need
- Generic repository / Unit-of-Work frameworks
- Mandatory DI container beyond existing Effect layers
- Full CQRS with many projections “because ES textbooks”
- Cloud accounts, telemetry phone-home, forced online features
- Rewriting Effect out of `db` “for purity cosplay”
- Replacing reducer with mutable ORM entities

## Acceptable evolution (not rewrites)

- Add snapshot schema version field  
- Change SQL queries for tail loads  
- Add doctor signals  
- Expand redaction patterns  
- Publish CLI package  

These refine the existing architecture; they do not replace it.
