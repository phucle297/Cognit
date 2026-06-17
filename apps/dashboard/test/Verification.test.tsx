/**
 * apps/dashboard/test/Verification.test.tsx
 *
 * FSD: tests the pages/verification page by importing from the
 * AC-required path (src/pages/verification.tsx). Cases:
 *  1. group by linked_hypothesis_id — 3 verifications across 2
 *     hypothesis ids → 2 groups
 *  2. RerunButton POSTs /verify with the right body
 *  3. CancelButton POSTs /verify/:id/cancel and is disabled on
 *     terminal-state rows
 *
 * Strategy: mock `globalThis.fetch` so each call returns the right
 * envelope (state + verify/cancel POSTs), wrap with MemoryRouter,
 * drive search params via `?session=…`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { VerificationPage } from "@/pages/verification";

const envelope = (kind: string, data: unknown): string =>
  JSON.stringify({ version: 1, kind, data });

type VerificationStatus = "started" | "passed" | "failed" | "errored" | "cancelled";

type VerificationWire = {
  id: string;
  command: string;
  type: "test" | "lint" | "build" | "exec" | "typecheck";
  linked_hypothesis_id: string | null;
  state: VerificationStatus;
};

const buildStateResp = (verifications: VerificationWire[]): unknown => ({
  session: { id: "01SESSION" },
  state: {
    verifications: Object.fromEntries(verifications.map((v) => [v.id, v])),
  },
});

const renderVerification = (sessionId: string): ReturnType<typeof render> =>
  render(
    <MemoryRouter initialEntries={[`/verification?session=${sessionId}`]}>
      <Routes>
        <Route path="/verification" element={<VerificationPage />} />
      </Routes>
    </MemoryRouter>,
  );

const findRow = (id: string): HTMLElement => {
  const rows = screen.getAllByTestId("verification-row");
  const found = rows.find((r) => r.getAttribute("data-verification-id") === id);
  if (!found) throw new Error(`no verification row for id ${id}`);
  return found;
};

describe("VerificationPage", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("groups verifications by linked_hypothesis_id", async () => {
    const verifications: VerificationWire[] = [
      {
        id: "01V1",
        command: "pnpm test",
        type: "test",
        linked_hypothesis_id: "01H1",
        state: "passed",
      },
      {
        id: "01V2",
        command: "pnpm lint",
        type: "lint",
        linked_hypothesis_id: "01H1",
        state: "started",
      },
      {
        id: "01V3",
        command: "pnpm build",
        type: "build",
        linked_hypothesis_id: "01H2",
        state: "failed",
      },
    ];

    const spy = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/sessions/01SESSION/state")) {
        return Promise.resolve(
          new Response(envelope("session.state", buildStateResp(verifications)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    renderVerification("01SESSION");

    const groups = await screen.findAllByTestId("verification-group");
    expect(groups).toHaveLength(2);

    const groupsByHyp = new Map<string, HTMLElement>();
    for (const g of groups) {
      groupsByHyp.set(g.getAttribute("data-linked-hypothesis") ?? "", g);
    }
    expect(groupsByHyp.get("01H1")).toBeDefined();
    expect(groupsByHyp.get("01H2")).toBeDefined();
    expect(within(groupsByHyp.get("01H1")!).getAllByTestId("verification-row")).toHaveLength(2);
    expect(within(groupsByHyp.get("01H2")!).getAllByTestId("verification-row")).toHaveLength(1);
  });

  it("RerunButton POSTs to /verify with the right body", async () => {
    const verifications: VerificationWire[] = [
      {
        id: "01V-STARTED",
        command: "pnpm test",
        type: "test",
        linked_hypothesis_id: "01H1",
        state: "started",
      },
    ];

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const spy = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      if (url.startsWith("/sessions/01SESSION/state")) {
        return Promise.resolve(
          new Response(envelope("session.state", buildStateResp(verifications)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url === "/verify" && (init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          new Response(
            envelope("verification.started", { id: "01V-NEW", session_id: "01SESSION" }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    const user = userEvent.setup();
    renderVerification("01SESSION");

    const row = await screen.findByTestId("verification-row");
    const rerun = within(row).getByTestId("rerun-button");
    await user.click(rerun);

    await waitFor(() => {
      const verifyCall = calls.find((c) => c.url === "/verify");
      expect(verifyCall).toBeDefined();
    });
    const verifyCall = calls.find((c) => c.url === "/verify")!;
    expect(verifyCall.init.method).toBe("POST");
    const body = JSON.parse(verifyCall.init.body as string);
    expect(body).toMatchObject({
      session_id: "01SESSION",
      command: "pnpm test",
      type: "test",
      actor: { name: "dashboard", type: "system" },
      linked_hypothesis_id: "01H1",
    });
  });

  it("CancelButton POSTs to /verify/:id/cancel and is disabled on terminal rows", async () => {
    const verifications: VerificationWire[] = [
      {
        id: "01V-STARTED",
        command: "pnpm test",
        type: "test",
        linked_hypothesis_id: "01H1",
        state: "started",
      },
      {
        id: "01V-PASSED",
        command: "pnpm build",
        type: "build",
        linked_hypothesis_id: "01H1",
        state: "passed",
      },
    ];

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const spy = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      if (url.startsWith("/sessions/01SESSION/state")) {
        return Promise.resolve(
          new Response(envelope("session.state", buildStateResp(verifications)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.startsWith("/verify/01V-STARTED/cancel")) {
        return Promise.resolve(
          new Response(
            envelope("verification.cancelled", { id: "01V-STARTED", state: "cancelled" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    const user = userEvent.setup();
    renderVerification("01SESSION");

    // Wait for both rows to render.
    await screen.findAllByTestId("verification-row");
    // Non-terminal row's cancel button works.
    const startedRow = findRow("01V-STARTED");
    const startedCancel = within(startedRow).getByTestId("cancel-button");
    expect(startedCancel).not.toBeDisabled();
    await user.click(startedCancel);

    await waitFor(() => {
      const cancelCall = calls.find((c) => c.url === "/verify/01V-STARTED/cancel");
      expect(cancelCall).toBeDefined();
    });
    const cancelCall = calls.find((c) => c.url === "/verify/01V-STARTED/cancel")!;
    expect(cancelCall.init.method).toBe("POST");
    const body = JSON.parse(cancelCall.init.body as string);
    expect(body).toMatchObject({
      actor: { name: "dashboard", type: "system" },
    });

    // Terminal row's cancel button is disabled.
    const passedRow = findRow("01V-PASSED");
    const passedCancel = within(passedRow).getByTestId("cancel-button");
    expect(passedCancel).toBeDisabled();
  });
});