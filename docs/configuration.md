# Configuration

Cognit is configured by a single YAML file, `.cognit/cognit.yaml`. Its path
is resolved at `apps/cli/src/paths.ts:30` (`cognitDir`) and the file is
written by `apps/cli/src/yaml-io.ts`; `cognit init` produces the default
contents (`apps/cli/src/commands/init.ts:1`).

The schema is an Effect Schema declared in `packages/core/src/config.ts:1`.
Validation happens at read time via `Schema.decodeUnknownSync(CognitConfigSchema)`
— bad input throws a `ParseError` with a tree-formatted message.

## Top-level shape

```yaml
project:                  # required
  name: <string>          # 1–128 chars
redaction:                # optional, defaults below
  enabled: true
  patterns: []
cleanup:                  # optional
  artifact_max_age_days: 30
  unreferenced_action: archive   # archive | delete | keep
  max_db_size_mb: 1024
session:
  snapshot_every_n_events: 100
  fork_on_resume: true
actors:
  defaults:               # trust-score defaults per actor type
    human: 0.9
    worker: 0.6
    system: 1.0
  known: []               # explicit actor registrations
inbox:
  watch: true
  debounce_ms: 200        # min mtime-age before a file is considered complete
  atomic_write_required: true
gravity:
  freshness_half_life_days: 14
  weights:                # must sum to 1.0 ± 0.001
    evidence: 0.3
    reproducibility: 0.3
    confidence: 0.2
    trust: 0.1
    freshness: 0.1
llm:
  base_url: http://localhost:4000
  api_key_env: LITELLM_MASTER_KEY
  format: openai
  default_model: <model-id>
  model_aliases:
    fast: <model-id>
    smart: <model-id>
  timeout_ms: <number>
  commands:
    ask:       { alias: fast,       model: <model-id> }
    agent_run: { alias: smart,      model: <model-id> }
```

`project.name` is the only required key (everything else has a schema default;
see `packages/core/src/config.ts` for the canonical defaults). There is **no
auth section** — local-only tool, server binds to loopback by default.

## Section reference

| Section      | Schema definition (`packages/core/src/config.ts`) | Purpose                                                                                                  |
|--------------|---------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| `project`    | `:18`                                              | Project identity (name on disk; the id is the project's `.cognit/` path).                                |
| `redaction`  | `:23-38`                                           | Built-in + user regex patterns applied to event payloads (`{ name, regex, replacement }`).                |
| `cleanup`    | `:40-49`                                           | GC tunables consumed by `cognit gc`: `artifact_max_age_days`, `unreferenced_action`, `max_db_size_mb`.    |
| `session`    | `:51-54`                                           | Snapshot cadence (`snapshot_every_n_events`) and resume policy (`fork_on_resume`).                       |
| `actors`     | `:56-77`                                           | Per-type trust defaults + an explicit list of known emitters (`{ name, trust_score }`).                  |
| `inbox`      | `:79-83`                                           | Watcher behaviour. `debounce_ms` is the minimum mtime-age before a file is considered complete.          |
| `gravity`    | `:87-159`                                          | Gravity engine weights + freshness half-life. Weights must sum to 1.0 ± 0.001 (custom refinement, `:144`).|
| `llm`        | `:178-208` (schema) / `:225-235` (resolved type)  | LiteLLM proxy config. See resolution rules below.                                                       |

## LLM resolution

The CLI resolves the upstream model id through `apps/cli/src/config-resolver.ts:56`
(`resolveModel`). Order per spec §2:

1. `--model <id>` flag on the CLI.
2. `llm.commands[<cmd>].model` (literal id).
3. `llm.commands[<cmd>].alias` (looked up in `llm.model_aliases`).
4. `llm.default_model`.
5. Error: `"no model configured (set llm.default_model or pass --model)"`.

The API key is read at call time from `process.env[llm.api_key_env]`
(`apps/cli/src/config-resolver.ts:97`, `resolveApiKey`). Missing/empty env
throws `LlmCompletionError` with the exact env var name so operators can
grep for it.

## CLI entry points

`cognit config show` and `cognit config edit` (`apps/cli/src/commands/config.ts:1`)
read and write this file. `cognit init` (`apps/cli/src/commands/init.ts:1`)
writes the default version.