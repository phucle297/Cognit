import { Command } from "commander";
import { registerVerification } from "./verification.js";

/**
 * `cognit check` — alias for `cognit verify`.
 *
 * Phase B.3 of the public-surface simplification: the lifecycle verb
 * users type is `check` (a Check is the renamed Verification in the
 * public vocabulary), but the underlying event family + storage +
 * reducer are unchanged. This file is a thin wrapper — every flag
 * the original `verify` accepts is forwarded verbatim by re-running
 * `registerVerification` on an isolated `Command` instance and
 * `parseAsync`-ing the alias's argv against it.
 *
 * Zero duplication: we do not copy option definitions or action
 * bodies. `registerVerification` is the single source of truth.
 */
export function registerCheck(program: Command): void {
  const check = program
    .command("check")
    .description("alias for `cognit verify` -- record that a check ran");

  check
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[]) => {
      // Build an isolated program tree containing only `verify`.
      // Reusing `registerVerification` means any new flag added to
      // verify is automatically accepted here.
      const sub = new Command();
      sub.name("cognit").exitOverride();
      registerVerification(sub);
      // Strip a redundant leading `verify` keyword so users can
      // type either `cognit check verify cancel --help` or
      // `cognit check cancel --help` — both reach `verify cancel`.
      const innerArgs = args[0] === "verify" ? args.slice(1) : args;
      // `from: "user"` tells Commander these are pure user args —
      // NOT `[node, script, ...user]` like `process.argv` would be.
      // Without this, the first two tokens get stripped and the
      // subcommand dispatch never happens.
      try {
        await sub.parseAsync(["verify", ...innerArgs], { from: "user" });
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
