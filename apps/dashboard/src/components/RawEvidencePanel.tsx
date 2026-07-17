/**
 * D-M6-00 — Raw evidence panel for Timeline event sheet.
 * Lazy-fetches GET /api/events/:id/raw and renders structured tool IO.
 */
import { useEffect, useState, type JSX } from "react";

export type RawEvidenceApiBody = {
  readonly raw_event: {
    readonly id: string;
    readonly type: string;
    readonly domain_event_count: number;
    readonly source_tool: string | null;
    readonly source_command: string | null;
    readonly envelope: unknown;
  };
  readonly domain_event_id: string | null;
};

export type RawPanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty"; message: string }
  | { status: "error"; message: string }
  | { status: "ok"; data: RawEvidenceApiBody };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/** Extract tool_input / tool_response fields for structured display. */
export const extractToolEvidence = (
  envelope: unknown,
): {
  tool: string | null;
  path: string | null;
  oldString: string | null;
  newString: string | null;
  toolResponse: unknown;
} => {
  const env = asRecord(envelope);
  const payload = env ? asRecord(env["payload"]) : null;
  if (!payload) {
    return { tool: null, path: null, oldString: null, newString: null, toolResponse: null };
  }
  const tool = typeof payload["tool"] === "string" ? payload["tool"] : null;
  const path =
    typeof payload["path"] === "string"
      ? payload["path"]
      : (() => {
          const ti = asRecord(payload["tool_input"]);
          return ti && typeof ti["file_path"] === "string" ? ti["file_path"] : null;
        })();
  const toolInput = asRecord(payload["tool_input"]);
  const oldString =
    toolInput && typeof toolInput["old_string"] === "string" ? toolInput["old_string"] : null;
  const newString =
    toolInput && typeof toolInput["new_string"] === "string" ? toolInput["new_string"] : null;
  return {
    tool,
    path,
    oldString,
    newString,
    toolResponse: payload["tool_response"] ?? null,
  };
};

/** Parse API envelope `{ version, kind, data }` or bare data. */
export const parseRawResponse = async (
  res: Response,
): Promise<{ ok: true; data: RawEvidenceApiBody } | { ok: false; status: number; message: string }> => {
  if (res.status === 404) {
    return {
      ok: false,
      status: 404,
      message: "No raw envelope stored (pre-M6 or non-tool event)",
    };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, message: `HTTP ${res.status}` };
  }
  const json = (await res.json()) as { data?: RawEvidenceApiBody } & RawEvidenceApiBody;
  const data = (json.data ?? json) as RawEvidenceApiBody;
  if (!data?.raw_event) {
    return { ok: false, status: res.status, message: "malformed raw response" };
  }
  return { ok: true, data };
};

export const RawEvidencePanel = ({ eventId }: { readonly eventId: string }): JSX.Element => {
  const [state, setState] = useState<RawPanelState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const res = await fetch(`/api/events/${eventId}/raw`);
        const parsed = await parseRawResponse(res);
        if (cancelled) return;
        if (!parsed.ok) {
          setState(
            parsed.status === 404
              ? { status: "empty", message: parsed.message }
              : { status: "error", message: parsed.message },
          );
          return;
        }
        setState({ status: "ok", data: parsed.data });
      } catch (e) {
        if (!cancelled) {
          setState({ status: "error", message: String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (state.status === "idle" || state.status === "loading") {
    return (
      <div data-testid="raw-evidence-loading" className="text-sm text-muted-foreground">
        Loading raw evidence…
      </div>
    );
  }
  if (state.status === "empty") {
    return (
      <div data-testid="raw-evidence-empty" className="text-sm text-muted-foreground">
        {state.message}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div data-testid="raw-evidence-error" className="text-sm text-destructive">
        {state.message}
      </div>
    );
  }

  const { raw_event: raw } = state.data;
  const evidence = extractToolEvidence(raw.envelope);

  return (
    <div className="flex flex-col gap-3" data-testid="raw-evidence-panel">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Tool</div>
          <div data-testid="raw-evidence-tool">{evidence.tool ?? raw.source_tool ?? "—"}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Command</div>
          <div>{raw.source_command ?? "—"}</div>
        </div>
        <div className="col-span-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Path</div>
          <div className="break-all font-mono text-xs">{evidence.path ?? "—"}</div>
        </div>
      </div>
      {evidence.oldString !== null || evidence.newString !== null ? (
        <div className="grid gap-2">
          {evidence.oldString !== null ? (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">old_string</div>
              <pre
                data-testid="raw-evidence-old"
                className="mt-1 max-h-40 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs"
              >
                {evidence.oldString}
              </pre>
            </div>
          ) : null}
          {evidence.newString !== null ? (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">new_string</div>
              <pre
                data-testid="raw-evidence-new"
                className="mt-1 max-h-40 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs"
              >
                {evidence.newString}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
      {evidence.toolResponse !== null && evidence.toolResponse !== undefined ? (
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">tool_response</div>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs">
            {JSON.stringify(evidence.toolResponse, null, 2)}
          </pre>
        </div>
      ) : null}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Full envelope JSON</summary>
        <pre
          data-testid="raw-evidence-json"
          className="mt-1 max-h-64 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs"
        >
          {JSON.stringify(raw.envelope, null, 2)}
        </pre>
      </details>
    </div>
  );
};
