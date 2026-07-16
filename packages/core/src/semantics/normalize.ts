/**
 * Normalizer: host-shaped raw tool data → NormalizedToolSignal (D-M5-00).
 * Pure. No I/O.
 */
import type { NormalizedToolSignal } from "./types.js";

const CANONICAL_TOOL: Readonly<Record<string, string>> = {
  // Claude Code
  Edit: "search_replace",
  MultiEdit: "search_replace",
  Write: "write",
  Read: "read_file",
  Bash: "shell",
  Grep: "grep",
  Glob: "glob",
  LS: "list_dir",
  // Grok / Cursor style
  search_replace: "search_replace",
  write: "write",
  read_file: "read_file",
  run_terminal_command: "shell",
  grep: "grep",
  list_dir: "list_dir",
  // Codex / generic
  shell: "shell",
  bash: "shell",
};

export interface NormalizeRawInput {
  readonly phase?: string | null;
  readonly host?: string | null;
  readonly tool?: string | null;
  readonly rawToolName?: string | null;
  readonly path?: string | null;
  readonly command?: string | null;
  readonly text?: string | null;
  readonly toolInput?: unknown;
  readonly toolResponse?: unknown | null;
  readonly exitCode?: number | null;
  readonly ok?: boolean | null;
  /** Full raw envelope payload / hook JSON for multi-path extract. */
  readonly raw?: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v !== "null" ? v : null;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const pickPath = (input: unknown, response: unknown): string | null => {
  for (const src of [input, response]) {
    const o = asRecord(src);
    if (!o) continue;
    for (const k of [
      "file_path",
      "filePath",
      "path",
      "target_file",
      "targetFile",
      "notebook_path",
      "absolute_path",
    ]) {
      const p = str(o[k]);
      if (p) return p;
    }
  }
  return null;
};

const pickCommand = (input: unknown): string | null => {
  const o = asRecord(input);
  if (!o) return null;
  return str(o["command"]) ?? str(o["cmd"]);
};

const pickExit = (response: unknown): number | null => {
  const o = asRecord(response);
  if (!o) return null;
  return num(o["exit_code"]) ?? num(o["exitCode"]) ?? num(o["code"]);
};

const pickOk = (response: unknown, exit: number | null): boolean | null => {
  const o = asRecord(response);
  if (o) {
    if (typeof o["ok"] === "boolean") return o["ok"];
    if (typeof o["success"] === "boolean") return o["success"];
  }
  if (exit !== null) return exit === 0;
  return null;
};

const normalizePhase = (p: string | null | undefined): "pre" | "post" | "failure" => {
  const k = (p ?? "post").toLowerCase().replace(/[^a-z]/g, "");
  if (k.includes("pre") || k.includes("before")) return "pre";
  if (k.includes("fail")) return "failure";
  return "post";
};

const canonicalTool = (raw: string): string => {
  if (CANONICAL_TOOL[raw]) return CANONICAL_TOOL[raw]!;
  const lower = raw.toLowerCase();
  for (const [k, v] of Object.entries(CANONICAL_TOOL)) {
    if (k.toLowerCase() === lower) return v;
  }
  return lower || "unknown";
};

/**
 * Build a NormalizedToolSignal from producer/hook fields.
 * Accepts either structured fields or a raw object (envelope payload / hook stdin).
 */
export const normalizeToolSignal = (input: NormalizeRawInput): NormalizedToolSignal => {
  const raw = asRecord(input.raw);
  const toolInput =
    input.toolInput ??
    raw?.["tool_input"] ??
    raw?.["toolInput"] ??
    raw?.["arguments"] ??
    {};
  const toolResponse =
    input.toolResponse !== undefined
      ? input.toolResponse
      : (raw?.["tool_response"] ?? raw?.["toolResponse"] ?? raw?.["toolResult"] ?? null);

  const rawName =
    str(input.rawToolName) ??
    str(input.tool) ??
    str(raw?.["tool"]) ??
    str(raw?.["tool_name"]) ??
    str(raw?.["toolName"]) ??
    "unknown";

  const path =
    str(input.path) ??
    pickPath(toolInput, toolResponse) ??
    null;
  const command = str(input.command) ?? pickCommand(toolInput);
  const exitCode = input.exitCode ?? pickExit(toolResponse);
  const ok = input.ok ?? pickOk(toolResponse, exitCode);

  const text =
    str(input.text) ??
    str(raw?.["text"]) ??
    (path ? `${rawName} ${path}` : command ? `${rawName}: ${command.slice(0, 200)}` : rawName);

  const phase = normalizePhase(
    input.phase ?? str(raw?.["phase"]) ?? str(raw?.["hook_event_name"]) ?? str(raw?.["hookEventName"]),
  );

  return {
    phase,
    host: str(input.host) ?? str(raw?.["host"]) ?? "agent",
    tool: canonicalTool(rawName),
    rawToolName: rawName,
    path,
    command,
    text,
    toolInput,
    toolResponse,
    exitCode,
    ok,
  };
};
