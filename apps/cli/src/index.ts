import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerConfig } from "./commands/config.js";
import { registerEnv } from "./commands/env.js";
import { registerSession } from "./commands/session.js";
import { registerSnapshot } from "./commands/snapshot.js";
import { registerAppend } from "./commands/append.js";
import { registerInbox } from "./commands/inbox.js";
import { registerEvents } from "./commands/events.js";
import { registerObservation, registerObservationAlias } from "./commands/observation.js";
import { registerFinding } from "./commands/finding.js";
import { registerHypothesis } from "./commands/hypothesis.js";
import { registerTheory } from "./commands/theory.js";
import { registerExperiment } from "./commands/experiment.js";
import { registerDecision } from "./commands/decision.js";
import { registerConclusion } from "./commands/conclusion.js";
import { registerVerification, registerVerificationAlias } from "./commands/verification.js";
import { registerCheck } from "./commands/check.js";
import { registerDecide } from "./commands/decide.js";
import { registerConclude } from "./commands/conclude.js";
import { registerWrap } from "./commands/wrap.js";
import { registerArtifact } from "./commands/artifact.js";
import { registerEdge } from "./commands/edge.js";
import { registerConstraint } from "./commands/constraint.js";
import { registerRedaction } from "./commands/redaction.js";
import { registerSchemaDump } from "./commands/schema-dump.js";
import { registerServer } from "./commands/server.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerReset } from "./commands/reset.js";
import { registerUpdate } from "./commands/update.js";
import { registerGc } from "./commands/gc.js";
import { registerExport } from "./commands/export.js";
import { registerImport } from "./commands/import.js";
import { registerRaw } from "./commands/raw.js";
import { registerRecovery } from "./commands/recovery.js";
import { registerAgent } from "./commands/agent.js";
import { registerAsk } from "./commands/ask.js";
import { registerContinue } from "./commands/continue.js";
import { registerSearch } from "./commands/search.js";
import { setOutputMode } from "./output.js";
import { applyInternalVisibility, setShowInternal } from "./visibility.js";
import { exitCodeFromError } from "./exit.js";
import { registerCompletion } from "./commands/completion.js";

const program = new Command();

program
  .name("cognit")
  .description("Cognit — remembers why your code looks like this. Local-first.")
  .version("0.0.0");

// Throw CommanderError instead of process.exit so we can map usage
// failures to exit code 2 (D-M2-01 contract).
program.exitOverride();

// Global --json flag (3b). When set, every command's stdout switches
// to the stable JSON envelope `{ version: 1, kind, data }`. Stored
// in a module-level so commands can read it from their `action`.
// We register BEFORE `register*()` so the option is attached to the
// program root (visible to all subcommands via `program.opts()`).
program.option("--json", "emit a stable JSON envelope on stdout");

// Global --internal. When set, every internal command (and hidden
// subcommand under `session`) appears in `cognit help`. Defaults
// off so the public surface — init / session ls / dashboard — is
// all a new user sees. Phase A: we hide, we do not delete.
program.option(
  "--internal",
  "reveal internal commands in help (intended for AI callers and power users)",
);

// Global `--root <path>`. Lets the docker entrypoint pass it before
// the subcommand (`cognit --root /data init`). Per-subcommand `--root`
// flags still work for the more common `cognit <subcommand> --root …`
// form; the action handler resolves root from
// `command.optsWithGlobals()` so both shapes hit the same code path.
program.option(
  "--root <path>",
  "project root (default: $COGNIT_ROOT or current directory); applies to every subcommand",
);

// Resolve visibility + output mode before any action runs. We read
// from `thisCommand.optsWithGlobals()` so the flags work whether they
// were placed before the subcommand (`cognit --internal help`) or
// after (`cognit help --internal`).
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.optsWithGlobals() as { json?: boolean; internal?: boolean };
  setOutputMode(opts.json ? "json" : "text");
  setShowInternal(opts.internal === true);
  applyInternalVisibility(program as unknown as Parameters<typeof applyInternalVisibility>[0]);
});

registerInit(program);
registerConfig(program);
registerEnv(program);
registerSession(program);
registerSnapshot(program);
registerAppend(program);
registerInbox(program);
registerEvents(program);
registerObservation(program);
registerFinding(program);
registerHypothesis(program);
registerTheory(program);
registerExperiment(program);
registerDecision(program);
registerConclusion(program);
registerVerification(program);
registerCheck(program);
registerDecide(program);
registerConclude(program);
registerWrap(program);
registerArtifact(program);
registerEdge(program);
registerConstraint(program);
registerRedaction(program);
registerSchemaDump(program);
registerServer(program);
registerDashboard(program);
registerDoctor(program);
registerReset(program);
registerUpdate(program);
registerGc(program);
registerExport(program);
registerImport(program);
registerRaw(program);
registerRecovery(program);
registerAgent(program);
registerAsk(program);
registerObservationAlias(program);
registerVerificationAlias(program);
registerContinue(program);
registerSearch(program);
registerCompletion(program);

// Initial visibility pass — public help shows only init / session ls
// / dashboard until the user passes --internal.
applyInternalVisibility(program as unknown as Parameters<typeof applyInternalVisibility>[0]);

// Re-apply visibility right before help renders. Commander dispatches
// `--help` via `_outputHelpIfRequested` BEFORE `preAction` fires, so
// the preAction hook never runs for `cognit --internal --help`.
// `beforeHelp` is the documented hook for "I'm about to render help",
// which is the earliest point we can react to the parsed options.
// We register on every subcommand so `cognit session --help --internal`
// applies visibility to the session subcommand tree.
const wireBeforeHelp = (cmd: { on: (e: string, l: (...a: unknown[]) => void) => unknown }) => {
  cmd.on("beforeHelp", () => {
    const opts = program.opts<{ internal?: boolean }>();
    setShowInternal(opts.internal === true);
    applyInternalVisibility(program as unknown as Parameters<typeof applyInternalVisibility>[0]);
  });
};
wireBeforeHelp(program);
for (const sub of program.commands) {
  wireBeforeHelp(sub as unknown as { on: (e: string, l: (...a: unknown[]) => void) => unknown });
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const code = exitCodeFromError(err);
  // Commander already printed usage/help for parse failures. Commands that
  // call failUsage/failRuntime also already wrote to stderr.
  const e = err as { code?: string; message?: string };
  const isCommander = typeof e.code === "string" && e.code.startsWith("commander.");
  const alreadyReported = typeof process.exitCode === "number";
  if (!isCommander && !alreadyReported) {
    process.stderr.write(`cognit: ${e.message ?? String(err)}\n`);
  }
  process.exit(code);
});
