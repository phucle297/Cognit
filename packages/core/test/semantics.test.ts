import { describe, expect, it } from "vitest";
import {
  classifyToolSignal,
  normalizeToolSignal,
  produceFromClasses,
  semanticPipeline,
} from "../src/semantics/index.js";
import { reduce } from "../src/reducer.js";
import { emptySessionState, type ReducerEvent } from "../src/state.js";

const base = emptySessionState({
  session_id: "01SESSION000000000000000001",
  project_id: "01PROJECT000000000000000001",
  goal: "fix login bug",
});

const mkEvent = (partial: Partial<ReducerEvent> & { type: string; id: string }): ReducerEvent => ({
  id: partial.id,
  project_id: base.project_id,
  session_id: base.session_id,
  actor_id: "01ACTOR00000000000000000001",
  type: partial.type,
  version: "1.3.0",
  payload_json: partial.payload_json ?? "{}",
  source_json: null,
  artifact_refs_json: null,
  causation_id: null,
  correlation_id: null,
  confidence: null,
  parent_verification_id: null,
  linked_hypothesis_id: null,
  created_at: partial.created_at ?? "2026-07-16T00:00:00.000Z",
});

describe("normalizeToolSignal", () => {
  it("maps Claude Edit → search_replace canonical", () => {
    const s = normalizeToolSignal({
      phase: "post",
      host: "claude-code",
      tool: "Edit",
      path: "/tmp/a.ts",
      text: "tool Edit returned",
    });
    expect(s.tool).toBe("search_replace");
    expect(s.rawToolName).toBe("Edit");
    expect(s.path).toBe("/tmp/a.ts");
  });

  it("extracts path from toolInput", () => {
    const s = normalizeToolSignal({
      phase: "post",
      tool: "write",
      toolInput: { file_path: "/repo/src/x.ts", content: "hi" },
    });
    expect(s.path).toBe("/repo/src/x.ts");
  });
});

describe("classifyToolSignal", () => {
  it("ignores pre-read and classifies post-read as observation", () => {
    const pre = classifyToolSignal({
      signal: normalizeToolSignal({ phase: "pre", tool: "read_file", path: "/a.ts" }),
    });
    expect(pre[0]?.family).toBe("ignore");

    const post = classifyToolSignal({
      signal: normalizeToolSignal({
        phase: "post",
        tool: "read_file",
        path: "/a.ts",
        text: "read a.ts",
      }),
    });
    expect(post).toEqual([
      expect.objectContaining({ family: "observation", text: expect.stringContaining("a") }),
    ]);
  });

  it("classifies write as action, not observation", () => {
    const classes = classifyToolSignal({
      signal: normalizeToolSignal({
        phase: "post",
        tool: "write",
        path: "/repo/src/user.ts",
        text: "tool write → user.ts",
      }),
    });
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatchObject({ family: "action", action_kind: "generated" });
  });

  it("classifies docs path as documented action", () => {
    const classes = classifyToolSignal({
      signal: normalizeToolSignal({
        phase: "post",
        tool: "search_replace",
        path: "/repo/docs/guide.md",
      }),
    });
    expect(classes[0]).toMatchObject({ family: "action", action_kind: "documented" });
  });

  it("classifies pnpm test as verification", () => {
    const classes = classifyToolSignal({
      signal: normalizeToolSignal({
        phase: "post",
        tool: "run_terminal_command",
        command: "pnpm test",
        exitCode: 0,
        ok: true,
      }),
    });
    expect(classes.map((c) => c.family)).toEqual(["verification", "verification"]);
    expect(classes[0]).toMatchObject({ phase: "start", kind: "test" });
    expect(classes[1]).toMatchObject({ phase: "outcome" });
  });

  it("classifies git commit as decision", () => {
    const classes = classifyToolSignal({
      signal: normalizeToolSignal({
        phase: "post",
        tool: "Bash",
        command: 'git commit -m "fix"',
        exitCode: 0,
      }),
    });
    expect(classes[0]?.family).toBe("decision");
  });

  it("ignores todo_write", () => {
    const classes = classifyToolSignal({
      signal: normalizeToolSignal({ phase: "post", tool: "todo_write" }),
    });
    expect(classes[0]?.family).toBe("ignore");
  });

  it("uses goal fix hint for search_replace → applied_fix", () => {
    const classes = classifyToolSignal({
      signal: normalizeToolSignal({
        phase: "post",
        tool: "search_replace",
        path: "/repo/src/api.ts",
      }),
      sessionContext: { goal: "fix login bug" },
    });
    expect(classes[0]).toMatchObject({ family: "action", action_kind: "applied_fix" });
  });
});

describe("semanticPipeline bug-fix session", () => {
  it("produces clean meaning timeline (no hypothesis spam)", () => {
    const goal = "fix login bug";
    const steps = [
      { phase: "post" as const, tool: "read_file", path: "/src/user.ts", text: "read user.ts" },
      { phase: "post" as const, tool: "grep", text: "grep error path" },
      {
        phase: "post" as const,
        tool: "search_replace",
        path: "/src/user.ts",
        text: "edit user.ts",
      },
      {
        phase: "post" as const,
        tool: "search_replace",
        path: "/src/api.ts",
        text: "edit api.ts",
      },
      {
        phase: "post" as const,
        tool: "run_terminal_command",
        command: "pnpm test",
        exitCode: 0,
        ok: true,
      },
      {
        phase: "post" as const,
        tool: "run_terminal_command",
        command: "pnpm lint",
        exitCode: 0,
        ok: true,
      },
      {
        phase: "post" as const,
        tool: "Bash",
        command: 'git commit -m "fix login"',
        exitCode: 0,
      },
    ];

    const events = steps.flatMap((s) =>
      semanticPipeline({ ...s, host: "grok" }, { goal }),
    );
    const types = events.map((e) => e.type);

    expect(types).toEqual([
      "observation_recorded",
      "observation_recorded",
      "action_recorded",
      "action_recorded",
      "verification_started",
      "verification_passed",
      "verification_started",
      "verification_passed",
      "decision_proposed",
    ]);
    expect(types.includes("hypothesis_created")).toBe(false);
    expect(events.filter((e) => e.type === "action_recorded").every((e) => e.payload["action_kind"])).toBe(
      true,
    );
  });

  it("folds action_recorded into state.actions", () => {
    const produced = semanticPipeline(
      {
        phase: "post",
        tool: "write",
        path: "/src/x.ts",
        text: "generated x",
      },
      { goal: "scaffold" },
    );
    expect(produced[0]?.type).toBe("action_recorded");
    const ev = mkEvent({
      id: "01ACTION0000000000000000001",
      type: "action_recorded",
      payload_json: JSON.stringify(produced[0]!.payload),
    });
    const s = reduce([ev], base);
    expect(s.actions).toHaveLength(1);
    expect(s.actions[0]?.action_kind).toBe("generated");
    expect(s.observations).toHaveLength(0);
  });
});

describe("produceFromClasses", () => {
  it("drops ignore", () => {
    const signal = normalizeToolSignal({ phase: "post", tool: "todo_write" });
    const classes = classifyToolSignal({ signal });
    expect(produceFromClasses(classes, { signal })).toEqual([]);
  });
});

describe("Phase 4 soft refine", () => {
  it("upgrades search_replace other → applied_fix from evidence text", () => {
    const events = semanticPipeline(
      {
        phase: "post",
        tool: "search_replace",
        path: "/src/auth.ts",
        text: "tool search_replace → auth.ts",
        toolInput: {
          old_string: "const x = null",
          new_string: "const x = user ?? null // fix null deref bug",
        },
      },
      { goal: "improve auth" },
    );
    expect(events[0]?.type).toBe("action_recorded");
    expect(events[0]?.payload["action_kind"]).toBe("applied_fix");
  });

  it("upgrades to refactored from evidence keywords", () => {
    const events = semanticPipeline({
      phase: "post",
      tool: "search_replace",
      path: "/src/util.ts",
      toolInput: {
        old_string: "function a() {}",
        new_string: "// refactor: extract helper\nfunction helper() {}\nfunction a() { helper(); }",
      },
    });
    expect(events[0]?.payload["action_kind"]).toBe("refactored");
  });

  it("truncates large content in action evidence", () => {
    const big = "x".repeat(5000);
    const events = semanticPipeline({
      phase: "post",
      tool: "write",
      path: "/src/big.ts",
      toolInput: { file_path: "/src/big.ts", content: big },
      text: "tool write → big.ts",
    });
    const ev = events[0]?.payload["evidence"] as Record<string, unknown>;
    expect(ev["truncated"]).toBe(true);
    expect(Number(ev["content_chars"])).toBeGreaterThan(4000);
    expect(String(ev["excerpt"] ?? "").length).toBeLessThanOrEqual(800);
  });

  it("ignores lifecycle empty tool signals", () => {
    const events = semanticPipeline({
      phase: "post",
      tool: "unknown",
      text: "session end",
    });
    expect(events).toEqual([]);
  });

  it("softClassifier can override low-confidence action", () => {
    const events = semanticPipeline(
      {
        phase: "post",
        tool: "search_replace",
        path: "/src/a.ts",
        toolInput: { old_string: "a", new_string: "b" },
      },
      undefined,
      {
        softClassifier: () => [
          {
            family: "action",
            text: "Applied fix in a.ts",
            action_kind: "applied_fix",
            confidence: 0.95,
          },
        ],
      },
    );
    expect(events[0]?.payload["action_kind"]).toBe("applied_fix");
  });
});
