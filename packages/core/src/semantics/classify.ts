/**
 * Semantic Classifier — pure rule engine (D-M5-00).
 * Tool is evidence; family is meaning.
 */
import type { ActionKind } from "./action-kinds.js";
import type {
  ClassifierInput,
  NormalizedToolSignal,
  SemanticClass,
  SessionContext,
} from "./types.js";
import type { VerificationKind } from "../state.js";

const LIFECYCLE_TOOLS = new Set([
  "stop",
  "sessionend",
  "session_end",
  "subagentstop",
  "subagent_stop",
  "stopfailure",
]);

const META_TOOLS = new Set([
  "todo_write",
  "todowrite",
  "ask_user_question",
  "askuserquestion",
  "switch_mode",
  "switchmode",
  "enter_plan_mode",
  "exit_plan_mode",
  "spawn_subagent",
  "get_command_or_subagent_output",
  "kill_command_or_subagent",
  "monitor",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
  "update_goal",
  "todo_write",
]);

const SENSE_TOOLS = new Set([
  "read_file",
  "grep",
  "list_dir",
  "glob",
  "web_search",
  "web_fetch",
  "open_page",
  "open_page_with_find",
  "x_keyword_search",
  "x_semantic_search",
  "x_thread_fetch",
  "x_user_search",
  "search_tool",
]);

const MUTATE_TOOLS = new Set([
  "write",
  "search_replace",
  "edit_notebook",
  "delete",
  "image_edit",
]);

const VERIFY_CMD =
  /(?:^|[\s;&|])(?:pnpm|npm|yarn|bun|cargo|go|pytest|python|pipenv|make|task)\s+(?:run\s+)?(?:test|lint|typecheck|build|check|vitest|jest|mocha|eslint|tsc|oxlint|fmt)\b|(?:^|[\s;&|])(?:vitest|jest|pytest|eslint|tsc|oxlint|cargo\s+test|go\s+test|make\s+test)\b/i;

const DECISION_CMD =
  /(?:^|[\s;&|])git\s+(?:commit|merge|rebase|push|tag)\b|(?:^|[\s;&|])gh\s+pr\s+(?:create|merge)\b/i;

const pathBase = (p: string | null): string => {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
};

const isDocPath = (p: string | null): boolean => {
  if (!p) return false;
  const n = p.replace(/\\/g, "/").toLowerCase();
  return (
    n.includes("/docs/") ||
    n.endsWith(".md") ||
    n.endsWith(".mdx") ||
    n.endsWith(".rst") ||
    n.endsWith(".adoc")
  );
};

const isDepPath = (p: string | null): boolean => {
  if (!p) return false;
  const base = pathBase(p).toLowerCase();
  return (
    base === "package.json" ||
    base === "pnpm-lock.yaml" ||
    base === "package-lock.json" ||
    base === "yarn.lock" ||
    base === "cargo.toml" ||
    base === "go.mod" ||
    base === "go.sum" ||
    base === "requirements.txt" ||
    base === "pyproject.toml" ||
    base === "composer.json"
  );
};

const isConfigPath = (p: string | null): boolean => {
  if (!p) return false;
  const base = pathBase(p).toLowerCase();
  return (
    base.startsWith(".") ||
    base.endsWith(".json") ||
    base.endsWith(".yaml") ||
    base.endsWith(".yml") ||
    base.endsWith(".toml") ||
    base.includes("config")
  ) && !isDepPath(p) && !isDocPath(p);
};

const goalSuggestsFix = (ctx?: SessionContext): boolean => {
  const g = (ctx?.goal ?? "").toLowerCase();
  return /\b(fix|bug|patch|hotfix|regression)\b/.test(g);
};

const inferActionKind = (
  signal: NormalizedToolSignal,
  ctx?: SessionContext,
): ActionKind => {
  if (isDocPath(signal.path)) return "documented";
  if (isDepPath(signal.path)) return "dependency_change";
  if (isConfigPath(signal.path) && signal.tool === "write") return "configured";
  // Weak: new file writes often "generated"; search_replace more often fix/refactor.
  if (signal.tool === "write" && signal.phase === "post") {
    const resp = signal.toolResponse;
    if (resp && typeof resp === "object") {
      const r = resp as Record<string, unknown>;
      // Grok write sometimes reports as create
      if (String(r["tool_output_for_prompt"] ?? "").toLowerCase().includes("created")) {
        return "generated";
      }
    }
    return "generated";
  }
  if (goalSuggestsFix(ctx) && signal.tool === "search_replace") return "applied_fix";
  if (signal.tool === "search_replace") return "other"; // honest default
  return "other";
};

const verificationKind = (cmd: string): VerificationKind => {
  const c = cmd.toLowerCase();
  if (/\blint\b|eslint|oxlint|ruff|clippy/.test(c)) return "lint";
  if (/\btypecheck\b|\btsc\b|mypy|pyright/.test(c)) return "typecheck";
  if (/\bbuild\b|compile/.test(c)) return "build";
  if (/\btest\b|vitest|jest|pytest|mocha|cargo test|go test/.test(c)) return "test";
  return "exec";
};

const actionText = (kind: ActionKind, signal: NormalizedToolSignal): string => {
  const target = signal.path ? pathBase(signal.path) : signal.command?.slice(0, 80) ?? signal.tool;
  switch (kind) {
    case "applied_fix":
      return `Applied fix in ${target}`;
    case "refactored":
      return `Refactored ${target}`;
    case "generated":
      return `Generated ${target}`;
    case "configured":
      return `Configured ${target}`;
    case "documented":
      return `Documented ${target}`;
    case "dependency_change":
      return `Updated dependencies (${target})`;
    default:
      return `Changed ${target}`;
  }
};

/**
 * Classify a normalized tool signal into zero or more semantic classes.
 * Pre-phase sense tools → ignore (avoid double noise); post-phase → observe.
 * Mutations → action (never observation).
 */
export const classifyToolSignal = (input: ClassifierInput): ReadonlyArray<SemanticClass> => {
  const { signal, sessionContext } = input;
  const toolKey = signal.tool.toLowerCase();
  const rawKey = signal.rawToolName.toLowerCase();

  // 0) Lifecycle (Stop / SessionEnd) — drain-only, no domain event
  if (
    LIFECYCLE_TOOLS.has(toolKey) ||
    LIFECYCLE_TOOLS.has(rawKey) ||
    signal.rawToolName === "" ||
    signal.rawToolName === "unknown"
  ) {
    // Empty tool + stop-like host event from source is handled by text/host later.
    // Bare unknown with no path/command is noise (lifecycle drain scripts).
    if (
      LIFECYCLE_TOOLS.has(toolKey) ||
      LIFECYCLE_TOOLS.has(rawKey) ||
      (!signal.path && !signal.command && (toolKey === "unknown" || rawKey === "unknown" || rawKey === ""))
    ) {
      return [{ family: "ignore", reason: "lifecycle or empty tool signal", confidence: 1 }];
    }
  }

  // 1) Meta / ignore
  if (META_TOOLS.has(toolKey) || META_TOOLS.has(rawKey)) {
    return [{ family: "ignore", reason: `meta tool ${signal.rawToolName}`, confidence: 1 }];
  }

  // 2) Shell: verification / decision / generic observation
  if (toolKey === "shell") {
    const cmd = signal.command ?? signal.text;
    if (signal.phase === "pre") {
      // Intent only — domain events fire on post when we have outcome.
      if (VERIFY_CMD.test(cmd) || DECISION_CMD.test(cmd)) {
        return [{ family: "ignore", reason: "pre shell; wait for outcome", confidence: 0.9 }];
      }
      return [{ family: "ignore", reason: "pre shell noise", confidence: 0.8 }];
    }
    if (DECISION_CMD.test(cmd)) {
      return [
        {
          family: "decision",
          text: cmd.slice(0, 200),
          confidence: 0.85,
        },
      ];
    }
    if (VERIFY_CMD.test(cmd)) {
      const kind = verificationKind(cmd);
      const exit = signal.exitCode;
      const out: SemanticClass[] = [
        {
          family: "verification",
          phase: "start",
          kind,
          command: cmd,
          confidence: 0.9,
        },
      ];
      // PostToolUse means the process finished — always emit outcome so
      // state does not stick on verification_started. Missing exit/ok
      // defaults to success (exit 0); explicit ok:false → exit 1.
      const failed =
        signal.ok === false || (exit !== null && exit !== 0);
      const outcomeExit: number =
        exit !== null ? exit : failed ? 1 : 0;
      out.push({
        family: "verification",
        phase: "outcome",
        kind,
        command: cmd,
        exit_code: outcomeExit,
        confidence: exit !== null || signal.ok !== null ? 0.9 : 0.65,
      });
      return out;
    }
    // Generic shell → observation of what ran
    return [
      {
        family: "observation",
        text: signal.text || `ran: ${cmd.slice(0, 200)}`,
        confidence: 0.7,
      },
    ];
  }

  // 3) Mutations → Action
  if (MUTATE_TOOLS.has(toolKey)) {
    if (signal.phase === "pre") {
      return [{ family: "ignore", reason: "pre mutation; wait for post", confidence: 0.9 }];
    }
    const kind = inferActionKind(signal, sessionContext);
    return [
      {
        family: "action",
        text: actionText(kind, signal),
        action_kind: kind,
        confidence: kind === "other" ? 0.55 : 0.8,
      },
    ];
  }

  // 4) Sense → Observation (post only)
  if (SENSE_TOOLS.has(toolKey)) {
    if (signal.phase === "pre") {
      return [{ family: "ignore", reason: "pre read noise", confidence: 0.9 }];
    }
    return [
      {
        family: "observation",
        text: signal.text || `observed ${signal.path ?? signal.tool}`,
        confidence: 0.9,
      },
    ];
  }

  // 5) Default: post → weak observation; pre → ignore
  if (signal.phase === "pre") {
    return [{ family: "ignore", reason: "unknown pre tool", confidence: 0.5 }];
  }
  return [
    {
      family: "observation",
      text: signal.text || `tool ${signal.rawToolName}`,
      confidence: 0.4,
    },
  ];
};
