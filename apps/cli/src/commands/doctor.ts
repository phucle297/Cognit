/**
 * apps/cli/src/commands/doctor.ts
 *
 * `cognit doctor [--root <path>] [--fix]`
 *
 * Healthcheck for a Cognit project. Reports the status of the seven
 * subsystems that have to be working for the rest of the CLI / server
 * to function:
 *
 *   1. isCognitProject(root)               — marker file present
 *   2. .cognit/ subdirs present            — inbox / artifacts / …
 *   3. cognit.db opens + has schema        — SQLite reachable
 *   4. project row exists                  — bootstrap row present
 *   5. hooks installed for detected tools  — per-tool install status
 *   6. inbox watcher reachable             — inbox dir exists &
 *                                            writable (the watcher is
 *                                            lock-free; see
 *                                            packages/db/src/inbox.ts)
 *   7. server health if running            — GET 127.0.0.1:6971/healthz
 *                                            (skipped when the probe
 *                                            fails — not an error)
 *
 * Output:
 *   - text (default): a checkmark/X table with one row per check,
 *     plus a summary line. Exit code 0 on PASS, 1 on FAIL.
 *   - json (`--json`): the stable v1 envelope with `data.checks` as
 *     a structured array — same shape as the text rows. Exit code
 *     follows the same rule (0 on PASS, 1 on any FAIL).
 *
 * `--fix` re-runs `init --force` (config-only re-write) and
 * `detectAndInstallHooks` to repair the safe, non-destructive items.
 * It does NOT recreate the database or delete files; destructive
 * recovery lives in `cognit reset`.
 */
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { Effect } from "effect";
import { ProjectService } from "@cognit/db";
import { COGNIT_SUBDIRS, projectPaths, isCognitProject } from "../paths.js";
import { withAppLayer } from "../layer-build.js";
import { detectAndInstallHooks, type HookInstallResult } from "../hook-installer.js";
import { emit, getOutputMode } from "../output.js";

interface DoctorOptions {
  root?: string;
  fix?: boolean;
}

interface CheckResult {
  readonly id: string;
  readonly label: string;
  readonly status: "pass" | "fail" | "warn" | "skip";
  readonly detail: string;
}

const SERVER_HEALTHZ_URL = "http://127.0.0.1:6971/api/healthz";
const SERVER_PROBE_TIMEOUT_MS = 1500;

const resolveProjectRoot = (opts: DoctorOptions, globals: { root?: string }): string =>
  path.resolve(opts.root ?? globals.root ?? process.env["COGNIT_ROOT"] ?? process.cwd());

/**
 * Best-effort HTTP probe. We deliberately don't throw — a non-running
 * server is a `skip` result, not a `fail`. Loopback-only, no auth.
 */
const probeServer = async (): Promise<CheckResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(SERVER_HEALTHZ_URL, { signal: controller.signal });
    if (res.ok) {
      return {
        id: "server",
        label: "server health (127.0.0.1:6971/healthz)",
        status: "pass",
        detail: `HTTP ${res.status}`,
      };
    }
    return {
      id: "server",
      label: "server health (127.0.0.1:6971/healthz)",
      status: "fail",
      detail: `HTTP ${res.status}`,
    };
  } catch {
    return {
      id: "server",
      label: "server health (127.0.0.1:6971/healthz)",
      status: "skip",
      detail: "not reachable (run `cognit server` to start it)",
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Open the DB via the standard Layer path so we exercise the same
 * migration / integrity_check chain every command does. Returns a
 * check + (when applicable) the rowcount for the project probe.
 */
const checkDatabase = async (
  projectRoot: string,
): Promise<{ checks: CheckResult[]; projectExists: boolean }> => {
  const checks: CheckResult[] = [];
  let projectExists = false;
  try {
    await Effect.runPromise(
      withAppLayer(
        projectRoot,
        Effect.gen(function* () {
          const projectService = yield* ProjectService;
          const list = yield* projectService.list();
          projectExists = list.length > 0;
        }),
      ),
    );
    checks.push({
      id: "db",
      label: "cognit.db opens + has schema",
      status: "pass",
      detail: projectPaths(projectRoot).db,
    });
    checks.push({
      id: "project",
      label: "project row exists",
      status: projectExists ? "pass" : "fail",
      detail: projectExists ? "1+ row" : "no project row (run `cognit init`)",
    });
  } catch (e) {
    checks.push({
      id: "db",
      label: "cognit.db opens + has schema",
      status: "fail",
      detail: (e as Error).message,
    });
    checks.push({
      id: "project",
      label: "project row exists",
      status: "skip",
      detail: "skipped (db probe failed)",
    });
  }
  return { checks, projectExists };
};

/**
 * The inbox watcher is lock-free (see packages/db/src/inbox.ts); a
 * healthy inbox is one whose directory exists AND is writable. We
 * probe writability by attempting to create + remove a sentinel file
 * inside it. A permission failure becomes a `fail`, a missing dir is
 * a `fail` (the init step creates it).
 */
const checkInbox = (projectRoot: string): CheckResult => {
  const inboxDir = projectPaths(projectRoot).inbox;
  if (!fs.existsSync(inboxDir)) {
    return {
      id: "inbox",
      label: "inbox watcher reachable (no lock file)",
      status: "fail",
      detail: `directory missing: ${inboxDir}`,
    };
  }
  const sentinel = path.join(inboxDir, `.cognit-doctor-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(sentinel, "");
    fs.unlinkSync(sentinel);
    return {
      id: "inbox",
      label: "inbox watcher reachable (no lock file)",
      status: "pass",
      detail: inboxDir,
    };
  } catch (e) {
    return {
      id: "inbox",
      label: "inbox watcher reachable (no lock file)",
      status: "fail",
      detail: (e as Error).message,
    };
  }
};

const checkSubdirs = (projectRoot: string): CheckResult => {
  const dir = projectPaths(projectRoot).dir;
  const missing: string[] = [];
  for (const sub of COGNIT_SUBDIRS) {
    if (!fs.existsSync(path.join(dir, sub))) missing.push(sub);
  }
  if (missing.length === 0) {
    return {
      id: "subdirs",
      label: ".cognit/ subdirs present",
      status: "pass",
      detail: `${COGNIT_SUBDIRS.length}/${COGNIT_SUBDIRS.length}`,
    };
  }
  return {
    id: "subdirs",
    label: ".cognit/ subdirs present",
    status: "fail",
    detail: `missing: ${missing.join(", ")}`,
  };
};

const checkHooks = (): CheckResult[] => {
  const results: HookInstallResult[] = detectAndInstallHooks();
  return results.map((r) => {
    const status: CheckResult["status"] =
      r.status === "installed" || r.status === "already-wired"
        ? "pass"
        : r.status === "tool-not-detected"
          ? "skip"
          : "fail";
    const label = `hooks installed: ${r.tool}`;
    return {
      id: `hooks.${r.tool}`,
      label,
      status,
      detail: r.detail ?? r.status,
    };
  });
};

const padRight = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

const renderText = (checks: ReadonlyArray<CheckResult>): string => {
  const lines: string[] = [];
  const labelWidth = Math.max(8, ...checks.map((c) => c.label.length));
  const statusWidth = 4;
  lines.push(`${padRight("CHECK", labelWidth)}  ${padRight("STAT", statusWidth)}  DETAIL`);
  lines.push(`${"-".repeat(labelWidth)}  ${"-".repeat(statusWidth)}  ${"-".repeat(5)}`);
  for (const c of checks) {
    const mark = c.status === "pass" ? "ok  " : c.status === "fail" ? "FAIL" : c.status === "warn" ? "warn" : "skip";
    lines.push(`${padRight(c.label, labelWidth)}  ${padRight(mark, statusWidth)}  ${c.detail}`);
  }
  const failed = checks.filter((c) => c.status === "fail").length;
  const summary = failed === 0 ? "All checks passed." : `${failed} check(s) failed.`;
  lines.push("");
  lines.push(summary);
  return lines.join("\n") + "\n";
};

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check project health (.cognit/ tree, database, hooks, inbox watcher)")
    .option("--root <path>", "project root (default: $COGNIT_ROOT or current directory)")
    .option("--fix", "attempt auto-repair for safe issues (re-runs init --force, reinstalls hooks)")
    .action(async (opts: DoctorOptions, command) => {
      const globals = command.optsWithGlobals() as { root?: string };
      const projectRoot = resolveProjectRoot(opts, globals);

      const checks: CheckResult[] = [];

      // 1. isCognitProject
      const isProject = isCognitProject(projectRoot);
      checks.push({
        id: "isProject",
        label: "isCognitProject(root)",
        status: isProject ? "pass" : "fail",
        detail: isProject ? projectPaths(projectRoot).config : "no .cognit/cognit.yaml (run `cognit init`)",
      });

      // If the marker file is missing, every subsequent check is a
      // skip — there is nothing to inspect. We still probe the server
      // because the operator may be diagnosing connectivity, not state.
      if (!isProject) {
        for (const sub of COGNIT_SUBDIRS) {
          checks.push({
            id: `subdirs.${sub}`,
            label: `.cognit/${sub}/ present`,
            status: "skip",
            detail: "skipped (no project root)",
          });
        }
        checks.push({
          id: "db",
          label: "cognit.db opens + has schema",
          status: "skip",
          detail: "skipped (no project root)",
        });
        checks.push({
          id: "project",
          label: "project row exists",
          status: "skip",
          detail: "skipped (no project root)",
        });
        checks.push({ id: "inbox", label: "inbox watcher reachable (no lock file)", status: "skip", detail: "skipped (no project root)" });
        checks.push({ id: "hooks", label: "hooks installed", status: "skip", detail: "skipped (no project root)" });
      } else {
        // 2. subdirs
        checks.push(checkSubdirs(projectRoot));
        // 3 + 4. db + project row
        const { checks: dbChecks } = await checkDatabase(projectRoot);
        checks.push(...dbChecks);
        // 5. hooks
        checks.push(...checkHooks());
        // 6. inbox
        checks.push(checkInbox(projectRoot));
      }

      // 7. server (always — not gated on local project state)
      checks.push(await probeServer());

      // --fix: safe auto-repair. Re-runs the config write + hook
      // install (both idempotent). Does not touch the DB — a corrupt
      // DB is a manual reset/recovery decision.
      let fixed: string[] = [];
      if (opts.fix && isProject) {
        // Re-write cognit.yaml to defaults (preserving the project
        // name from the existing config when present).
        try {
          const paths = projectPaths(projectRoot);
          const existing = fs.readFileSync(paths.config, "utf8");
          // Cheap parse for the project name — a full YAML parse is
          // overkill for a doctor fix path.
          const match = existing.match(/^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/m);
          const name = match?.[1] ?? path.basename(projectRoot);
          // Lazy import to keep this command file dependency-light.
          const { defaultConfig } = await import("@cognit/core/config");
          const { writeConfig } = await import("../yaml-io.js");
          await writeConfig(paths.config, defaultConfig(name));
          fixed.push(`rewrote ${paths.config}`);
        } catch (e) {
          fixed.push(`config rewrite skipped: ${(e as Error).message}`);
        }
        // Hook re-install is idempotent (already-wired tools are no-ops).
        const hookResults = detectAndInstallHooks();
        const reinstalled = hookResults.filter((r) => r.status === "installed").map((r) => r.tool);
        if (reinstalled.length > 0) fixed.push(`reinstalled hooks: ${reinstalled.join(", ")}`);
      }

      const failed = checks.some((c) => c.status === "fail");

      if (getOutputMode() === "json") {
        emit("json", "doctor", {
          root: projectRoot,
          checks,
          fixed,
          ok: !failed,
        });
      } else {
        process.stdout.write(renderText(checks));
        if (fixed.length > 0) {
          process.stdout.write(`\nFixes applied:\n`);
          for (const f of fixed) process.stdout.write(`  - ${f}\n`);
        }
      }

      if (failed) process.exitCode = 1;
    });
}