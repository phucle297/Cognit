/**
 * apps/dashboard/src/pages/settings.tsx — Settings (6.8.2.P4).
 *
 * FSD layer: pages. Sectioned Cards (Server, Display).
 * No project picker — dashboard is always one Cognit root.
 * Save Button disabled until dirty.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { Save, Server, Palette } from "lucide-react";

import { Breadcrumb } from "@/shared/ui/breadcrumb";
import { Button } from "@/shared/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { ConfigView } from "@/components/ConfigView";
import { StorageUsage } from "@/components/StorageUsage";
import { SettingsAdvanced, type SectionId } from "@/widgets/settings-advanced";
import {
  applyThemePreference,
  SETTINGS_STORAGE_KEY,
  type ThemePreference,
} from "@/shared/lib/theme";

const ADVANCED_SECTIONS: ReadonlyArray<SectionId> = [
  "guardrails",
  "recovery",
  "decisions",
  "checks",
  "ai",
];

type ServerSettings = {
  bind: string;
  port: number;
  sseTimeoutMs: number;
};

type DisplaySettings = {
  theme: ThemePreference;
  pageSize: number;
};

const DEFAULTS: { server: ServerSettings; display: DisplaySettings } = {
  server: { bind: "127.0.0.1", port: 6971, sseTimeoutMs: 86_400_000 },
  display: { theme: "system", pageSize: 50 },
};

const loadSettings = (): { server: ServerSettings; display: DisplaySettings } => {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULTS>;
    return {
      server: { ...DEFAULTS.server, ...(parsed.server ?? {}) },
      display: { ...DEFAULTS.display, ...(parsed.display ?? {}) },
    };
  } catch {
    return DEFAULTS;
  }
};

const saveSettings = (s: typeof DEFAULTS): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore quota / privacy mode failures
  }
};

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export const SettingsPage = (): JSX.Element => {
  const [searchParams] = useSearchParams();
  const advancedParam = searchParams.get("advanced");
  const advancedSection: SectionId | undefined =
    advancedParam !== null && (ADVANCED_SECTIONS as ReadonlyArray<string>).includes(advancedParam)
      ? (advancedParam as SectionId)
      : undefined;

  const [draft, setDraft] = useState(DEFAULTS);
  const [saved, setSaved] = useState(DEFAULTS);
  const [status, setStatus] = useState<"idle" | "saved">("idle");

  useEffect(() => {
    setDraft(loadSettings());
    setSaved(loadSettings());
  }, []);


  const dirty = useMemo(
    () => !equal(draft, saved),
    [draft, saved],
  );

  const onSave = (): void => {
    saveSettings(draft);
    applyThemePreference(draft.display.theme);
    setSaved(draft);
    setStatus("saved");
    window.setTimeout(() => setStatus("idle"), 1500);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="settings-page">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Settings" }]} />
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        </div>
        <div className="flex items-center gap-2">
          {status === "saved" ? (
            <span className="text-xs text-[var(--color-status-active)]" data-testid="settings-saved">
              Saved
            </span>
          ) : null}
          <Button onClick={onSave} disabled={!dirty} data-testid="settings-save">
            <Save className="size-4" aria-hidden /> Save
          </Button>
        </div>
      </div>

      <section className="grid gap-4">
        <Card variant="flat" data-testid="settings-server">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="size-4 text-muted-foreground" aria-hidden /> Server
            </CardTitle>
            <CardDescription>Bind host, port, and SSE timeout. Local-only tool — keep bind on 127.0.0.1.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Bind host" htmlFor="server-bind">
              <Input
                id="server-bind"
                value={draft.server.bind}
                onChange={(e) => setDraft({ ...draft, server: { ...draft.server, bind: e.target.value } })}
                data-testid="settings-server-bind"
              />
            </Field>
            <Field label="Port" htmlFor="server-port">
              <Input
                id="server-port"
                type="number"
                min={1}
                max={65535}
                value={draft.server.port}
                onChange={(e) =>
                  setDraft({ ...draft, server: { ...draft.server, port: Number(e.target.value) || 6971 } })
                }
                data-testid="settings-server-port"
              />
            </Field>
            <Field label="SSE timeout (ms)" htmlFor="server-sse">
              <Input
                id="server-sse"
                type="number"
                value={draft.server.sseTimeoutMs}
                onChange={(e) =>
                  setDraft({ ...draft, server: { ...draft.server, sseTimeoutMs: Number(e.target.value) || 0 } })
                }
                data-testid="settings-server-sse"
              />
            </Field>
          </CardContent>
        </Card>

        <Card variant="flat" data-testid="settings-config">
          <CardHeader>
            <CardTitle>Config</CardTitle>
            <CardDescription>
              This dashboard serves one Cognit root (the directory you ran{" "}
              <code className="text-xs">cognit dashboard</code> from). There is no project switcher.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConfigView />
          </CardContent>
        </Card>

        <Card variant="flat" data-testid="settings-display">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Palette className="size-4 text-muted-foreground" aria-hidden /> Display
            </CardTitle>
            <CardDescription>Theme + default page size for list views.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Theme" htmlFor="display-theme">
              <select
                id="display-theme"
                value={draft.display.theme}
                onChange={(e) =>
                  setDraft({ ...draft, display: { ...draft.display, theme: e.target.value as DisplaySettings["theme"] } })
                }
                data-testid="settings-display-theme"
                className="h-9 w-full rounded-[var(--radius)] border border-input bg-background px-3 text-sm"
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </Field>
            <Field label="Page size" htmlFor="display-pagesize">
              <Input
                id="display-pagesize"
                type="number"
                min={10}
                max={500}
                value={draft.display.pageSize}
                onChange={(e) =>
                  setDraft({ ...draft, display: { ...draft.display, pageSize: Number(e.target.value) || 50 } })
                }
                data-testid="settings-display-pagesize"
              />
            </Field>
            <div className="sm:col-span-2">
              <StorageUsage />
            </div>
          </CardContent>
        </Card>

        <SettingsAdvanced defaultOpen={advancedSection} />
      </section>
    </div>
  );
};

const Field = ({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }): JSX.Element => (
  <div className="flex flex-col gap-1">
    <label htmlFor={htmlFor} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </label>
    {children}
  </div>
);
