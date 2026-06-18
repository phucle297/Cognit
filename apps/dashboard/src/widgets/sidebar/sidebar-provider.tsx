/**
 * apps/dashboard/src/widgets/sidebar/sidebar-provider.tsx — sidebar state.
 *
 * FSD layer: widgets. Exposes a small Context with collapsed state
 * persisted to localStorage under `cognit.sidebar.collapsed`. Pages
 * (Phase 4 graph routes) call `setCollapsed(true)` on mount; the
 * collapse toggle button lives in the Sidebar itself.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

const STORAGE_KEY = "cognit.sidebar.collapsed";

const readPersisted = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const writePersisted = (collapsed: boolean): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore quota / privacy mode failures — sidebar still works in-memory
  }
};

export interface SidebarContextValue {
  readonly collapsed: boolean;
  readonly setCollapsed: (next: boolean) => void;
  readonly toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export interface SidebarProviderProps {
  readonly children: ReactNode;
  readonly defaultCollapsed?: boolean;
}

export const SidebarProvider = ({ children, defaultCollapsed }: SidebarProviderProps): ReactNode => {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    if (defaultCollapsed !== undefined) return defaultCollapsed;
    return readPersisted();
  });

  useEffect(() => {
    writePersisted(collapsed);
  }, [collapsed]);

  const setCollapsed = useCallback((next: boolean) => setCollapsedState(next), []);
  const toggle = useCallback(() => setCollapsedState((c) => !c), []);

  const value = useMemo<SidebarContextValue>(
    () => ({ collapsed, setCollapsed, toggle }),
    [collapsed, setCollapsed, toggle],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
};

export const useSidebar = (): SidebarContextValue => {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within <SidebarProvider>");
  }
  return ctx;
};
