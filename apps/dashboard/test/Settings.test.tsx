/**
 * apps/dashboard/test/Settings.test.tsx
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
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

describe("SettingsPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders Server, Config, Display (no Project section)", async () => {
    renderSettings();
    expect(await screen.findByTestId("settings-server")).toBeInTheDocument();
    expect(screen.getByTestId("settings-config")).toBeInTheDocument();
    expect(screen.getByTestId("settings-display")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-project")).not.toBeInTheDocument();
  });

  it("Save Button is disabled until dirty", async () => {
    renderSettings();
    const save = await screen.findByTestId("settings-save");
    expect(save).toBeDisabled();
  });

  it("editing Server.bind enables Save", async () => {
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
    const user = userEvent.setup();
    renderSettings();
    const bindInput = await screen.findByTestId("settings-server-bind");
    await user.clear(bindInput);
    await user.type(bindInput, "10.0.0.1");
    await user.click(await screen.findByTestId("settings-save"));
    expect(await screen.findByTestId("settings-saved")).toBeInTheDocument();
    const stored = window.localStorage.getItem("cognit.settings.v1");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).server.bind).toBe("10.0.0.1");
  });

  it("saving dark theme applies html.dark class", async () => {
    const user = userEvent.setup();
    document.documentElement.classList.remove("dark");
    renderSettings();
    const theme = await screen.findByTestId("settings-display-theme");
    await user.selectOptions(theme, "dark");
    await user.click(await screen.findByTestId("settings-save"));
    expect(await screen.findByTestId("settings-saved")).toBeInTheDocument();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    const stored = JSON.parse(window.localStorage.getItem("cognit.settings.v1")!);
    expect(stored.display.theme).toBe("dark");
  });
});

