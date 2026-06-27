/**
 * Soft-deprecation helper for experimental CLI subcommands.
 *
 * `cognit theory` and `cognit experiment` remain first-class in the
 * code (they have full reducer branches, payload schemas, and CLI
 * subcommands) but the README soft-deprecates them. To bridge the two,
 * each top-level register function calls `warnExperimentalOnce` on
 * first invocation per process. The warning is emitted to stderr and
 * does NOT block execution — exit code is still 0 on success.
 *
 * Suppression: set `COGNIT_QUIET_DEPRECATIONS=1` in the environment
 * to suppress the warning entirely (useful for scripts that loop over
 * `cognit theory` / `cognit experiment`). The default is one warning
 * per (label, process) pair — process-local state, not persisted.
 */

/** Process-local set of labels that have already been warned. */
const warned = new Set<string>();

/**
 * Emit a soft-deprecation warning to stderr, at most once per label
 * per process invocation. Honours `COGNIT_QUIET_DEPRECATIONS=1`.
 *
 * The `label` is the human-readable subcommand name (e.g.
 * `"cognit theory"`); it appears in the warning text and is used as
 * the de-dup key.
 */
export function warnExperimentalOnce(label: string): void {
  if (process.env.COGNIT_QUIET_DEPRECATIONS === "1") return;
  if (warned.has(label)) return;
  warned.add(label);
  process.stderr.write(
    `warning: ${label} is rarely needed; most investigations use ` +
      `Observation → Finding → Hypothesis → Verification → Conclusion → Decision. ` +
      `Set COGNIT_QUIET_DEPRECATIONS=1 to suppress this warning.\n`,
  );
}