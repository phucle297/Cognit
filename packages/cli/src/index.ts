#!/usr/bin/env node
import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerConfig } from "./commands/config.js";
import { registerSession } from "./commands/session.js";
import { registerSnapshot } from "./commands/snapshot.js";
import { registerAppend } from "./commands/append.js";
import { registerInbox } from "./commands/inbox.js";
import { registerEvents } from "./commands/events.js";
import { registerObservation } from "./commands/observation.js";
import { registerFinding } from "./commands/finding.js";
import { registerHypothesis } from "./commands/hypothesis.js";
import { registerTheory } from "./commands/theory.js";
import { registerExperiment } from "./commands/experiment.js";
import { registerDecision } from "./commands/decision.js";
import { registerConclusion } from "./commands/conclusion.js";
import { registerVerification } from "./commands/verification.js";
import { registerArtifact } from "./commands/artifact.js";
import { registerEdge } from "./commands/edge.js";
import { registerConstraint } from "./commands/constraint.js";
import { registerRedaction } from "./commands/redaction.js";
import { registerSchemaDump } from "./commands/schema-dump.js";
import { registerServer } from "./commands/server.js";
import { setOutputMode, type OutputMode } from "./output.js";

const program = new Command();

program
  .name("cognit")
  .description("Git for AI cognition. Local-first persistent decision and knowledge layer.")
  .version("0.0.0");

// Global --json flag (3b). When set, every command's stdout switches
// to the stable JSON envelope `{ version: 1, kind, data }`. Stored
// in a module-level so commands can read it from their `action`.
// We register BEFORE `register*()` so the option is attached to the
// program root (visible to all subcommands via `program.opts()`).
program.option("--json", "emit a stable JSON envelope on stdout").hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts<{ json?: boolean }>();
  const mode: OutputMode = opts.json ? "json" : "text";
  setOutputMode(mode);
});

// Global `--root <path>`. Lets the docker entrypoint pass it before
// the subcommand (`cognit --root /data init`). Per-subcommand `--root`
// flags still work for the more common `cognit <subcommand> --root …`
// form; the action handler resolves root from
// `command.optsWithGlobals()` so both shapes hit the same code path.
program.option(
  "--root <path>",
  "project root (default: $COGNIT_ROOT or current directory); applies to every subcommand",
);

registerInit(program);
registerConfig(program);
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
registerArtifact(program);
registerEdge(program);
registerConstraint(program);
registerRedaction(program);
registerSchemaDump(program);
registerServer(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`cognit: ${(err as Error).message}\n`);
  process.exit(1);
});
