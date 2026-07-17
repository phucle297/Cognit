/**
 * Graph last-session helpers (Cognit-mf8 G1).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GRAPH_LAST_SESSION_KEY,
  readLastGraphSession,
  resolveGraphSession,
  writeLastGraphSession,
} from "@/shared/lib/graph-session";

describe("graph-session", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("prefers URL session over storage", () => {
    writeLastGraphSession("stored");
    expect(resolveGraphSession("from-url")).toBe("from-url");
  });

  it("falls back to last stored session", () => {
    writeLastGraphSession("01ABC");
    expect(readLastGraphSession()).toBe("01ABC");
    expect(resolveGraphSession(null)).toBe("01ABC");
    expect(resolveGraphSession("")).toBe("01ABC");
  });

  it("returns empty when nothing stored", () => {
    expect(resolveGraphSession(null)).toBe("");
    expect(window.localStorage.getItem(GRAPH_LAST_SESSION_KEY)).toBeNull();
  });
});
