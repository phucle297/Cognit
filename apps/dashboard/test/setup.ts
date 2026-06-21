/**
 * apps/dashboard/test/setup.ts — vitest global setup.
 *
 * Loads @testing-library/jest-dom matchers, polyfills the
 * browser APIs that jsdom does not implement (ResizeObserver,
 * Element.prototype.scrollIntoView, etc.), and stubs out
 * EventSource globally so tests that don't use the SSE hook
 * don't need to import it themselves.
 */
import "@testing-library/jest-dom/vitest";

// jsdom polyfills — xyflow/react + Radix Select rely on
// browser APIs jsdom 25 does not implement.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}
if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = (): boolean => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = (): void => undefined;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = (): void => undefined;
  }
}

type Listener = (ev: Event) => void;

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static lastInstance: StubEventSource | null = null;
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
    StubEventSource.lastInstance = this;
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
    if (StubEventSource.lastInstance === this) {
      StubEventSource.lastInstance = null;
    }
  }
}

if (typeof globalThis.EventSource === "undefined") {
  // @ts-expect-error - test shim
  globalThis.EventSource = StubEventSource;
}
