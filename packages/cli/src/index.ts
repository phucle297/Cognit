#!/usr/bin/env node
import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerConfig } from "./commands/config.js";
import { registerSession } from "./commands/session.js";
import { registerSnapshot } from "./commands/snapshot.js";
import { registerAppend } from "./commands/append.js";
import { registerInbox } from "./commands/inbox.js";
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

const program = new Command();

program
  .name("cognit")
  .description("Git for AI cognition. Local-first persistent decision and knowledge layer.")
  .version("0.0.0");

registerInit(program);
registerConfig(program);
registerSession(program);
registerSnapshot(program);
registerAppend(program);
registerInbox(program);
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

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`cognit: ${(err as Error).message}\n`);
  process.exit(1);
});
