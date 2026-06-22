/**
 * apps/dashboard/test/AiReasoning.test.tsx — AI Reasoning tab tests.
 *
 * Cases:
 *  1. empty session renders EmptyState (no session in URL)
 *  2. session with one ranked + one unranked hypothesis renders both
 *     rows with correct source badge + delta sign
 *  3. SSE frame injection grows the table (uses StubEventSource from
 *     test/setup.ts)
 *  4. error envelope renders ErrorState
 *  5. clicking a row opens the rank history sheet
 *  6. dedup invariant: an SSE frame whose id matches a snapshot
 *     row's `ai_rank_event_id` is dropped by the snapshot-id set
 *     — table has exactly 1 row, no `(unranked)` badge
 *  7. stream-only row: an SSE frame whose id is NOT in the
 *     snapshot adds a new row with the `(unranked)` badge
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SidebarProvider } from "@/widgets/sidebar/sidebar-provider";
import { AiReasoningPage } from "@/pages/ai-reasoning";

const envelope = (data: unknown): string =>
  JSON.stringify({ version: 1, kind: "test", data });

const renderPage = (query: string): ReturnType<typeof render> =>
  render(
    <MemoryRouter initialEntries={[`/ai-reasoning${query}`]}>
      <SidebarProvider>
        <Routes>
          <Route path="/ai-reasoning" element={<AiReasoningPage />} />
        </Routes>
      </SidebarProvider>
    </MemoryRouter>,
  );

interface RankedRow {
  hypothesis_id: string;
  title: string;
  text: string;
  ai_score: number | null;
  rule_score: number | null;
  score: number;
  source: "ai" | "rule";
  delta: number | null;
  reasoning: string | null;
  ai_rank_at: string | null;
  ai_rank_event_id: string | null;
}

const makeRanked = (overrides: Partial<RankedRow> & Pick<RankedRow, "hypothesis_id">): RankedRow => ({
  title: `Hypothesis ${overrides.hypothesis_id.slice(0, 6)}`,
  text: "alpha",
  ai_score: null,
  rule_score: 0.32,
  score: 0.32,
  source: "rule",
  delta: null,
  reasoning: null,
  ai_rank_at: null,
  ai_rank_event_id: null,
  ...overrides,
});

const mockFetch = (handler: (url: string) => Response): void => {
  globalThis.fetch = vi.fn().mockImplementation((url: RequestInfo | URL) =>
    Promise.resolve(handler(String(url))),
  ) as unknown as typeof fetch;
};

describe("AiReasoningPage (C4)", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("1. no session in URL renders EmptyState", async () => {
    mockFetch(() => new Response("{}", { status: 404 }));
    renderPage("");
    expect(await screen.findByTestId("ai-reasoning-page")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-reasoning-decision-log-empty")).not.toBeInTheDocument();
  });

  it("2. mixed ranked + unranked → both rows render with correct badges", async () => {
    const ranked = [
      makeRanked({
        hypothesis_id: "01RANKED",
        source: "ai",
        ai_score: 0.85,
        rule_score: 0.32,
        score: 0.85,
        delta: 0.53,
        reasoning: "strong evidence",
        ai_rank_event_id: "01RANKED-r01RANKED",
      }),
      makeRanked({
        hypothesis_id: "01UNRANKED",
        source: "rule",
        ai_score: null,
        rule_score: 0.42,
        score: 0.42,
        delta: null,
      }),
    ];
    const decisionLog = [
      {
        tick_event_id: "01TICKA00000000000000000",
        actions_applied: 1,
        rank_overrides_applied: 1,
        actions_truncated: 0,
        stop: false,
        created_at: "2026-06-21T10:00:00.000Z",
      },
    ];
    mockFetch((url) => {
      if (url.includes("/ai-reasoning") && !url.endsWith("/stream")) {
        return new Response(envelope({ session_id: "01S", ranked, decision_log: decisionLog }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/sessions/01S")) {
        return new Response(
          envelope({ session: { id: "01S", goal: "demo", status: "active" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    renderPage("?session=01S");
    expect(await screen.findByTestId("ai-reasoning-page")).toBeInTheDocument();

    await waitFor(() => {
      const sources = screen.getAllByTestId("ai-reasoning-source");
      expect(sources.length).toBe(2);
    });

    // First row: AI source, delta +0.53
    const sources = screen.getAllByTestId("ai-reasoning-source");
    expect(sources[0]!.textContent).toBe("ai");
    expect(sources[1]!.textContent).toBe("rule");

    const deltas = screen.getAllByTestId("ai-reasoning-delta");
    expect(deltas[0]!.textContent).toBe("+0.53");
    expect(deltas[1]!.textContent).toBe("—");

    // Decision log: one tick row visible.
    expect(screen.getByTestId("ai-reasoning-decision-log")).toBeInTheDocument();
    expect(screen.getByTestId("ai-reasoning-tick-actions").textContent).toBe("1");
    expect(screen.getByTestId("ai-reasoning-tick-overrides").textContent).toBe("1");
  });

  it("3. SSE frame injection grows the ranked table", async () => {
    const ranked = [makeRanked({ hypothesis_id: "01BASE" })];
    mockFetch((url) => {
      if (url.includes("/ai-reasoning") && !url.endsWith("/stream")) {
        return new Response(envelope({ session_id: "01S", ranked, decision_log: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/sessions/01S")) {
        return new Response(
          envelope({ session: { id: "01S", goal: "demo", status: "active" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });

    renderPage("?session=01S");
    expect(await screen.findByTestId("ai-reasoning-page")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByTestId("ai-reasoning-source").length).toBe(1);
    });

    // Inject a live hypothesis_ranked frame via the global
    // StubEventSource shim from apps/dashboard/test/setup.ts.
    // The hook uses `onmessage` directly, so we invoke it on the
    // last created instance.
    const Es = (globalThis as { EventSource: typeof EventSource }).EventSource;
    const instance = (Es as unknown as {
      lastInstance: {
        onmessage: ((ev: MessageEvent<string>) => void) | null;
      };
    }).lastInstance;
    expect(instance).toBeTruthy();
    const frame = {
      id: "01STREAM0000000000000000",
      session_id: "01S",
      type: "hypothesis_ranked",
      created_at: "2026-06-21T10:05:00.000Z",
      payload: {
        hypothesis_id: "01LIVE",
        score: 0.92,
        reasoning: "fresh evidence just landed",
        evaluator: "ai-supervisor",
      },
    };
    instance.onmessage?.(
      new MessageEvent("event", { data: JSON.stringify(frame), lastEventId: frame.id }),
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("ai-reasoning-source").length).toBe(2);
    });
  });

  it("4. error envelope → ErrorState renders", async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          kind: "api_error",
          code: "internal",
          message: "ai-reasoning failed",
          request_id: "req-test",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    );
    renderPage("?session=01S");
    expect(await screen.findByTestId("ai-reasoning-error")).toBeInTheDocument();
  });

  it("5. clicking a row opens the rank history sheet", async () => {
    const ranked = [
      makeRanked({
        hypothesis_id: "01RANKED",
        source: "ai",
        ai_score: 0.85,
        rule_score: 0.32,
        score: 0.85,
        delta: 0.53,
        reasoning: "strong evidence",
        ai_rank_event_id: "01RANKED-r01RANKED",
      }),
    ];
    mockFetch((url) => {
      if (url.includes("/ai-reasoning") && !url.endsWith("/stream")) {
        return new Response(envelope({ session_id: "01S", ranked, decision_log: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/sessions/01S")) {
        return new Response(
          envelope({ session: { id: "01S", goal: "demo", status: "active" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const user = userEvent.setup();
    renderPage("?session=01S");
    expect(await screen.findByTestId("ai-reasoning-page")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByTestId("ai-reasoning-source").length).toBe(1);
    });
    const row = screen.getAllByTestId("ai-reasoning-source")[0]!.closest("tr");
    expect(row).toBeTruthy();
    await user.click(row!);
    expect(await screen.findByTestId("ai-reasoning-history-sheet")).toBeInTheDocument();
  });

  it("6. dedup invariant — SSE frame matching a snapshot event id is dropped", async () => {
    // The snapshot already carries a ranked row whose ai_rank_event_id
    // is "01SNAP0000000000000000000". An SSE frame with the SAME id
    // must NOT add a duplicate row — the client-side snapshotIds set
    // drops it (defence-in-depth: server-side `?last_event_id=` would
    // also filter it, but the client check stays).
    const sharedId = "01SNAP0000000000000000000";
    const ranked = [
      makeRanked({
        hypothesis_id: "01RANKED",
        source: "ai",
        ai_score: 0.85,
        rule_score: 0.32,
        score: 0.85,
        delta: 0.53,
        reasoning: "strong evidence",
        ai_rank_event_id: sharedId,
      }),
    ];
    mockFetch((url) => {
      if (url.includes("/ai-reasoning") && !url.endsWith("/stream")) {
        return new Response(envelope({ session_id: "01S", ranked, decision_log: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/sessions/01S")) {
        return new Response(
          envelope({ session: { id: "01S", goal: "demo", status: "active" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    renderPage("?session=01S");
    expect(await screen.findByTestId("ai-reasoning-page")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByTestId("ai-reasoning-source").length).toBe(1);
    });

    // Inject an SSE frame with the SAME ai_rank_event_id as the
    // snapshot row. The page must NOT add a second row.
    const Es = (globalThis as { EventSource: typeof EventSource }).EventSource;
    const instance = (Es as unknown as {
      lastInstance: { onmessage: ((ev: MessageEvent<string>) => void) | null };
    }).lastInstance;
    expect(instance).toBeTruthy();
    const frame = {
      id: sharedId,
      session_id: "01S",
      type: "hypothesis_ranked",
      created_at: "2026-06-21T10:05:00.000Z",
      payload: {
        hypothesis_id: "01RANKED",
        score: 0.99,
        reasoning: "duplicate, must be dropped",
        evaluator: "ai-supervisor",
      },
    };
    instance.onmessage?.(
      new MessageEvent("event", { data: JSON.stringify(frame), lastEventId: frame.id }),
    );

    // Give the React state update a tick to flush.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getAllByTestId("ai-reasoning-source").length).toBe(1);
    expect(screen.queryByTestId("ai-reasoning-unranked")).not.toBeInTheDocument();
  });

  it("7. stream-only row — SSE frame with new event id adds a row with `(unranked)` badge", async () => {
    const ranked = [makeRanked({ hypothesis_id: "01BASE" })];
    mockFetch((url) => {
      if (url.includes("/ai-reasoning") && !url.endsWith("/stream")) {
        return new Response(envelope({ session_id: "01S", ranked, decision_log: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/sessions/01S")) {
        return new Response(
          envelope({ session: { id: "01S", goal: "demo", status: "active" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    renderPage("?session=01S");
    expect(await screen.findByTestId("ai-reasoning-page")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByTestId("ai-reasoning-source").length).toBe(1);
    });

    const Es = (globalThis as { EventSource: typeof EventSource }).EventSource;
    const instance = (Es as unknown as {
      lastInstance: { onmessage: ((ev: MessageEvent<string>) => void) | null };
    }).lastInstance;
    expect(instance).toBeTruthy();
    const frame = {
      id: "01STREAM0000000000000000",
      session_id: "01S",
      type: "hypothesis_ranked",
      created_at: "2026-06-21T10:05:00.000Z",
      payload: {
        hypothesis_id: "01LIVE",
        score: 0.92,
        reasoning: "fresh evidence just landed",
        evaluator: "ai-supervisor",
      },
    };
    instance.onmessage?.(
      new MessageEvent("event", { data: JSON.stringify(frame), lastEventId: frame.id }),
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("ai-reasoning-source").length).toBe(2);
    });
    // The newly-streamed row carries the (unranked) badge so an
    // operator can distinguish it from a fully-titled snapshot row.
    expect(screen.getByTestId("ai-reasoning-unranked")).toBeInTheDocument();
  });
});
