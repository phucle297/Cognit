/**
 * apps/dashboard/test/setup.ts — vitest global setup.
 *
 * Loads @testing-library/jest-dom matchers and stubs out
 * EventSource globally so tests that don't use the SSE hook
 * don't need to import it themselves.
 */
import "@testing-library/jest-dom/vitest";

type Listener = (ev: Event) => void;

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials: boolean;
  readyState: number = StubEventSource.CONNECTING;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  private listeners = new Map<string, Set<Listener>>();
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
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
    this.readyState = StubEventSource.CLOSED;
  }
}

if (typeof globalThis.EventSource === "undefined") {
  // @ts-expect-error - test shim
  globalThis.EventSource = StubEventSource;
}
