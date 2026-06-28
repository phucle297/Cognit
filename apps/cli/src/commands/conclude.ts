import { Command } from "commander";
import { registerConclusion } from "./conclusion.js";

/**
 * `cognit conclude` — alias for `cognit conclusion`.
 *
 * Phase B.3 of the public-surface simplification: the lifecycle verb
 * users type is `conclude` (Conclusion keeps its name in the public
 * vocabulary; only the CLI surface verb is shortened). The underlying
 * event family + storage + reducer are unchanged.
 *
 * Subcommands: `propose | verify | reject` — forward verbatim to
 * `conclusion <sub>`. The inner program tree is built fresh per
 * invocation so flag definitions stay in sync with `conclusion.ts`
 * automatically.
 */
export function registerConclude(program: Command): void {
  const conclude = program
    .command("conclude")
    .description("alias for `cognit conclusion`");

  conclude
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[]) => {
      const sub = new Command();
      sub.name("cognit").exitOverride();
      registerConclusion(sub);
      // Strip a redundant leading `conclusion` keyword so users can
      // type either `cognit conclude conclusion propose --help` or
      // `cognit conclude propose --help` — both reach
      // `conclusion propose`.
      const innerArgs = args[0] === "conclusion" ? args.slice(1) : args;
      // `from: "user"` tells Commander these are pure user args —
      // NOT `[node, script, ...user]` like `process.argv` would be.
      try {
        await sub.parseAsync(["conclusion", ...innerArgs], { from: "user" });
      } catch (err) {
        // Commander throws `CommanderError` after rendering help or
        // for `--version`; that's a clean exit, not a real failure.
        const code = (err as { code?: string }).code;
        if (code !== "commander.helpDisplayed" && code !== "commander.versionDisplayed") {
          throw err;
        }
      }
    });
}
