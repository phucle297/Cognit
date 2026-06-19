/**
 * apps/dashboard/test/RecoveryCenter.test.tsx — v0.2 recovery tests.
 *
 * Existing (4):
 *  1. renders 3 section headings after picking a session
 *  2. EmptyState when session has 0 entries
 *  3. placeholder (kept to avoid renumbering)
 *  4. Export button is disabled until a session is selected
 *
 * Added (v0.2 — 7+):
 *  5.  renders all 8 sections after picking a session
 *  6.  renders related_sessions data when present
 *  7.  renders latest_verification keyed by hypothesis_id
 *  8.  renders last_known_state JSON pretty
 *  9.  renders suggested_next_steps empty state
 *  10. search input renders + Enter triggers /api/sessions/search
 *  11. search result click selects the session
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { RecoveryCenterPage } from "@/pages/recovery-center";

if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = (): boolean => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => undefined;
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = (): void => undefined;
}

const envelope = (data: unknown): string =>
  JSON.stringify({ version: 1, kind: "test", data });

const renderRecovery = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <RecoveryCenterPage />
    </MemoryRouter>,
  );

/** Full v0.2 envelope with a populated payload (used by happy-path tests). */
const fullRecovery = (sessionId: string) => ({
  session_id: sessionId,
  related_sessions: [
    {
      id: "01sess-related",
      score: 0.81,
      matched_on: "goal: similar goal text",
    },
  ],
  rejected_hypotheses: [
    {
      id: "01hyp",
      title: "hypothesis A",
      text: "x",
      reason: "evidence",
      reason_type: "evidence",
      superseded_by_id: null,
      created_at: "2026-06-17T10:05:00.000Z",
    },
  ],
  verified_conclusions: [
    {
      id: "01con",
      text: "verified",
      verification_id: "01ver",
      supporting_evidence_ids: ["01ev"],
      created_at: "2026-06-17T10:10:00.000Z",
    },
  ],
  accepted_decisions: [
    {
      id: "01dec",
      text: "an accepted decision",
      based_on_conclusion_ids: ["01con"],
      created_at: "2026-06-17T10:15:00.000Z",
    },
  ],
  rejected_decisions: [
    {
      id: "01dec-rej",
      text: "a rejected decision",
      reason: "out of scope",
      created_at: "2026-06-17T10:20:00.000Z",
    },
  ],
  latest_verification: {
    "01hyp": {
      id: "01ver-run",
      hypothesis_id: "01hyp",
      type: "test",
      command: "pnpm test",
      state: "passed",
      started_at: "2026-06-17T10:06:00.000Z",
      ended_at: "2026-06-17T10:08:00.000Z",
    },
  },
  last_known_state: {
    session_id: sessionId,
    goal: "recovery test",
    conclusions: { "01con": { id: "01con", state: "verified" } },
    hypotheses: { "01hyp": { id: "01hyp", current_state: "rejected" } },
    decisions: {},
  },
  suggested_next_steps: [],
});

describe("RecoveryCenterPage v0.2", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders 3 section headings after picking a session", async () => {
    const sessionsResp = {
      sessions: [
        {
          id: "01sess-rec",
          project_id: "01p",
          goal: "recovery test",
          status: "active",
          created_at: "2026-06-17T10:00:00.000Z",
        },
      ],
    };
    const recoveryResp = fullRecovery("01sess-rec");

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions")) {
        return Promise.resolve(new Response(envelope(sessionsResp), { status: 200 }));
      }
      if (u.includes("/recovery")) {
        return Promise.resolve(new Response(envelope(recoveryResp), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected: ${u}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderRecovery();

    const trigger = await screen.findByTestId("recovery-session-trigger");
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getAllByText(/rejected hypotheses/i).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/verified conclusions/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/accepted decisions/i).length).toBeGreaterThan(0);
  });

  it("EmptyState when session has 0 entries", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions")) {
        return Promise.resolve(
          new Response(
            envelope({
              sessions: [
                {
                  id: "01empty",
                  project_id: "01p",
                  goal: "empty",
                  status: "active",
                  created_at: "2026-06-17T00:00:00.000Z",
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      if (u.includes("/recovery")) {
        return Promise.resolve(
          new Response(
            envelope({
              session_id: "01empty",
              related_sessions: [],
              rejected_hypotheses: [],
              verified_conclusions: [],
              accepted_decisions: [],
              rejected_decisions: [],
              latest_verification: {},
              last_known_state: {},
              suggested_next_steps: [],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected: ${u}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderRecovery();

    const trigger = await screen.findByTestId("recovery-session-trigger");
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(await screen.findByText(/rejected hypotheses/i)).toBeInTheDocument();
    expect(screen.getAllByText(/empty/i).length).toBeGreaterThan(0);
  });

  it("placeholder (legacy) — intentionally empty", () => {
    // placeholder kept so the old index stays stable; new tests below.
  });

  it("Export button is disabled until a session is selected", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/sessions")) {
        return Promise.resolve(new Response(envelope({ sessions: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderRecovery();
    const exportBtn = await screen.findByTestId("recovery-export");
    expect(exportBtn).toBeDisabled();
  });

  it("renders all 8 section headings after picking a session", async () => {
    const sessionsResp = {
      sessions: [
        {
          id: "01sess-rec",
          project_id: "01p",
          goal: "recovery test",
          status: "active",
          created_at: "2026-06-17T10:00:00.000Z",
        },
      ],
    };
    const recoveryResp = fullRecovery("01sess-rec");

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions")) {
        return Promise.resolve(new Response(envelope(sessionsResp), { status: 200 }));
      }
      if (u.includes("/recovery")) {
        return Promise.resolve(new Response(envelope(recoveryResp), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected: ${u}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderRecovery();

    const trigger = await screen.findByTestId("recovery-session-trigger");
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getAllByText(/related sessions/i).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/rejected hypotheses/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/verified conclusions/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/accepted decisions/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/rejected decisions/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/latest verification/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/last known state/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/suggested next steps/i).length).toBeGreaterThan(0);
  });

  it("renders related_sessions data when present", async () => {
    const sessionsResp = {
      sessions: [
        {
          id: "01sess-rec",
          project_id: "01p",
          goal: "recovery test",
          status: "active",
          created_at: "2026-06-17T10:00:00.000Z",
        },
      ],
    };
    const recoveryResp = fullRecovery("01sess-rec");

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions")) {
        return Promise.resolve(new Response(envelope(sessionsResp), { status: 200 }));
      }
      if (u.includes("/recovery")) {
        return Promise.resolve(new Response(envelope(recoveryResp), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected: ${u}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderRecovery();

    const trigger = await screen.findByTestId("recovery-session-trigger");
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(await screen.findByText(/goal: similar goal text/i)).toBeInTheDocument();
    expect(screen.getByText("0.81")).toBeInTheDocument();
  });

  it("renders latest_verification keyed by hypothesis_id", async () => {
    const sessionsResp = {
      sessions: [
        {
          id: "01sess-rec",
          project_id: "01p",
          goal: "recovery test",
          status: "active",
          created_at: "2026-06-17T10:00:00.000Z",
        },
      ],
    };
    const recoveryResp = fullRecovery("01sess-rec");

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions")) {
        return Promise.resolve(new Response(envelope(sessionsResp), { status: 200 }));
      }
      if (u.includes("/recovery")) {
        return Promise.resolve(new Response(envelope(recoveryResp), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected: ${u}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderRecovery();

    const trigger = await screen.findByTestId("recovery-session-trigger");
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    const lv = await screen.findByTestId("recovery-latest-verification");
    expect(lv).toBeInTheDocument();
    // hypothesis_id key is rendered as truncated mono prefix
    expect(lv.textContent ?? "").toContain("01hyp");
    // the verification's command is rendered
    expect(lv.textContent ?? "").toContain("pnpm test");
    // state pill
    expect(lv.textContent ?? "").toContain("passed");
  });

  it("renders last_known_state JSON pretty", async () => {
    const sessionsResp = {
      sessions: [
        {
          id: "01sess-rec",
          project_id: "01p",
          goal: "recovery test",
          status: "active",
          created_at: "2026-06-17T10:00:00.000Z",
        },
      ],
    };
    const recoveryResp = fullRecovery("01sess-rec");

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions")) {
        return Promise.resolve(new Response(envelope(sessionsResp), { status: 200 }));
      }
      if (u.includes("/recovery")) {
        return Promise.resolve(new Response(envelope(recoveryResp), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected: ${u}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderRecovery();

    const trigger = await screen.findByTestId("recovery-session-trigger");
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    const lks = await screen.findByTestId("recovery-last-known-state");
    expect(lks).toBeInTheDocument();
    // JSON-stringified state contains nested keys — pretty-printed with newlines.
    expect((lks.textContent ?? "").length).toBeGreaterThan(20);
    expect(lks.textContent ?? "").toContain("01sess-rec");
  });

  it("renders suggested_next_steps empty state", async () => {
    const sessionsResp = {
      sessions: [
        {
          id: "01sess-rec",
          project_id: "01p",
          goal: "recovery test",
          status: "active",
          created_at: "2026-06-17T10:00:00.000Z",
        },
      ],
    };
    const recoveryResp = fullRecovery("01sess-rec");

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions")) {
        return Promise.resolve(new Response(envelope(sessionsResp), { status: 200 }));
      }
      if (u.includes("/recovery")) {
        return Promise.resolve(new Response(envelope(recoveryResp), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected: ${u}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderRecovery();

    const trigger = await screen.findByTestId("recovery-session-trigger");
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(await screen.findByTestId("recovery-suggested-empty")).toBeInTheDocument();
  });

  it("search input renders + Enter triggers /api/sessions/search", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions") && !u.includes("search")) {
        return Promise.resolve(
          new Response(
            envelope({
              sessions: [
                {
                  id: "01sess-rec",
                  project_id: "01p",
                  goal: "recovery test",
                  status: "active",
                  created_at: "2026-06-17T10:00:00.000Z",
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      if (u.includes("/sessions/search")) {
        return Promise.resolve(
          new Response(
            envelope({
              q: "alpha",
              results: [
                {
                  session_id: "01sess-other",
                  kind: "hypothesis",
                  entity_id: "01hyp-other",
                  score: 0.9,
                  text: "alpha hypothesis text",
                  kind_weight: 0.6,
                },
              ],
              limit: 50,
              offset: 0,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected: ${u}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderRecovery();

    const input = await screen.findByTestId("recovery-search-input");
    await user.type(input, "alpha{Enter}");

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const searchCall = calls.find((c) => String(c[0]).includes("/sessions/search"));
      expect(searchCall).toBeDefined();
      expect(String(searchCall?.[0])).toMatch(/[?&]q=alpha/);
    });
    expect(await screen.findByText("alpha hypothesis text")).toBeInTheDocument();
  });

  it("search result click selects the session", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions") && !u.includes("search")) {
        return Promise.resolve(
          new Response(
            envelope({
              sessions: [
                {
                  id: "01sess-rec",
                  project_id: "01p",
                  goal: "recovery test",
                  status: "active",
                  created_at: "2026-06-17T10:00:00.000Z",
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      if (u.includes("/sessions/search")) {
        return Promise.resolve(
          new Response(
            envelope({
              q: "beta",
              results: [
                {
                  session_id: "01sess-target",
                  kind: "hypothesis",
                  entity_id: "01hyp-target",
                  score: 0.95,
                  text: "beta hypothesis text",
                  kind_weight: 0.6,
                },
              ],
              limit: 50,
              offset: 0,
            }),
            { status: 200 },
          ),
        );
      }
      // Recovery endpoint for the newly selected session.
      if (u.includes("/recovery")) {
        return Promise.resolve(
          new Response(envelope(fullRecovery("01sess-target")), { status: 200 }),
        );
      }
      return Promise.reject(new Error(`unexpected: ${u}`));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderRecovery();

    const input = await screen.findByTestId("recovery-search-input");
    await user.type(input, "beta{Enter}");

    const result = await screen.findByTestId("recovery-search-result");
    expect(result).toHaveAttribute("data-session-id", "01sess-target");
    await user.click(result);

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const recoveryCall = calls.find((c) => String(c[0]).includes("/recovery"));
      expect(recoveryCall).toBeDefined();
      expect(String(recoveryCall?.[0])).toContain("01sess-target");
    });
  });
});
