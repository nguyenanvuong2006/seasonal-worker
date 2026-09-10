/**
 * Worker Profiles page — "Lịch sử hồ sơ xác nhận điện tử" section
 * regression test (2026-09-10 mission). Real render in jsdom.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

async function renderPage(env: RenderEnv) {
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input);
    const json = async (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
    if (url.includes("/api/worker-profiles/")) {
      return json({
        profile: { id: "w1", cccd: "010000000001", fullName: "Nguyen Van A", gender: null, dob: null, phone: null, permanentAddress: null, residentialAddress: null, fingerprintCode: null, fingerprintDevice: null, fingerprintStatus: null },
        sessions: [],
        confirmationHistory: [
          {
            documentId: "doc-2",
            applicationId: "app-2",
            employmentSessionId: "sess-2",
            engagementStartingDate: "2026-09-01",
            templateVersion: 2,
            documentKind: "GENERIC",
            status: "ISSUED",
            effectiveStatus: "ISSUED",
            issuedAt: "2026-09-01T00:00:00Z",
            confirmationDeadlineAt: "2026-09-04T00:00:00Z",
            viewedAt: null,
            confirmedAt: null,
            receiptId: null,
          },
          {
            documentId: "doc-1",
            applicationId: "app-1",
            employmentSessionId: "sess-1",
            engagementStartingDate: "2026-01-01",
            templateVersion: 1,
            documentKind: "GENERIC",
            status: "CONFIRMED",
            effectiveStatus: "CONFIRMED",
            issuedAt: "2026-01-01T00:00:00Z",
            confirmationDeadlineAt: "2026-01-04T00:00:00Z",
            viewedAt: "2026-01-02T00:00:00Z",
            confirmedAt: "2026-01-02T01:00:00Z",
            receiptId: "receipt-old-1",
          },
        ],
      });
    }
    return json({});
  };

  const uiModule = loadComponent(new URL("../../../../components/ui.tsx", import.meta.url));
  const validatorsModule = loadComponent(new URL("../../../../lib/validators.ts", import.meta.url));
  const confirmationDeadlineModule = loadComponent(new URL("../../../../lib/candidate-consent/confirmation-deadline.ts", import.meta.url));
  const nextNavigationStub = { useSearchParams: () => new URLSearchParams() };

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./page.tsx", import.meta.url), {
    stubs: {
      "@/components/ui": uiModule,
      "@/lib/validators": validatorsModule,
      "@/lib/candidate-consent/confirmation-deadline": confirmationDeadlineModule,
      "next/navigation": nextNavigationStub,
    },
  });
  const Page = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Page));
  });

  return {
    container,
    act,
    text: () => container.textContent ?? "",
  };
}

test("worker-profiles page renders the Electronic Confirmation history section, newest engagement first, with a receipt link for a confirmed old entry", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    const cccdInput = ui.container.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(env.window.HTMLInputElement.prototype, "value")!.set!;
    await ui.act(async () => {
      setter.call(cccdInput, "010000000001");
      cccdInput.dispatchEvent(new env.window.Event("input", { bubbles: true }));
    });
    const searchBtn = [...ui.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Tra cứu")) as HTMLButtonElement;
    await ui.act(async () => {
      searchBtn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = ui.text();
    assert.match(text, /Lịch sử hồ sơ xác nhận điện tử — 2 hồ sơ/);
    assert.match(text, /Đợt bắt đầu 2026-09-01/);
    assert.match(text, /Đợt bắt đầu 2026-01-01/);
    // Newest engagement (2026-09-01) must render before the older one (2026-01-01).
    assert.ok(text.indexOf("2026-09-01") < text.indexOf("2026-01-01"));
    assert.match(text, /Xem biên nhận/, "the confirmed old document must expose its receipt link");
  } finally {
    env.cleanup();
  }
});
