import { Command } from 'commander';
import { findProjectRoot, projectPaths } from '../paths.js';
import { readConfig } from '../yaml-io.js';
import { spawn } from 'node:child_process';
import process from 'node:process';

interface ConfigOptions {
  show?: boolean;
  edit?: boolean;
}

function requireProject(): { root: string; paths: ReturnType<typeof projectPaths> } {
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write('cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n');
    process.exitCode = 2;
    throw new Error('not in a cognit project');
  }
  return { root, paths: projectPaths(root) };
}

/**
 * `cognit config --show` prints the parsed config as YAML.
 * `cognit config --edit` opens the file in `$EDITOR` (fallback `vi`).
 * Default with no flag: --show.
 */
export function registerConfig(program: Command): void {
  program
    .command('config')
    .description('show or edit the local cognit.yaml')
    .option('--show', 'print the parsed config as YAML (default)')
    .option('--edit', 'open cognit.yaml in $EDITOR')
    .action(async (opts: ConfigOptions) => {
      const { paths } = requireProject();
      if (opts.edit) {
        const editor = process.env['EDITOR'] ?? 'vi';
        const child = spawn(editor, [paths.config], { stdio: 'inherit' });
        await new Promise<void>((resolve) => {
          child.on('exit', () => resolve());
        });
        return;
      }
      // default + --show: read + print raw text (preserves comments/ordering)
      const text = await (await import('node:fs/promises')).readFile(paths.config, 'utf8');
      process.stdout.write(text);
      // touch readConfig so the import isn't tree-shaken; Schema validation
      // also happens here and surfaces a clear error if the file is bad.
      try {
        await readConfig(paths.config);
      } catch (err) {
        process.stderr.write(
          `cognit: warning — ${paths.config} is not valid: ${(err as Error).message}\n`,
        );
        process.exitCode = 1;
      }
    });
}
