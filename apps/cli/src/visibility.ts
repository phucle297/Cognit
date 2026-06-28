/**
 * apps/cli/src/visibility.ts — controls whether internal commands
 * appear in `cognit help`.
 *
 * Phase A: the user sees a small public surface (init, session ls,
 * dashboard). Everything else is hidden behind `--internal` so the
 * CLI stays discoverable for new users while power users and AI
 * callers can still find every command.
 *
 * Phase B.2: promoted `env`, `config`, `schema-dump`, `recovery`,
 * `export`, `import` to the public set per
 * `plans/plan-simplify-public-surface.md` §2.4. The new commands
 * `doctor`, `reset`, and `update` are also public (they appear in
 * `cognit --help` without `--internal`) but are NOT listed here —
 * this set is purely the commands to hide when `--internal` is NOT
 * set. New public commands simply don't appear in
 * `INTERNAL_TOP_LEVEL` and are therefore visible by default.
 *
 * Module-level flag is set in the program's `preAction` hook from
 * the `--internal` global option. `applyInternalVisibility` walks
 * the registered command tree and either hides or reveals commands
 * based on the visibility lists.
 *
 * Commander 15 changed `hidden` from a method to a boolean property,
 * so we mutate `cmd.hidden = true|false` directly.
 */

const INTERNAL_TOP_LEVEL: ReadonlySet<string> = new Set([
  "snapshot",
  "append",
  "inbox",
  "events",
  "observe",
  "finding",
  "hypothesis",
  "theory",
  "experiment",
  "decision",
  "conclusion",
  "verify",
  "wrap",
  "artifact",
  "edge",
  "constraint",
  "redaction",
  "server",
  "gc",
  "agent",
  "ask",
]);

/**
 * Public verbs the LLM-facing surface uses (registered via the
 * `*Alias` helpers in observation.ts / verification.ts and via
 * register{Continue,Search}):
 *   - `observation`   (alias of observe)
 *   - `verification`  (alias of verify)
 *   - `continue`
 *   - `search`
 *
 * The full-noun commands (`decision`, `conclusion`, `verify`,
 * `observe`) stay internal — only the short alias verbs are public.
 * `decide` / `conclude` / `check` are the human-friendly public
 * aliases that already existed.
 *
 * Do NOT promote more commands without re-reading M1.1's
 * "keep public surface small" rule.
 */

// Aliases — intentionally NOT in `INTERNAL_TOP_LEVEL` so they show up
// in `cognit --help` for new users. Each alias in `commands/check.ts`,
// `commands/decide.ts`, and `commands/conclude.ts` is a thin wrapper
// that re-invokes `registerVerification` / `registerDecision` /
// `registerConclusion` against an isolated program tree. Keeping
// aliases public (and their canonical names internal) means the
// "lifecycle verbs" users type are discoverable, while advanced users
// still find the full event-named surface behind `--internal`.

// Within `session`, only `ls` (alias for `list`) is public. All
// lifecycle commands are hidden — they are AI/hook territory.
const INTERNAL_SESSION_SUBCMDS: ReadonlySet<string> = new Set([
  "create",
  "show",
  "resume",
  "pause",
  "close",
  "ensure",
]);

let showInternal = false;

export function setShowInternal(v: boolean): void {
  showInternal = v;
}

export function shouldShowInternal(): boolean {
  return showInternal;
}

export function isInternalTopLevel(name: string): boolean {
  return INTERNAL_TOP_LEVEL.has(name);
}

export function isInternalSessionSubcommand(name: string): boolean {
  return INTERNAL_SESSION_SUBCMDS.has(name);
}

interface CommandLike {
  name(): string;
  commands: ReadonlyArray<CommandLike>;
  [key: string]: unknown;
}

/**
 * Apply the current visibility flag to every command in the tree.
 * `program` is the Commander root; we walk `program.commands` and
 * for each `session` subcommand tree apply the session-scoped list.
 *
 * Commander 15 reads `_hidden` (private) when rendering help, not
 * the public `hidden` property, so we write both fields to stay in
 * sync with whatever commander version is pinned.
 *
 * Idempotent — safe to call multiple times (e.g. from a re-render).
 */
export function applyInternalVisibility(program: CommandLike): void {
  for (const top of program.commands) {
    const shouldHide = !showInternal && INTERNAL_TOP_LEVEL.has(top.name());
    const topMutable = top as unknown as { _hidden: boolean; hidden: boolean };
    topMutable._hidden = shouldHide;
    topMutable.hidden = shouldHide;
    if (top.name() === "session") {
      for (const sub of top.commands) {
        const subShouldHide = !showInternal && INTERNAL_SESSION_SUBCMDS.has(sub.name());
        const subMutable = sub as unknown as { _hidden: boolean; hidden: boolean };
        subMutable._hidden = subShouldHide;
        subMutable.hidden = subShouldHide;
      }
    }
  }
}
