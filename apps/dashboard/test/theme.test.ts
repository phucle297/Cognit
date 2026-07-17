/**
 * Theme resolve + apply (Cognit-mf8).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyResolvedTheme,
  applyThemePreference,
  readDisplaySettings,
  resolveTheme,
  SETTINGS_STORAGE_KEY,
} from "@/shared/lib/theme";

describe("theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.theme;
  });
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("resolveTheme maps light/dark/system", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("applyResolvedTheme toggles html.dark", () => {
    applyResolvedTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyResolvedTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("applyThemePreference dark from storage path", () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ display: { theme: "dark", pageSize: 50 } }),
    );
    expect(readDisplaySettings().theme).toBe("dark");
    applyThemePreference("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
