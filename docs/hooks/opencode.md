# OpenCode Plugins

OpenCode plugins are JS/TS modules loaded from `.opencode/plugins/`
(project) or `~/.config/opencode/plugins/` (global). Reference:
`https://opencode.ai/docs/plugins/`.

## Plugin entry

```ts
// .opencode/plugins/cognit.ts
import type { Plugin } from "@opencode-ai/plugin";
import { writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";

const inbox = process.env.COGNIT_INBOX ?? `${process.cwd()}/.cognit/inbox`;
const send = (env: unknown) => {
  const session = (env as any).session_id ?? "01HXXXXXXXXXXXXXXXXXXXXXXXX";
  const id = ulid();
  const tmp = join(inbox, `${session}-${id}.json.tmp`);
  const dest = join(inbox, `${session}-${id}.json`);
  writeFileSync(tmp, JSON.stringify(env));
  const fd = openSync(tmp, "r+"); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, dest);
};

export const CognitInbox: Plugin = async ({ client, $ }) => ({
  "tool.execute.after": async (input, output) => {
    send({
      schema_version: "1.0.0",
      type: "observation_recorded",
      session_id: "01HXXXXXXXXXXXXXXXXXXXXXXXX",
      actor: { type: "worker", name: "opencode" },
      payload: { tool: input.tool, args: input.args, output },
    });
  },
});
```

## Loading

- Local: drop under `.opencode/plugins/cognit.ts`.
- npm: list under `plugin` in `opencode.json` (`bun install` runs at
  startup; external packages need a `package.json`).

## Notes

- Handlers are `(input, output)`. Mutate `output.args` to alter; throw
  to block. Use `client.app.log()` instead of `console.log`.
