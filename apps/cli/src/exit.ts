/**
 * Exit code contract for the Cognit CLI (D-M2-01).
 *
 * | Code | Meaning                                              |
 * |------|------------------------------------------------------|
 * | 0    | Success                                              |
 * | 1    | Runtime / internal failure (DB, I/O, unexpected)     |
 * | 2    | Usage / validation / not a Cognit project / bad args |
 * | 3+   | Reserved                                             |
 *
 * Prefer these helpers over scattering raw `process.exitCode = N`
 * assignments. Commands may still set `process.exitCode` directly when
 * a helper would force a throw they intentionally avoid.
 */

export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

/**
 * Report a usage/validation error to stderr and set exit code 2.
 * Does not throw — callers decide whether to return or throw.
 */
export function failUsage(msg: string): void {
  process.stderr.write(`cognit: ${msg}\n`);
  process.exitCode = EXIT_USAGE;
}

/**
 * Report a runtime/internal failure to stderr and set exit code 1.
 * Does not throw — callers decide whether to return or throw.
 */
export function failRuntime(msg: string): void {
  process.stderr.write(`cognit: ${msg}\n`);
  process.exitCode = EXIT_RUNTIME;
}

/**
 * Map a Commander parse failure (or any thrown error) onto the contract.
 * CommanderError carries its own `exitCode` (often 1 for missing args);
 * we normalize known usage codes to 2 so scripts can branch reliably.
 */
export function exitCodeFromError(err: unknown): number {
  if (err && typeof err === "object") {
    const e = err as { exitCode?: number; code?: string; message?: string };
    // Help/version are success paths that still throw under exitOverride.
    if (
      e.code === "commander.helpDisplayed" ||
      e.code === "commander.versionDisplayed"
    ) {
      return EXIT_SUCCESS;
    }
    // Commander usage failures: missing required arg, unknown option, etc.
    if (
      typeof e.code === "string" &&
      e.code.startsWith("commander.") &&
      e.code !== "commander.executeSubCommandAsync"
    ) {
      // Keep intentional non-zero codes (e.g. custom program.error), but
      // promote the common "user error" default of 1 → 2 for usage.
      if (e.exitCode === undefined || e.exitCode === 1) return EXIT_USAGE;
      return e.exitCode;
    }
    if (typeof e.exitCode === "number") return e.exitCode;
  }
  // If a command already set process.exitCode, honour it.
  if (typeof process.exitCode === "number") return process.exitCode;
  return EXIT_RUNTIME;
}
