# D-M2-04 — Publishable CLI package

## Problem

Adoption requires cloning monorepo and building native modules.

## Chosen solution (minimal viable publish)

1. Publish `cognit` CLI package (name TBD) with `bin` → bundled dist.
2. Depend on `better-sqlite3` with prebuild support; document build-tools fallback.
3. Ship migration SQL inside package (from M0-04 patterns).
4. Keep monorepo private packages as workspace until publish script packs them (tsup already bundles `@cognit/*` into CLI).
5. Version from `0.1.0` after M0 lands.
6. Server/docker remain secondary.

**Non-goal:** multi-platform GUI installers, auto-updaters beyond `cognit update`.

## Migration strategy

- Existing git installs keep working.
- Publish is additive.

## Risk

- Native module pain on exotic platforms. Mitigation: document Node 22+ and supported OS list.

## Tests required

- Packed tarball install in clean temp dir smoke: `cognit init` + observation.
