# D-M0-02 — Verify endpoint local safety

## Problem

`POST /api/verify` executes `sh -c <command>` with full `process.env` and no authentication (`apps/server/src/routes/verify.ts`). Combined with intentional no-auth local server, any client that can reach the process gets shell as the server user.

## Current implementation

- Server no-auth by design.
- Default bind `127.0.0.1`; Docker internal `0.0.0.0` without host publish (compose).
- CLI verification path is separate (argv spawn in packages/verification) — keep that.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| A. Full auth system | Strong | Out of product scope |
| B. Remove HTTP verify entirely | Safest | Breaks dashboard verify UX |
| C. **Disable by default + enable flag + loopback only + env scrub** | Fits local tool | Must document enable path |
| D. Allowlist of commands only | Safer | Too rigid for verify use case |

## Chosen solution

**C:**

1. **Default:** HTTP verify routes return `403` / structured error `verify_disabled` unless `COGNIT_ALLOW_HTTP_VERIFY=1` (or config key under server section if already present — prefer env for ops clarity).
2. **Refuse** enable when bind host is not loopback (`127.0.0.1`, `::1`, `localhost`).
3. **Env scrub:** pass only allowlisted env keys to child (`PATH`, `HOME`, `LANG`, `TERM`, `COGNIT_*` non-secret, maybe `NODE_ENV`). Never forward `*_API_KEY`, `OPENAI_*`, `SSH_*`, etc.
4. Prefer documenting CLI `cognit verification` as primary path.
5. Keep `sh -c` for HTTP only if enable flag set; longer-term (not this PR) argv JSON array body.

Do not add JWT/cookies.

## Migration strategy

- Breaking for anyone who used HTTP verify without env flag — acceptable; was unsafe. Document in release notes.
- CLI verify path unchanged.

## Risk

- Dashboard verify button breaks until enable documented. Mitigation: UI message + docs.

## Rollback strategy

- Revert; re-expose previous behavior (not recommended).

## Tests required

- Default boot: POST /api/verify → disabled error.
- With allow env + loopback: starts verification (existing tests adapted).
- With allow env + non-loopback bind: still refused.
- Child env does not contain a planted `OPENAI_API_KEY` fixture.
