# Scope & threat model

Cognit is a **single-user, local-first** memory engine for AI-assisted
engineering. This page defines what is in scope, what is deliberately
out of scope, and the security assumptions that follow.

## Product scope

| In scope | Out of scope |
|----------|--------------|
| One developer on one machine | Multi-tenant SaaS |
| Local SQLite under `.cognit/` | Required PostgreSQL / remote DB |
| CLI as primary write path | Mandatory cloud account / telemetry |
| Optional loopback dashboard + server | Multi-user auth / RBAC |
| Export/import tar for multi-machine | Live multi-machine sync / team sync |
| Hooks into local AI CLIs | Hosted agent platform |

**Multi-machine** means: run `cognit export` on machine A, copy the
archive, run `cognit import` on machine B. There is no background
replication and no shared team memory plane.

## Threat model (local tool)

Cognit is trusted code on your laptop, not a multi-user service.

| Assumption | Implication |
|------------|-------------|
| The OS user owns the project tree | File permissions, not Cognit ACLs, protect data |
| Server binds loopback by default | Not exposed to the LAN/WAN unless you reconfigure bind |
| No phone-home telemetry | Privacy = local filesystem policy |
| Secrets may appear in agent text | Redaction at append is defense-in-depth, not a vault |

Hardening work (verify endpoint gates, redaction patterns, exit codes)
targets **misconfiguration and accidents**, not remote attackers with
shell on your box.

## Public vs internal CLI

The **public** surface is the small set of verbs agents and humans type
daily (`init`, `observation`, `decision`, `verification`, `conclusion`,
`continue`, `search`, plus lifecycle helpers). Everything else is
available behind `cognit --internal` for power users and tooling.

Internal commands are not deleted; they are simply hidden from default
help so discovery stays small.

## Non-goals (do not re-open casually)

- Microservices or distributed event buses
- Forced Postgres abstraction layers
- Multi-tenant authentication
- Rewriting the pure reducer / append-only event log

See also: [architecture.md](./architecture.md), project plan
`plan/07-do-not-change.md`.
