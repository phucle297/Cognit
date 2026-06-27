# Hooks

External AI CLIs (Claude Code, Codex, OpenCode, Gemini CLI, …) publish events
to Cognit by writing atomic JSON files into `.cognit/inbox/`. The watcher
processes them, validates against the runtime schema, and moves them to
`processed/` or `_error/`. The atomic-write protocol, envelope shape, and
provider-specific setup live in the per-provider reference under
[`docs/hooks/README.md`](./hooks/README.md) and the linked provider pages
([claude-code](./hooks/claude-code.md), [codex](./hooks/codex.md),
[opencode](./hooks/opencode.md), [gemini-cli](./hooks/gemini-cli.md)).

**Source of truth.** Reference producer scripts live at the repo-root
`hooks/` directory (this page lives in `docs/hooks/`, which is the
documentation tree only). Install commands in the provider pages point
to `hooks/<provider>/...` paths, not `docs/hooks/<provider>/...`.