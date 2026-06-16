import { Command } from "commander";
import process from "node:process";
import { BUILT_IN_REDACTION_PATTERNS } from "@cognit/core/redaction";
import { redactWithSpans, type RedactionHit } from "@cognit/db";
import { findProjectRoot, projectPaths } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { getOutputMode, emit } from "../output.js";

interface RedactionTestOptions {
  root?: string;
  json?: boolean;
}

const resolveProjectRoot = (raw: string | undefined): string => {
  if (raw) return raw;
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
    process.exitCode = 2;
    throw new Error("not in a cognit project");
  }
  return root;
};

/**
 * Read the project's `cognit.yaml` redaction section and return the
 * user pattern list. When the file is missing, the project is uninit'd,
 * or the section is absent, returns `[]` (built-ins only).
 */
const loadUserPatterns = async (root: string): Promise<typeof BUILT_IN_REDACTION_PATTERNS> => {
  const configPath = projectPaths(root).config;
  try {
    const config = await readConfig(configPath);
    return config.redaction.patterns;
  } catch (err) {
    // Missing file = uninit'd project. Treat as "no user patterns" so
    // the command still works against the built-ins.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
};

/**
 * Print the pattern / span / match table to stdout. Width is computed
 * from the longest name so the columns line up regardless of how
 * many user patterns the project defines. Multi-line matches
 * (e.g. a PEM block containing newlines) are escaped to a single
 * printable line so the column layout doesn't break.
 */
const printTable = (hits: ReadonlyArray<RedactionHit>): void => {
  const nameCol = Math.max("pattern".length, ...hits.map((h) => h.pattern.length));
  const spanCol = Math.max("span".length, ...hits.map((h) => formatSpan(h.span).length));
  process.stdout.write(
    `${"pattern".padEnd(nameCol)}  ${"span".padEnd(spanCol)}  match\n`,
  );
  for (const h of hits) {
    process.stdout.write(
      `${h.pattern.padEnd(nameCol)}  ${formatSpan(h.span).padEnd(spanCol)}  ${escapeForTable(h.match)}\n`,
    );
  }
};

const formatSpan = (span: readonly [number, number]): string => `[${span[0]}, ${span[1]})`;

/** Replace newlines + tabs with escape sequences so a multi-line
 *  match (PEM block) still fits the table row. */
const escapeForTable = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");

/**
 * `cognit redaction test "<string>"` — dry-run redaction against the
 * built-in patterns + any user patterns in `cognit.yaml`. Prints a
 * table of every match (pattern / span / match) and then the
 * redacted output. Does NOT write to the event store.
 *
 * Designed for two audiences:
 *
 *  - Operators tweaking `cognit.yaml::redaction.patterns` who want to
 *    verify their regex actually fires on representative input.
 *  - The `cognit verify <cmd>` engine (and any other driver) that
 *    wants to know what *would* be redacted before deciding whether
 *    to send something to the store.
 */
export function registerRedaction(program: Command): void {
  const redaction = program
    .command("redaction")
    .description("dry-run redaction against the built-in + user pattern set");

  redaction
    .command("test")
    .description("scan <text> with the merged redaction pattern set and print matches")
    .argument("<text>", "the text to scan (quote to keep shell tokens together)")
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (text: string, opts: RedactionTestOptions) => {
      const root = resolveProjectRoot(opts.root);
      const userPatterns = await loadUserPatterns(root);
      // Merge BUILT_IN + user patterns into one set. User patterns go
      // last so the iteration order is "built-ins first, user second";
      // `redactWithSpans` records hits in iteration order, so the
      // table output is stable for a given input + config.
      const patterns = [...BUILT_IN_REDACTION_PATTERNS, ...userPatterns];

      // Validate the regexes eagerly so a malformed user pattern
      // surfaces as a clean error before we touch the redactor.
      // `redactWithSpans` would also throw on the first bad pattern,
      // but the message would be the raw `SyntaxError`; here we get a
      // precise `cognit: invalid regex in redaction.patterns.<name>:
      // <reason>`.
      for (const p of userPatterns) {
        try {
          new RegExp(p.regex);
        } catch (err) {
          process.stderr.write(
            `cognit: invalid regex in redaction.patterns.${p.name}: ${(err as Error).message}\n`,
          );
          process.exitCode = 1;
          return;
        }
      }

      const { redacted, hits } = redactWithSpans(text, patterns);

      if (getOutputMode() === "json") {
        emit("json", "redaction.test", {
          input: text,
          patterns: patterns.map((p) => ({ name: p.name, regex: p.regex, replacement: p.replacement })),
          hits: hits.map((h) => ({ pattern: h.pattern, span: h.span, match: h.match })),
          redacted,
        });
        return;
      }

      if (hits.length === 0) {
        process.stdout.write("no matches\n");
      } else {
        printTable(hits);
      }
      process.stdout.write("---\n");
      process.stdout.write(`redacted: ${redacted}\n`);
    });
}
