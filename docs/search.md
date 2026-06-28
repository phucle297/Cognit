# How do I find past reasoning?

Three months from now, how do you find out *why* a file looks the
way it does?

## Short answer

```bash
cognit recovery search <query>
```

Searches fuzzy across the goal, the observations, the hypotheses,
and the decisions. No SQL, no grep over commit messages, no
scrolling through chat history.

## Examples

```bash
cognit recovery search "memory leak in worker pool"
cognit recovery search "rate limit trade-off"
cognit recovery search "dropped the JWT refresh"
```

Use whatever words you would say to a teammate. Cognit matches on
meaning, not exact text.

## Flags

- `--status <active|paused|closed>` — limit to sessions in one
  state. Useful when you want to look back at finished work only,
  or pick up something still in progress.
- `--server-url <url>` — point at a Cognit server other than the
  local default (for example, a teammate's machine on your LAN).
  Defaults to the local server you started with `cognit server` or
  `cognit dashboard`.

## Prerequisite

Search runs against the local server, so it needs Cognit running in
the background:

```bash
cognit server &
```

Then search works from any shell in the same project. The server
shares the same database file as the CLI, so everything you have
already saved is searchable.

## Where to go next

For the full CLI surface — every flag, every command — see
[cli.md](cli.md).