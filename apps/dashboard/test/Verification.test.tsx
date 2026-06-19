/**
 * apps/dashboard/test/Verification.test.tsx — redesigned page tests.
 *
 * Cases:
 *  1. Renders DataTable rows with StatusPill
 *  2. RerunButton POSTs /verify
 *  3. CancelButton POSTs /verify/:id/cancel and is disabled on terminal rows
 *  4. Accordion reveals stdout + linked hypothesis
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SidebarProvider } from "@/widgets/sidebar/sidebar-provider";
import { VerificationPage } from "@/pages/verification";

const envelope = (data: unknown): string =>
  JSON.stringify({ version: 1, kind: "test", data });

type VerificationWire = {
  id: string;
  command: string;
  type: "test" | "lint" | "build" | "exec" | "typecheck";
  linked_hypothesis_id: string | null;
  state: "started" | "passed" | "failed" | "errored" | "cancelled";
  duration_ms?: number | null;
  stdout_excerpt?: string | null;
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
      <SidebarProvider>
        <Routes>
          <Route path="/verification" element={<VerificationPage />} />
        </Routes>
      </SidebarProvider>
    </MemoryRouter>,
  );

describe("VerificationPage (6.8.2.P4)", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders DataTable rows with StatusPill", async () => {
    const verifications: VerificationWire[] = [
      { id: "01V1", command: "pnpm test", type: "test", linked_hypothesis_id: "01H1", state: "passed" },
      { id: "01V2", command: "pnpm lint", type: "lint", linked_hypothesis_id: "01H1", state: "started" },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/state")) {
        return Promise.resolve(new Response(envelope(buildStateResp(verifications)), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderVerification("01SESSION");

    expect(await screen.findByTestId("verification-page")).toBeInTheDocument();
    await waitFor(() => {
      // 2 rows in the DataTable + 2 status pills in the Accordion
      expect(screen.getAllByTestId("verification-status").length).toBeGreaterThanOrEqual(2);
    });
    // Each command renders once in the DataTable + once in the Accordion
    expect(screen.getAllByText("pnpm test").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("pnpm lint").length).toBeGreaterThanOrEqual(1);
  });

  it("RerunButton POSTs /verify with the right body", async () => {
    const verifications: VerificationWire[] = [
      { id: "01V-STARTED", command: "pnpm test", type: "test", linked_hypothesis_id: "01H1", state: "started" },
    ];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      if (String(url).includes("/state")) {
        return Promise.resolve(new Response(envelope(buildStateResp(verifications)), { status: 200 }));
      }
      if (url === "/api/verify" && (init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          new Response(envelope({ id: "01V-NEW", session_id: "01SESSION" }), { status: 201 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderVerification("01SESSION");

    const rerun = await screen.findByTestId("verification-rerun");
    await user.click(rerun);

    await waitFor(() => {
      const postCall = calls.find((c) => c.url === "/api/verify");
      expect(postCall).toBeDefined();
    });
    const body = JSON.parse(calls.find((c) => c.url === "/api/verify")!.init.body as string);
    expect(body).toMatchObject({
      session_id: "01SESSION",
      command: "pnpm test",
      type: "test",
      actor: { name: "dashboard", type: "system" },
      linked_hypothesis_id: "01H1",
    });
  });

  it("CancelButton POSTs /verify/:id/cancel and is disabled on terminal rows", async () => {
    const verifications: VerificationWire[] = [
      { id: "01V-STARTED", command: "pnpm test", type: "test", linked_hypothesis_id: "01H1", state: "started" },
      { id: "01V-PASSED", command: "pnpm build", type: "build", linked_hypothesis_id: "01H1", state: "passed" },
    ];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      if (String(url).includes("/state")) {
        return Promise.resolve(new Response(envelope(buildStateResp(verifications)), { status: 200 }));
      }
      if (url.startsWith("/api/verify/01V-STARTED/cancel")) {
        return Promise.resolve(
          new Response(envelope({ id: "01V-STARTED", state: "cancelled" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderVerification("01SESSION");

    const cancels = await screen.findAllByTestId("verification-cancel");
    expect(cancels).toHaveLength(2);
    const firstCancel = cancels[0]!;
    const secondCancel = cancels[1]!;
    expect(firstCancel).not.toBeDisabled();
    expect(secondCancel).toBeDisabled();

    await user.click(firstCancel);
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/verify/01V-STARTED/cancel");
      expect(call).toBeDefined();
    });
  });

  it("Accordion reveals stdout + linked hypothesis", async () => {
    const verifications: VerificationWire[] = [
      {
        id: "01V1",
        command: "pnpm test",
        type: "test",
        linked_hypothesis_id: "01H1",
        state: "passed",
        duration_ms: 1023,
        stdout_excerpt: "Tests passed: 42",
      },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/state")) {
        return Promise.resolve(new Response(envelope(buildStateResp(verifications)), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch;

    renderVerification("01SESSION");

    const stdout = await screen.findByTestId("verification-stdout");
    expect(stdout).toHaveTextContent("Tests passed: 42");
  });
});
