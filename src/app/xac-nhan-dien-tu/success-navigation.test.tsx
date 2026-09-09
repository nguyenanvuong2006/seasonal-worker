/**
 * "Xem hồ sơ khác" navigation — real-render regression tests (2026-09,
 * Defect 2: after "XÁC NHẬN THÀNH CÔNG", the candidate was being sent back
 * to the CCCD+phone lookup screen instead of the document list, even though
 * a valid candidate_access_session cookie still exists).
 *
 * Renders the REAL page component in jsdom (same render-tsx.ts harness
 * publish-checklist-click.test.tsx already established for a "use client"
 * component) — a source-regex test could not catch this: the bug is about
 * runtime navigation state (React step + a stale document list), not a
 * missing/present function call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../lib/test-support/render-tsx.ts";

type FetchCall = { url: string; method: string };

const ISSUED_DOC = {
  id: "cdoc-1",
  templateName: "Đăng ký tập nghề",
  templateVersion: 20,
  regDate: "2026-09-01",
  issuedAt: "2026-09-09T08:05:14.000Z",
  status: "ISSUED",
  receipt: null,
};

const CONFIRMED_DOC = { ...ISSUED_DOC, status: "CONFIRMED", receipt: { receiptId: "SIG-ABC123", confirmedAtServer: "2026-09-09T10:20:44.892Z" } };

/**
 * Renders the real page.tsx. @/components/ui is loaded FOR REAL (through
 * the same vm harness — clsx/tailwind-merge/lucide-react only, no jsdom-
 * unsupported browser API) so button/input/badge behavior is genuine, not a
 * hand-rolled fake. @/components/brand-logo is stubbed to a no-op (it calls
 * `new Image()`, which jsdom does not expose on globalThis by default here —
 * irrelevant to this test's concern). @/lib/validators is loaded for real
 * (pure functions, zero DOM dependency).
 */
async function renderPage(env: RenderEnv, opts: { documentsQueue: Array<{ status: number; body: unknown }> }) {
  const calls: FetchCall[] = [];
  const queue = [...opts.documentsQueue];

  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const json = async (body: unknown, status = 200) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    if (url.endsWith("/api/candidate-consent/documents") && method === "GET") {
      const next = queue.shift() ?? { status: 401, body: { error: "Phiên tra cứu đã hết hạn. Vui lòng tra cứu lại." } };
      return json(next.body, next.status);
    }
    if (url.endsWith("/api/candidate-consent/lookup") && method === "POST") {
      return json({ success: true, sessionId: "sess-1", fullName: "Nguyen Van A" });
    }
    if (/\/api\/candidate-consent\/documents\/[^/]+\/confirm$/.test(url) && method === "POST") {
      return json({ receiptId: "SIG-ABC123", confirmedAtServer: "2026-09-09T10:20:44.892Z", documentVersion: 20 });
    }
    return json({});
  };

  const uiModule = loadComponent(new URL("../../components/ui.tsx", import.meta.url));
  const brandLogoStub = { BrandLogo: () => null };
  const validatorsModule = loadComponent(new URL("../../lib/validators.ts", import.meta.url));

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./page.tsx", import.meta.url), {
    stubs: {
      "@/components/ui": uiModule,
      "@/components/brand-logo": brandLogoStub,
      "@/lib/validators": validatorsModule,
    },
  });
  const CandidateConsentPage = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(CandidateConsentPage));
  });
  // Flush the mount-time session check (async fetch inside useEffect).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    calls,
    container,
    act,
    text: () => container.textContent ?? "",
    buttonsLabelled: (label: string) => [...container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim().includes(label)),
    click: async (el: Element) => {
      await act(async () => {
        el.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

test("mount with NO existing session (401) → shows the CCCD+phone lookup screen, not the document list", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, { documentsQueue: [{ status: 401, body: { error: "expired" } }] });
    assert.match(ui.text(), /TRA CỨU HỒ SƠ/);
    assert.doesNotMatch(ui.text(), /HỒ SƠ CỦA BẠN/);
  } finally {
    env.cleanup();
  }
});

test("mount with an ALREADY VALID session (200) → skips lookup entirely, shows the document list directly", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, { documentsQueue: [{ status: 200, body: { documents: [ISSUED_DOC] } }] });
    assert.match(ui.text(), /HỒ SƠ CỦA BẠN/);
    assert.doesNotMatch(ui.text(), /TRA CỨU HỒ SƠ/);
  } finally {
    env.cleanup();
  }
});

test("full flow: lookup → list → open → confirm → success → 'Xem hồ sơ khác' → SAME-session document list (not lookup), confirmed doc shows ĐÃ XÁC NHẬN", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, {
      documentsQueue: [
        { status: 401, body: {} }, // mount check: no session yet
        { status: 200, body: { documents: [ISSUED_DOC] } }, // after lookup
        { status: 200, body: { documents: [CONFIRMED_DOC] } }, // after "Xem hồ sơ khác" — refreshed, now CONFIRMED
      ],
    });

    // Step 1: lookup.
    assert.match(ui.text(), /TRA CỨU HỒ SƠ/);
    const cccdInput = ui.container.querySelector("input") as HTMLInputElement;
    const phoneInput = ui.container.querySelectorAll("input")[1] as HTMLInputElement;
    const setValue = async (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(env.window.HTMLInputElement.prototype, "value")!.set!;
      await ui.act(async () => {
        setter.call(el, value);
        el.dispatchEvent(new env.window.Event("input", { bubbles: true }));
      });
    };
    await setValue(cccdInput, "123456789012");
    await setValue(phoneInput, "0912345678");
    const submitBtn = ui.buttonsLabelled("Tiếp tục")[0];
    await ui.click(submitBtn);

    // Step 2: document list, one ISSUED document.
    assert.match(ui.text(), /HỒ SƠ CỦA BẠN/);
    assert.match(ui.text(), /CẦN XÁC NHẬN/);

    // Open the document (step 3) — checkbox present.
    const docCard = ui.container.querySelector(".cursor-pointer") as HTMLElement;
    await ui.click(docCard);
    const checkbox = ui.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    assert.ok(checkbox, "consent checkbox must be present on step 3");

    // Check it, then confirm.
    await ui.act(async () => {
      checkbox.click();
    });
    const confirmBtn = ui.buttonsLabelled("Xác nhận đồng ý")[0] as HTMLButtonElement;
    assert.equal(confirmBtn.disabled, false, "confirm button must be enabled once checkbox is checked");
    await ui.click(confirmBtn);

    // Step 4: success screen.
    assert.match(ui.text(), /XÁC NHẬN THÀNH CÔNG/);
    assert.match(ui.text(), /SIG-ABC123/);

    // "Xem hồ sơ khác" → must land back on the DOCUMENT LIST, not the lookup screen — reusing the same session (no new /lookup call).
    const lookupCallsBefore = ui.calls.filter((c) => c.url.endsWith("/api/candidate-consent/lookup")).length;
    const backBtn = ui.buttonsLabelled("Xem hồ sơ khác")[0];
    await ui.click(backBtn);

    assert.match(ui.text(), /HỒ SƠ CỦA BẠN/, "must return to the document list");
    assert.doesNotMatch(ui.text(), /TRA CỨU HỒ SƠ/, "must NOT reset to the CCCD+phone lookup screen");
    assert.match(ui.text(), /ĐÃ XÁC NHẬN/, "the just-confirmed document must show its refreshed CONFIRMED status, not the stale ISSUED one");
    const lookupCallsAfter = ui.calls.filter((c) => c.url.endsWith("/api/candidate-consent/lookup")).length;
    assert.equal(lookupCallsAfter, lookupCallsBefore, "'Xem hồ sơ khác' must never re-invoke /lookup — the existing session is reused");
  } finally {
    env.cleanup();
  }
});

test("expired/revoked session → 'Xem hồ sơ khác' (or any documents refresh) sends the candidate back to the lookup screen", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, {
      documentsQueue: [
        { status: 200, body: { documents: [CONFIRMED_DOC] } }, // valid session at mount — starts on the list
        { status: 401, body: { error: "Phiên tra cứu đã hết hạn. Vui lòng tra cứu lại." } }, // session expired by the time of the next check
      ],
    });

    assert.match(ui.text(), /HỒ SƠ CỦA BẠN/);

    // Simulate opening the confirmed doc (goes straight to step 4 per openDocument's CONFIRMED branch), then clicking "Xem hồ sơ khác".
    const docCard = ui.container.querySelector(".cursor-pointer") as HTMLElement;
    await ui.click(docCard);
    assert.match(ui.text(), /XÁC NHẬN THÀNH CÔNG|ĐÃ XÁC NHẬN/);

    const backBtn = ui.buttonsLabelled("Xem hồ sơ khác")[0];
    await ui.click(backBtn);

    assert.match(ui.text(), /TRA CỨU HỒ SƠ/, "an expired/revoked session must send the candidate back to the lookup screen");
  } finally {
    env.cleanup();
  }
});
