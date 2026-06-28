/**
 * apps/cli/src/visibility.ts — controls whether internal commands
 * appear in `cognit help`.
 *
 * Phase A: the user sees a small public surface (init, session ls,
 * dashboard). Everything else is hidden behind `--internal` so the
 * CLI stays discoverable for new users while power users and AI
 * callers can still find every command.
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
  "env",
  "config",
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
  "schema-dump",
  "server",
  "gc",
  "export",
  "import",
  "recovery",
  "agent",
  "ask",
]);

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
