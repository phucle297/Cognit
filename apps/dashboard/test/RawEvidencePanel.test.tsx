/**
 * D-M6-00 — Raw evidence panel unit tests (real extract + fetch wiring).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  RawEvidencePanel,
  extractToolEvidence,
  parseRawResponse,
} from "@/components/RawEvidencePanel";

describe("extractToolEvidence", () => {
  it("reads search_replace old/new from wire envelope", () => {
    const ev = extractToolEvidence({
      type: "raw_tool_signal",
      payload: {
        tool: "search_replace",
        path: "/src/a.ts",
        tool_input: { old_string: "foo", new_string: "bar", file_path: "/src/a.ts" },
        tool_response: { ok: true },
      },
    });
    expect(ev.tool).toBe("search_replace");
    expect(ev.path).toBe("/src/a.ts");
    expect(ev.oldString).toBe("foo");
    expect(ev.newString).toBe("bar");
  });
});

describe("parseRawResponse", () => {
  it("maps 404 to empty message", async () => {
    const res = new Response("{}", { status: 404 });
    const r = await parseRawResponse(res);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.message).toMatch(/No raw envelope/);
    }
  });

  it("parses envelope data with object envelope (not double-encoded)", async () => {
    const body = {
      version: 1,
      kind: "events.raw",
      data: {
        raw_event: {
          id: "01HZZZZZZZZZZZZZZZZZZZZZZ3",
          type: "raw_tool_signal",
          domain_event_count: 1,
          source_tool: "search_replace",
          source_command: "PostToolUse",
          envelope: { type: "raw_tool_signal", payload: { tool: "search_replace" } },
        },
        domain_event_id: "01HZZZZZZZZZZZZZZZZZZZZZZ3",
      },
    };
    const res = new Response(JSON.stringify(body), { status: 200 });
    const r = await parseRawResponse(res);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.data.raw_event.envelope).toBe("object");
      expect(r.data.raw_event.source_tool).toBe("search_replace");
    }
  });
});

describe("RawEvidencePanel", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("lazy fetches and renders tool + old/new", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: 1,
          kind: "events.raw",
          data: {
            raw_event: {
              id: "01HZZZZZZZZZZZZZZZZZZZZZZ3",
              type: "raw_tool_signal",
              domain_event_count: 1,
              source_tool: "search_replace",
              source_command: "PostToolUse",
              envelope: {
                payload: {
                  tool: "search_replace",
                  path: "/x.ts",
                  tool_input: { old_string: "AAA", new_string: "BBB" },
                },
              },
            },
            domain_event_id: "01HZZZZZZZZZZZZZZZZZZZZZZ3",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    render(<RawEvidencePanel eventId="01HZZZZZZZZZZZZZZZZZZZZZZ3" />);
    expect(await screen.findByTestId("raw-evidence-panel")).toBeInTheDocument();
    expect(screen.getByTestId("raw-evidence-tool")).toHaveTextContent("search_replace");
    expect(screen.getByTestId("raw-evidence-old")).toHaveTextContent("AAA");
    expect(screen.getByTestId("raw-evidence-new")).toHaveTextContent("BBB");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/events/01HZZZZZZZZZZZZZZZZZZZZZZ3/raw");
  });

  it("shows empty state on 404", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("{}", { status: 404 }),
    ) as unknown as typeof fetch;
    render(<RawEvidencePanel eventId="01HZZZZZZZZZZZZZZZZZZZZZZ9" />);
    await waitFor(() => {
      expect(screen.getByTestId("raw-evidence-empty")).toBeInTheDocument();
    });
  });
});
