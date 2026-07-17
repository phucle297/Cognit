/**
 * apps/dashboard/src/shared/lib/theme.ts — display theme apply path.
 *
 * Settings persist `display.theme` under cognit.settings.v1.
 * This module is the only place that mutates <html> class / color-scheme
 * so light | dark | system actually change the UI.
 */

export type ThemePreference = "light" | "dark" | "system";

export const SETTINGS_STORAGE_KEY = "cognit.settings.v1";

export type DisplaySettings = {
  readonly theme: ThemePreference;
  readonly pageSize: number;
};

const DEFAULT_DISPLAY: DisplaySettings = {
  theme: "system",
  pageSize: 50,
};

export const readDisplaySettings = (): DisplaySettings => {
  if (typeof window === "undefined") return DEFAULT_DISPLAY;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_DISPLAY;
    const parsed = JSON.parse(raw) as { display?: Partial<DisplaySettings> };
    const theme = parsed.display?.theme;
    const pageSize = parsed.display?.pageSize;
    return {
      theme:
        theme === "light" || theme === "dark" || theme === "system"
          ? theme
          : DEFAULT_DISPLAY.theme,
      pageSize:
        typeof pageSize === "number" && pageSize >= 10 && pageSize <= 500
          ? pageSize
          : DEFAULT_DISPLAY.pageSize,
    };
  } catch {
    return DEFAULT_DISPLAY;
  }
};

export const resolveTheme = (
  preference: ThemePreference,
  prefersDark?: boolean,
): "light" | "dark" => {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  if (typeof prefersDark === "boolean") return prefersDark ? "dark" : "light";
  if (typeof window === "undefined") return "light";
  // jsdom may lack matchMedia; treat as light.
  if (typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

/** Apply resolved theme to the document root. */
export const applyResolvedTheme = (resolved: "light" | "dark"): void => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", resolved);
};

export const applyThemePreference = (preference: ThemePreference): "light" | "dark" => {
  const resolved = resolveTheme(preference);
  applyResolvedTheme(resolved);
  return resolved;
};

/**
 * Boot + keep system preference in sync.
 * Returns an unsubscribe for the media-query listener.
 */
export const initTheme = (): (() => void) => {
  const display = readDisplaySettings();
  applyThemePreference(display.theme);

  if (typeof window === "undefined") return () => undefined;
  if (typeof window.matchMedia !== "function") return () => undefined;

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (): void => {
    const pref = readDisplaySettings().theme;
    if (pref === "system") applyResolvedTheme(resolveTheme("system", mql.matches));
  };
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
};
