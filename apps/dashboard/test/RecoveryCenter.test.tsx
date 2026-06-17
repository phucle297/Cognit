/**
 * apps/dashboard/test/RecoveryCenter.test.tsx
 *
 * FSD: tests the pages/recovery-center page by importing from the
 * AC-required path (src/pages/recovery-center.tsx). Cases:
 *  1. Renders the v0.2 badge and, after picking a session that has
 *     1 entry in each recovery field group, shows the 3 headings:
 *     "Rejected hypotheses", "Verified conclusions", "Accepted decisions".
 */

// jsdom shims for Radix Select. jsdom 25 is missing pointer-capture
// and scrollIntoView, both of which Radix Select calls into during
// keyboard navigation. Without these, the test would fail with
// "candidate?.scrollIntoView is not a function".
if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = (): boolean => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = (): void => undefined;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = (): void => undefined;
  }
}

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { RecoveryCenterPage } from "@/pages/recovery-center";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: (): typeof mockNavigate => mockNavigate,
  };
});

const renderRecovery = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <RecoveryCenterPage />
    </MemoryRouter>,
  );

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ version: 1, kind: "test", data }), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("RecoveryCenterPage", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    mockNavigate.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the v0.2 badge and the 3 field-group headings after picking a session", async () => {
    const sessionsResp = {
      sessions: [
        {
          id: "01sess-rec",
          project_id: "01proj-rec",
          goal: "recovery test",
          status: "active",
          created_at: "2026-06-17T10:00:00.000Z",
        },
      ],
    };
    const recoveryResp = {
      session_id: "01sess-rec",
      rejected_hypotheses: [
        {
          id: "01hyp",
          title: "hypothesis A",
          text: "an idea that was rejected",
          reason: "contradicted by evidence",
          reason_type: "evidence",
          superseded_by_id: null,
          created_at: "2026-06-17T10:05:00.000Z",
        },
      ],
      verified_conclusions: [
        {
          id: "01con",
          text: "a verified conclusion",
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
    };

    const spy = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/sessions")) {
        return Promise.resolve(jsonResponse(sessionsResp));
      }
      if (u.includes("/recovery")) {
        return Promise.resolve(jsonResponse(recoveryResp));
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    const user = userEvent.setup();
    renderRecovery();

    // v0.2 badge must be visible immediately (it's part of the page header).
    expect(screen.getByText("v0.2")).toBeInTheDocument();

    // Wait for /sessions to resolve so the picker is populated.
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });

    // Pick the session via Radix Select. Use keyboard navigation
    // because jsdom does not implement pointer-capture, which Radix
    // Select relies on for click-driven open/close.
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    // 3 field-group headings must render once /sessions/:id/recovery resolves.
    expect(await screen.findByText(/rejected hypotheses/i)).toBeInTheDocument();
    expect(await screen.findByText(/verified conclusions/i)).toBeInTheDocument();
    expect(await screen.findByText(/accepted decisions/i)).toBeInTheDocument();
  });
});