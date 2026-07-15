/**
 * apps/dashboard/test/Timeline.test.tsx — redesigned page tests.
 *
 * Cases:
 *  1. Renders DataTable rows from the initial GET
 *  2. Type chip filter narrows the rows
 *  3. Actor input applies filter after 250ms debounce
 *  4. EmptyState renders when filter matches nothing
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { TimelinePage } from "@/pages/timeline";

const envelope = (data: unknown): string =>
  JSON.stringify({ version: 1, kind: "test", data });

const makeEvent = (i: number): {
  id: string;
  kind: string;
  session_id: string;
  actor: string;
  ts: string;
  payload: unknown;
} => ({
  id: `01EV${String(i).padStart(22, "0")}`,
  kind: i % 2 === 0 ? "tool_call" : "decision",
  session_id: "01TEST",
  actor: i % 2 === 0 ? "alice" : "bob",
  ts: "2026-06-17T10:00:00.000Z",
  payload: { tool: "shell", args: ["ls"] },
});

const renderTimeline = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter initialEntries={["/timeline?session=01TEST"]}>
      <Routes>
        <Route path="/timeline" element={<TimelinePage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("TimelinePage (6.8.2.P4)", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("renders DataTable rows from the initial GET", async () => {
    const events = Array.from({ length: 5 }, (_, i) => makeEvent(i));
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/events")) {
        return Promise.resolve(
          new Response(envelope({ events }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (String(url).endsWith("/sessions/01TEST")) {
        return Promise.resolve(
          new Response(
            envelope({ session: { id: "01TEST", goal: "demo goal", status: "active" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderTimeline();

    expect(await screen.findByTestId("timeline-page")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByTestId("timeline-event-kind").length).toBe(5);
    });
  });

  it("type chip filter narrows the rows", async () => {
    const events = Array.from({ length: 6 }, (_, i) => makeEvent(i));
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/events")) {
        return Promise.resolve(
          new Response(envelope({ events }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (String(url).endsWith("/sessions/01TEST")) {
        return Promise.resolve(
          new Response(
            envelope({ session: { id: "01TEST", goal: "demo", status: "active" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderTimeline();

    await screen.findByTestId("timeline-page");
    await waitFor(() => {
      expect(screen.getAllByTestId("timeline-event-kind").length).toBe(6);
    });

    await user.click(screen.getByTestId("timeline-kind-decision"));

    await waitFor(() => {
      // 3 decision events remain
      const kinds = screen.getAllByTestId("timeline-event-kind");
      const decisionCount = kinds.filter((k) => k.textContent === "decision").length;
      expect(decisionCount).toBe(3);
      const toolCallCount = kinds.filter((k) => k.textContent === "tool_call").length;
      expect(toolCallCount).toBe(0);
    });
  });

  it("actor input applies filter after 250ms debounce", async () => {
    const events = Array.from({ length: 4 }, (_, i) => makeEvent(i));
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/events")) {
        return Promise.resolve(
          new Response(envelope({ events }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (String(url).endsWith("/sessions/01TEST")) {
        return Promise.resolve(
          new Response(
            envelope({ session: { id: "01TEST", goal: "demo", status: "active" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByTestId("timeline-page");
    await waitFor(() => {
      expect(screen.getAllByTestId("timeline-event-kind").length).toBe(4);
    });

    // Use real timers + await a setTimeout wrapper for the 250ms debounce.
    const input = screen.getByTestId("timeline-actor-input") as HTMLInputElement;
    await user.type(input, "alice");

    await waitFor(
      () => {
        const kinds = screen.getAllByTestId("timeline-event-kind");
        expect(kinds.length).toBe(2);
      },
      { timeout: 2000 },
    );
  });

  it("EmptyState renders when filter matches nothing", async () => {
    const events = [makeEvent(0)];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/events")) {
        return Promise.resolve(
          new Response(envelope({ events }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (String(url).endsWith("/sessions/01TEST")) {
        return Promise.resolve(
          new Response(
            envelope({ session: { id: "01TEST", goal: "demo", status: "active" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderTimeline();
    await screen.findByTestId("timeline-page");

    vi.useFakeTimers();
    const input = screen.getByTestId("timeline-actor-input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "nope");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();

    expect(await screen.findByText(/no matching events/i)).toBeInTheDocument();
    expect(screen.getByTestId("timeline-clear-filters")).toBeInTheDocument();
  });
  it("maps wire DB rows (type/payload_json/created_at) into the table", async () => {
    const wireEvents = [
      {
        id: "01EV0000000000000000000001",
        type: "observation_recorded",
        session_id: "01TEST",
        actor_id: "01ACT",
        created_at: "2026-06-17T10:00:00.000Z",
        payload_json: JSON.stringify({ text: "tool Bash returned", tool: "Bash" }),
      },
      {
        id: "01EV0000000000000000000002",
        type: "session_created",
        session_id: "01TEST",
        actor_id: "01ACT",
        created_at: "2026-06-17T09:00:00.000Z",
        payload_json: JSON.stringify({ goal: "inbox session", parent_session_id: null }),
      },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/events")) {
        return Promise.resolve(
          new Response(envelope({ events: wireEvents }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (String(url).endsWith("/sessions/01TEST")) {
        return Promise.resolve(
          new Response(
            envelope({ session: { id: "01TEST", goal: "demo goal", status: "active" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderTimeline();

    expect(await screen.findByTestId("timeline-page")).toBeInTheDocument();
    await waitFor(() => {
      const kinds = screen.getAllByTestId("timeline-event-kind").map((el) => el.textContent);
      expect(kinds).toEqual(expect.arrayContaining(["observation_recorded", "session_created"]));
      expect(kinds.length).toBe(2);
    });
    // summary from payload (formatPayloadSummary → "text: tool Bash returned")
    expect(screen.getByText(/text: tool Bash returned/i)).toBeInTheDocument();
  });

});
