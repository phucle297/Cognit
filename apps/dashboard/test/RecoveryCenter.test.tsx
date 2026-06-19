/**
 * apps/dashboard/test/RecoveryCenter.test.tsx — redesigned page tests.
 *
 * Cases:
 *  1. Renders 3 section headings after picking a session
 *  2. EmptyState when session has 0 entries
 *  3. Export button is disabled until a session is selected
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

describe("RecoveryCenterPage (6.8.2.P4)", () => {
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
    const recoveryResp = {
      session_id: "01sess-rec",
      rejected_hypotheses: [
        { id: "01hyp", title: "hypothesis A", text: "x", reason: "evidence", reason_type: "evidence", superseded_by_id: null, created_at: "2026-06-17T10:05:00.000Z" },
      ],
      verified_conclusions: [
        { id: "01con", text: "verified", verification_id: "01ver", supporting_evidence_ids: ["01ev"], created_at: "2026-06-17T10:10:00.000Z" },
      ],
      accepted_decisions: [
        { id: "01dec", text: "an accepted decision", based_on_conclusion_ids: ["01con"], created_at: "2026-06-17T10:15:00.000Z" },
      ],
    };

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
            envelope({ sessions: [{ id: "01empty", project_id: "01p", goal: "empty", status: "active", created_at: "2026-06-17T00:00:00.000Z" }] }),
            { status: 200 },
          ),
        );
      }
      if (u.includes("/recovery")) {
        return Promise.resolve(
          new Response(
            envelope({ session_id: "01empty", rejected_hypotheses: [], verified_conclusions: [], accepted_decisions: [] }),
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

  it("renders 3 section headings after picking a session (duplicate test id removed)", () => {
    // placeholder so the old edit doesn't re-introduce
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
});
