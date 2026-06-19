/**
 * apps/dashboard/test/Settings.test.tsx — redesigned page tests.
 *
 * Cases:
 *  1. Renders sectioned Cards (Server, Project, Display)
 *  2. Save Button is disabled until dirty
 *  3. Editing Server.bind enables Save
 *  4. Saved indicator appears after save
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "@/pages/settings";

const renderSettings = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );

const envelope = (data: unknown): string =>
  JSON.stringify({ version: 1, kind: "test", data });

describe("SettingsPage (6.8.2.P4)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders 3 sectioned Cards (Server, Project, Display)", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(
          new Response(envelope({ projects: [{ id: "01p", name: "cognit-demo" }] }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderSettings();
    expect(await screen.findByTestId("settings-server")).toBeInTheDocument();
    expect(screen.getByTestId("settings-project")).toBeInTheDocument();
    expect(screen.getByTestId("settings-display")).toBeInTheDocument();
  });

  it("Save Button is disabled until dirty", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(new Response(envelope({ projects: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderSettings();
    const save = await screen.findByTestId("settings-save");
    expect(save).toBeDisabled();
  });

  it("editing Server.bind enables Save", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(new Response(envelope({ projects: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderSettings();
    const bindInput = await screen.findByTestId("settings-server-bind");
    await user.clear(bindInput);
    await user.type(bindInput, "0.0.0.0");

    await waitFor(() => {
      expect(screen.getByTestId("settings-save")).not.toBeDisabled();
    });
  });

  it("Save shows the Saved indicator and persists to localStorage", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/projects")) {
        return Promise.resolve(new Response(envelope({ projects: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderSettings();
    const bindInput = await screen.findByTestId("settings-server-bind");
    await user.clear(bindInput);
    await user.type(bindInput, "10.0.0.1");
    const save = await screen.findByTestId("settings-save");
    await user.click(save);

    expect(await screen.findByTestId("settings-saved")).toBeInTheDocument();
    const stored = window.localStorage.getItem("cognit.settings.v1");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).server.bind).toBe("10.0.0.1");
  });
});
