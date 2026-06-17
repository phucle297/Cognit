/**
 * apps/dashboard/test/use-event-source.test.ts
 *
 * FSD: tests the shared/api useEventSource hook. Cases:
 *  1. opens on mount
 *  2. closes on unmount
 *  3. reads event.lastEventId from incoming frames
 *  4. backoff caps at 30_000 ms
 *  5. parses id:/event:/data: triple into the events array
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useEventSource } from "@/lib/use-event-source";

type Listener = (ev: Event) => void;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials: boolean;
  readyState: number = FakeEventSource.CONNECTING;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  private listeners = new Map<string, Set<Listener>>();
  closed = false;
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
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
    this.readyState = FakeEventSource.CLOSED;
  }
  emitOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    const ev = new Event("open");
    this.onopen?.(ev);
    this.dispatchEvent(ev);
  }
  emitMessage(data: string, lastEventId = "", type = "message"): void {
    const ev = new MessageEvent(type, { data, lastEventId });
    this.onmessage?.(ev);
    this.dispatchEvent(ev);
  }
  emitError(): void {
    const ev = new Event("error");
    this.onerror?.(ev);
    this.dispatchEvent(ev);
  }
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }
}

const flushMicrotasks = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("useEventSource", () => {
  let originalEventSource: typeof globalThis.EventSource;
  let originalSetTimeout: typeof setTimeout;
  let setTimeoutCalls: Array<{ delay: number }>;

  beforeEach(() => {
    FakeEventSource.reset();
    originalEventSource = globalThis.EventSource;
    // @ts-expect-error - test stub
    globalThis.EventSource = FakeEventSource;

    setTimeoutCalls = [];
    originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, delay: number): unknown => {
      setTimeoutCalls.push({ delay });
      void fn; // do not actually fire
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
    globalThis.setTimeout = originalSetTimeout;
  });

  it("opens an EventSource on mount and transitions to 'open'", async () => {
    const { result } = renderHook(() => useEventSource<{ v: number }>("/events/stream"));
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/events/stream");
    expect(FakeEventSource.instances[0]?.withCredentials).toBe(true);
    act(() => {
      FakeEventSource.instances[0]?.emitOpen();
    });
    expect(result.current.status).toBe("open");
  });

  it("closes the EventSource on unmount", async () => {
    const { unmount } = renderHook(() => useEventSource<unknown>("/events/stream"));
    await flushMicrotasks();
    const es = FakeEventSource.instances[0];
    expect(es).toBeDefined();
    unmount();
    expect(es?.closed).toBe(true);
  });

  it("captures event.lastEventId on emitted frames", async () => {
    const { result } = renderHook(() => useEventSource<{ v: number }>("/events/stream"));
    await flushMicrotasks();
    const es = FakeEventSource.instances[0]!;
    act(() => es.emitOpen());
    act(() => es.emitMessage(JSON.stringify({ v: 1 }), "01FRAME0000000000", "tick"));
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.id).toBe("01FRAME0000000000");
    expect(result.current.events[0]?.event).toBe("tick");
  });

  it("caps reconnect backoff at 30_000 ms", async () => {
    const { unmount } = renderHook(() => useEventSource<unknown>("/events/stream"));
    await flushMicrotasks();
    const es = FakeEventSource.instances[0]!;
    for (let i = 0; i < 20; i++) {
      act(() => es.emitError());
    }
    const maxDelay = setTimeoutCalls.reduce((acc, c) => Math.max(acc, c.delay), 0);
    expect(maxDelay).toBeLessThanOrEqual(30_000);
    unmount();
  });

  it("parses id:/event:/data: triples into the events array", async () => {
    const { result } = renderHook(() => useEventSource<{ msg: string }>("/events/stream"));
    await flushMicrotasks();
    const es = FakeEventSource.instances[0]!;
    act(() => es.emitOpen());
    act(() => es.emitMessage(JSON.stringify({ msg: "hello" }), "01ABCDEFGHJKMNPQR"));
    act(() => es.emitMessage(JSON.stringify({ msg: "world" }), "01FGHJKMNPQRSTVWX", "metric"));
    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[0]?.data).toEqual({ msg: "hello" });
    expect(result.current.events[1]?.event).toBe("metric");
  });
});
