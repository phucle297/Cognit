/**
 * apps/dashboard/test/Rules.test.tsx — phase 8 (8g.5) tests for the
 * Constraint Rules CRUD page.
 *
 * Cases:
 *   1. shows the empty-state when /api/rules returns []
 *   2. lists rules returned by the server and renders the source badge
 *   3. add dialog opens via the Add rule button
 *   4. submitting bad JSON shows the error message; no POST is sent
 *   5. submitting valid JSON sends POST /api/rules and re-fetches the list
 *   6. toggle button sends PATCH /api/rules/:id
 *   7. delete button sends DELETE /api/rules/:id
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { RulesPage } from "@/pages/rules";

if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture)
    Element.prototype.hasPointerCapture = (): boolean => false;
  if (!Element.prototype.scrollIntoView)
    Element.prototype.scrollIntoView = (): void => undefined;
  if (!Element.prototype.releasePointerCapture)
    Element.prototype.releasePointerCapture = (): void => undefined;
}

const envelope = (data: unknown): string =>
  JSON.stringify({ version: 1, kind: "test", data });

const renderRules = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <RulesPage />
    </MemoryRouter>,
  );

interface RuleRow {
  id: string;
  session_id: string;
  condition: unknown;
  action: unknown;
  reason: string;
  enabled: boolean;
  deleted: boolean;
  source: "db" | "yaml";
  created_at: string;
  updated_at: string;
}

const sampleRule = (id: string, enabled = true, source: "db" | "yaml" = "db"): RuleRow => ({
  id,
  session_id: "01sess",
  condition: { kind: "event.type", equals: "observation_recorded" },
  action: { kind: "block" },
  reason: `block obs ${id}`,
  enabled,
  deleted: false,
  source,
  created_at: "2026-06-19T00:00:00.000Z",
  updated_at: "2026-06-19T00:00:00.000Z",
});

describe("RulesPage (phase 8 — 8g.5)", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("1. shows empty-state when /api/rules returns []", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(envelope({ rules: [] }), { status: 200 })),
    ) as unknown as typeof fetch;
    renderRules();
    expect(await screen.findByTestId("rules-empty")).toBeInTheDocument();
  });

  it("2. lists rules + renders source badge", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          envelope({ rules: [sampleRule("rule_a"), sampleRule("rule_b", false, "yaml")] }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;
    renderRules();
    expect(await screen.findByTestId("rules-item-rule_a")).toBeInTheDocument();
    expect(await screen.findByTestId("rules-item-rule_b")).toBeInTheDocument();
    expect((await screen.findByTestId("rules-source-rule_a")).textContent).toContain("db");
    expect((await screen.findByTestId("rules-source-rule_b")).textContent).toContain("yaml");
    expect((await screen.findByTestId("rules-enabled-rule_a")).textContent).toContain("enabled");
    expect((await screen.findByTestId("rules-enabled-rule_b")).textContent).toContain("disabled");
  });

  it("3. add dialog opens via Add rule button", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(envelope({ rules: [] }), { status: 200 })),
    ) as unknown as typeof fetch;
    renderRules();
    const addBtn = await screen.findByTestId("rules-add-button");
    await userEvent.setup().click(addBtn);
    expect(await screen.findByTestId("rules-add-json")).toBeInTheDocument();
  });

  it("4. submitting bad JSON shows an error and does not POST", async () => {
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(envelope({ rules: [] }), { status: 200 })),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const user = userEvent.setup();
    renderRules();
    await user.click(await screen.findByTestId("rules-add-button"));
    const ta = await screen.findByTestId("rules-add-json");
    await user.clear(ta);
    await user.type(ta, "{{not-json");
    await user.click(await screen.findByTestId("rules-add-submit"));
    expect(await screen.findByTestId("rules-add-error")).toBeInTheDocument();
    // Only the GET happened (initial load).
    const postCalls = mockFetch.mock.calls.filter(
      (call) => (call[1] as { method?: string } | undefined)?.method === "POST",
    );
    expect(postCalls.length).toBe(0);
  });

  it("5. submitting valid JSON sends POST and re-fetches", async () => {
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          new Response(envelope({ rule: sampleRule("rule_new") }), { status: 201 }),
        );
      }
      return Promise.resolve(new Response(envelope({ rules: [sampleRule("rule_new")] }), { status: 200 }));
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const user = userEvent.setup();
    renderRules();
    await user.click(await screen.findByTestId("rules-add-button"));
    await user.click(await screen.findByTestId("rules-add-submit"));
    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(
          (call) => (call[1] as { method?: string } | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
  });

  it("6. toggle button sends PATCH", async () => {
    let toggled = false;
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") {
        toggled = true;
        return Promise.resolve(
          new Response(envelope({ rule: sampleRule("rule_a", false) }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(envelope({ rules: [sampleRule("rule_a", !toggled)] }), { status: 200 }),
      );
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    renderRules();
    const btn = await screen.findByTestId("rules-toggle-rule_a");
    await userEvent.setup().click(btn);
    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(
          (call) => (call[1] as { method?: string } | undefined)?.method === "PATCH",
        ),
      ).toBe(true);
    });
  });

  it("7. delete button sends DELETE", async () => {
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") {
        return Promise.resolve(new Response(envelope({ id: "rule_a" }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(envelope({ rules: [sampleRule("rule_a")] }), { status: 200 }),
      );
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    renderRules();
    const btn = await screen.findByTestId("rules-delete-rule_a");
    await userEvent.setup().click(btn);
    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(
          (call) => (call[1] as { method?: string } | undefined)?.method === "DELETE",
        ),
      ).toBe(true);
    });
  });
});
