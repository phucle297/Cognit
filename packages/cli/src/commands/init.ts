import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { defaultConfig } from "@cognit/core/config";
import { COGNIT_SUBDIRS, projectPaths, isCognitProject } from "../paths.js";
import { writeConfig, writeCognitGitignore } from "../yaml-io.js";

interface InitOptions {
  project?: string;
  force?: boolean;
}

/**
 * `cognit init [--project name] [--force]`
 *
 * Initialise a local Cognit project in the current directory. Creates
 * the `.cognit/` directory tree, writes a default `cognit.yaml`, and
 * adds a `.gitignore` snippet that keeps the database and runtime
 * state out of version control while committing the config.
 */
export function registerInit(program: Command): void {
  program
    .command("init")
    .description("initialise a local Cognit project in the current directory")
    .option("-p, --project <name>", "project name (default: directory name)")
    .option("-f, --force", "re-initialise an existing project (overwrite cognit.yaml)")
    .action(async (opts: InitOptions) => {
      const cwd = process.cwd();
      const projectRoot = cwd;
      const paths = projectPaths(projectRoot);

      if (isCognitProject(projectRoot) && !opts.force) {
        process.stderr.write(
          `cognit: ${paths.config} already exists. Pass --force to overwrite.\n`,
        );
        process.exitCode = 2;
        return;
      }

      const projectName =
        opts.project && opts.project.length > 0 ? opts.project : path.basename(projectRoot);

      await fs.mkdir(paths.dir, { recursive: true });
      for (const sub of COGNIT_SUBDIRS) {
        await fs.mkdir(path.join(paths.dir, sub), { recursive: true });
      }

      const config = defaultConfig(projectName);
      await writeConfig(paths.config, config);
      await writeCognitGitignore(paths.gitignore);

      process.stdout.write(`Initialised Cognit project: ${projectName}\n`);
      process.stdout.write(`  ${paths.config}\n`);
      for (const sub of COGNIT_SUBDIRS) {
        process.stdout.write(`  ${path.join(paths.dir, sub)}/\n`);
      }
    });
}
