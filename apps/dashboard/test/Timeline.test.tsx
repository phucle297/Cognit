/**
 * apps/dashboard/test/Timeline.test.tsx
 *
 * FSD: tests the Timeline page by importing from the
 * AC-required path (src/pages/timeline.tsx). Cases:
 *  1. initial 50 — mock fetch returns 50 events, render, count rows.
 *  2. type chip filter — toggle a chip, only matching rows remain.
 *  3. actor debounce — type into actor input, advance 250ms,
 *     filter applies.
 *  4. pause SSE — click pause, EventSource.close() invoked.
 *  5. append without remount — dispatch message on the live
 *     EventSource, a new row appears and prior rows are stable.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { TimelinePage } from "@/pages/timeline";

type Listener = (ev: Event) => void;

class TestEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: TestEventSource[] = [];
  readonly url: string;
  readonly withCredentials: boolean;
  readyState: number = TestEventSource.CONNECTING;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  private listeners = new Map<string, Set<Listener>>();
  closed = false;
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    TestEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }
  dispatchEvent(ev: Event): boolean {
    const set = this.listeners.get(ev.type);
    if (set) for (const cb of set) cb(ev);
    return true;
  }
  close(): void {
    this.closed = true;
    this.readyState = TestEventSource.CLOSED;
  }
  emitMessage(data: string, lastEventId = ""): void {
    const ev = new MessageEvent("message", { data, lastEventId });
    this.onmessage?.(ev);
    this.dispatchEvent(ev);
  }
  static reset(): void {
    TestEventSource.instances = [];
  }
}

const renderTimeline = (initialEntry = "/timeline?session=01TEST"):
  ReturnType<typeof render> =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TimelinePage />
    </MemoryRouter>,
  );

const makeEvent = (i: number): {
  id: string;
  kind: string;
  session_id: string;
  actor: string;
  ts: string;
  payload: unknown;
} => ({
  id: `01INIT${String(i).padStart(20, "0")}`,
  kind: i % 2 === 0 ? "tool_call" : "decision",
  session_id: "01TEST",
  actor: i % 2 === 0 ? "alice" : "bob",
  ts: "2026-06-17T10:00:00.000Z",
  payload: { tool: "shell", args: ["ls"] },
});

const fetchOk = (events: unknown[]): void => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ version: 1, kind: "list_events", data: { events } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
};

describe("TimelinePage", () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    TestEventSource.reset();
    // @ts-expect-error - test stub
    globalThis.EventSource = TestEventSource;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders 50 rows from the initial GET", async () => {
    fetchOk(Array.from({ length: 50 }, (_, i) => makeEvent(i)));
    renderTimeline();
    await waitFor(() => {
      expect(screen.getAllByTestId("timeline-event-row")).toHaveLength(50);
    });
  });

  it("filters by selected type chip", async () => {
    fetchOk(Array.from({ length: 6 }, (_, i) => makeEvent(i)));
    renderTimeline();
    await waitFor(() => {
      expect(screen.getAllByTestId("timeline-event-row")).toHaveLength(6);
    });
    await userEvent.click(screen.getByTestId("type-chip-decision"));
    const rows = screen.getAllByTestId("timeline-event-row");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const kind = row.querySelector('[data-testid="event-kind"]')?.textContent;
      expect(kind).toBe("decision");
    }
  });

  it("applies the actor debounce only after 250ms", async () => {
    fetchOk([makeEvent(0), makeEvent(1), makeEvent(2)]);

    renderTimeline();
    await waitFor(() => {
      expect(screen.getAllByTestId("timeline-event-row")).toHaveLength(3);
    });

    vi.useFakeTimers();
    const input = screen.getByTestId("actor-input") as HTMLInputElement;
    // Synchronously fire input event with native value setter so
    // React picks up the change. userEvent advances fake timers
    // on its own, which would defeat the debounce assertion.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      nativeSetter?.call(input, "alice");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Debounce timer registered, but not yet fired. The filter
    // should NOT have applied — still 3 rows.
    expect(screen.getAllByTestId("timeline-event-row")).toHaveLength(3);

    // Advance past the 250ms debounce and flush React updates.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(screen.getAllByTestId("timeline-event-row")).toHaveLength(2);
  });

  it("invokes EventSource.close() when PauseSseButton is clicked", async () => {
    fetchOk([makeEvent(0)]);
    renderTimeline();
    await waitFor(() => {
      expect(TestEventSource.instances.length).toBeGreaterThanOrEqual(1);
    });
    const es = TestEventSource.instances[TestEventSource.instances.length - 1]!;
    expect(es.closed).toBe(false);
    await userEvent.click(screen.getByTestId("pause-sse-button"));
    // Pausing flips the page to pass `null` to useEventSource,
    // which closes the underlying EventSource as part of the
    // effect cleanup.
    await waitFor(() => {
      expect(es.closed).toBe(true);
    });
    expect(screen.getByTestId("sse-status").getAttribute("data-status")).toBe("closed");
  });

  it("appends a live event without remounting prior rows", async () => {
    fetchOk([makeEvent(0)]);
    renderTimeline();
    await waitFor(() => {
      expect(screen.getAllByTestId("timeline-event-row")).toHaveLength(1);
    });
    const es = TestEventSource.instances[TestEventSource.instances.length - 1]!;
    const initialNode = screen.getAllByTestId("timeline-event-row")[0]!;
    const liveEvent = {
      id: "01LIVE0000000000000000000",
      kind: "decision",
      session_id: "01TEST",
      actor: "carol",
      ts: "2026-06-17T10:01:00.000Z",
      payload: { reason: "live" },
    };
    act(() => {
      es.emitMessage(JSON.stringify(liveEvent), "01LIVE0000000000000000000");
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("timeline-event-row")).toHaveLength(2);
    });
    const stillThere = screen.getAllByTestId("timeline-event-row").find(
      (el) => el.getAttribute("data-event-id") === initialNode.getAttribute("data-event-id"),
    );
    expect(stillThere).toBe(initialNode);
  });
});
