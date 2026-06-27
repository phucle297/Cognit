# OpenCode Plugins

OpenCode plugins are JS/TS modules loaded from `.opencode/plugins/`
(project) or `~/.config/opencode/plugins/` (global). Reference:
`https://opencode.ai/docs/plugins/`.

## How it works

```txt
OpenCode
   │
   │ tool.execute.after (handler args)
   ▼
cognit.ts plugin
   │
   │ atomic write (open wx → write → fsync → close → rename)
   ▼
.cognit/inbox/<session>-<ulid>.json
   │
   │ validate + persist + fold state
   ▼
cognit inbox --watch   →   SQLite   →   dashboard
```

## Install

```bash
mkdir -p ~/.cognit/hooks
cp hooks/opencode/cognit.ts ~/.cognit/hooks/cognit.ts
mkdir -p .opencode/plugins
ln -s ~/.cognit/hooks/cognit.ts .opencode/plugins/cognit.ts
```

Alternatively, list under `plugin` in `opencode.json` (`bun install`
runs at startup; external packages need a `package.json`).

## Hook

OpenCode invokes the plugin once on startup; the returned object
declares the lifecycle hooks we care about. Handlers are
`(input, output)`. Mutate `output.args` to alter the call; throw to
block. Use `client.app.log()` instead of `console.log`.

## Flow

| Host event            | Plugin handler           | Cognit envelope       |
|-----------------------|--------------------------|------------------------|
| `tool.execute.after`  | `tool.execute.after`     | `observation_recorded` |

The plugin runs in-process inside OpenCode (Bun / Node), so it
shares the `ulid` package the DB uses — no shelling out to a Node
helper. Follows the **Common behavior** algorithms in
[`docs/hooks/README.md`](./README.md#common-behavior).

`tool.execute.before` → `hypothesis_created` is deferred to Phase G
alongside the Claude Code / Codex / Gemini pre hooks.

## Payload

`observation_recorded` payload (`tool.execute.after`):

```json
{
  "text": "tool <input.tool> returned",
  "tool": "<input.tool>",
  "args": "<input.args>",
  "output": "<output>"
}
```

Canonical envelope (v1.2.0 FLAT — see [`docs/events.md`](../events.md)):

```json
{
  "version": "1.2.0",
  "type": "observation_recorded",
  "session_id": "01HXY...ULID",
  "actor_name": "opencode",
  "actor_type": "worker",
  "id": "01JXY...ULID",
  "source": { "tool": "opencode", "command": "tool.execute.after" },
  "payload": { "...": "..." }
}
```

## Source

Producer script: [`hooks/opencode/`](../../hooks/opencode/).
