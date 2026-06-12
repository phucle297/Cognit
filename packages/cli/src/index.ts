#!/usr/bin/env node
import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerConfig } from "./commands/config.js";

const program = new Command();

program
  .name("cognit")
  .description("Git for AI cognition. Local-first persistent decision and knowledge layer.")
  .version("0.0.0");

registerInit(program);
registerConfig(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`cognit: ${(err as Error).message}\n`);
  process.exit(1);
});
