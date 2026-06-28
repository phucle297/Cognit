import { Command } from "commander";
import { registerDecision } from "./decision.js";

/**
 * `cognit decide` — alias for `cognit decision`.
 *
 * Phase B.3 of the public-surface simplification: the lifecycle verb
 * users type is `decide` (Decision keeps its name in the public
 * vocabulary; only the CLI surface verb is shortened). The underlying
 * event family + storage + reducer are unchanged.
 *
 * Subcommands: `propose | accept | reject | supersede` — forward
 * verbatim to `decision <sub>`. The inner program tree is built
 * fresh per invocation so flag definitions stay in sync with
 * `decision.ts` automatically.
 */
export function registerDecide(program: Command): void {
  const decide = program
    .command("decide")
    .description("alias for `cognit decision`");

  decide
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[]) => {
      const sub = new Command();
      sub.name("cognit").exitOverride();
      registerDecision(sub);
      // Strip a redundant leading `decision` keyword so users can
      // type either `cognit decide decision propose --help` or
      // `cognit decide propose --help` — both reach
      // `decision propose`.
      const innerArgs = args[0] === "decision" ? args.slice(1) : args;
      // `from: "user"` tells Commander these are pure user args —
      // NOT `[node, script, ...user]` like `process.argv` would be.
      try {
        await sub.parseAsync(["decision", ...innerArgs], { from: "user" });
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
