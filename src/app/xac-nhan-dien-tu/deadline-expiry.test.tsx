/**
 * Candidate "Xác nhận điện tử" page — confirmation-deadline UI regression
 * tests (2026-09-10, Electronic Confirmation deadline mission). Real render
 * in jsdom, same harness as success-navigation.test.tsx.
 *
 * Proves: the document list splits into "CẦN XÁC NHẬN" (actionable) and
 * "LỊCH SỬ" (everything else — CONFIRMED + EXPIRED) sections; an
 * ISSUED/VIEWED document whose effectiveStatus is EXPIRED still OPENS (the
 * document stays viewable) but shows a blocking banner instead of the
 * consent checkbox/confirm button — never a silent dead end, and never a
 * fake client-only countdown standing in for real enforcement (the server
 * confirm route is the actual authority — this is UI-only, matching the
 * mission's "informational Còn N ngày" requirement).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../lib/test-support/render-tsx.ts";

type FetchCall = { url: string; method: string };

const ACTIONABLE_DOC = {
  id: "cdoc-1",
  templateName: "Đăng ký tập nghề",
  templateVersion: 20,
  regDate: "2026-09-01",
  issuedAt: "2026-09-09T08:05:14.000Z",
  status: "ISSUED",
  effectiveStatus: "ISSUED",
  actionable: true,
  confirmationDeadlineAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  receipt: null,
};

const EXPIRED_DOC = {
  id: "cdoc-2",
  templateName: "Đăng ký tập nghề (lần 2)",
  templateVersion: 21,
  regDate: "2026-01-01",
  issuedAt: "2026-01-01T08:05:14.000Z",
  status: "ISSUED",
  effectiveStatus: "EXPIRED",
  actionable: false,
  confirmationDeadlineAt: "2026-01-04T08:05:14.000Z",
  receipt: null,
};

const CONFIRMED_DOC = {
  id: "cdoc-3",
  templateName: "Đăng ký tập nghề (lần 1)",
  templateVersion: 18,
  regDate: "2025-06-01",
  issuedAt: "2025-06-01T08:05:14.000Z",
  status: "CONFIRMED",
  effectiveStatus: "CONFIRMED",
  actionable: false,
  confirmationDeadlineAt: "2025-06-04T08:05:14.000Z",
  receipt: { receiptId: "SIG-OLD1", confirmedAtServer: "2025-06-02T00:00:00.000Z" },
};

async function renderPage(env: RenderEnv, opts: { documents: Record<string, unknown>[] }) {
  const calls: FetchCall[] = [];

  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const json = async (body: unknown, status = 200) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    if (url.endsWith("/api/candidate-consent/documents") && method === "GET") {
      return json({ documents: opts.documents });
    }
    if (/\/api\/candidate-consent\/documents\/[^/]+\/confirm$/.test(url) && method === "POST") {
      return json({ error: "Hồ sơ đã hết hạn xác nhận.", code: "CONFIRMATION_EXPIRED" }, 409);
    }
    return json({});
  };

  const uiModule = loadComponent(new URL("../../components/ui.tsx", import.meta.url));
  const brandLogoStub = { BrandLogo: () => null };
  const validatorsModule = loadComponent(new URL("../../lib/validators.ts", import.meta.url));
  const confirmationDeadlineModule = loadComponent(new URL("../../lib/candidate-consent/confirmation-deadline.ts", import.meta.url));

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./page.tsx", import.meta.url), {
    stubs: {
      "@/components/ui": uiModule,
      "@/components/brand-logo": brandLogoStub,
      "@/lib/validators": validatorsModule,
      "@/lib/candidate-consent/confirmation-deadline": confirmationDeadlineModule,
    },
  });
  const CandidateConsentPage = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(CandidateConsentPage));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    calls,
    container,
    text: () => container.textContent ?? "",
    cards: () => [...container.querySelectorAll(".cursor-pointer")] as HTMLElement[],
    click: async (el: Element) => {
      await act(async () => {
        el.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

test("actionable + history documents render in their own sections: CẦN XÁC NHẬN then LỊCH SỬ", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, { documents: [ACTIONABLE_DOC, CONFIRMED_DOC, EXPIRED_DOC] });
    const text = ui.text();
    assert.match(text, /CẦN XÁC NHẬN/);
    assert.match(text, /LỊCH SỬ/);
    // Actionable section (CẦN XÁC NHẬN heading) must appear BEFORE the history section.
    assert.ok(text.indexOf("CẦN XÁC NHẬN") < text.indexOf("LỊCH SỬ"));
  } finally {
    env.cleanup();
  }
});

test("an expired document still OPENS on click (stays viewable) rather than being blocked from the list entirely", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, { documents: [EXPIRED_DOC] });
    const card = ui.cards()[0];
    assert.ok(card, "the expired document card must still be clickable");
    await ui.click(card);
    assert.match(ui.text(), /Đăng ký tập nghề \(lần 2\)/, "the document detail view must open");
    // The PDF iframe (document itself) must still render — never blocked from viewing.
    const iframe = ui.container.querySelector("iframe");
    assert.ok(iframe, "the PDF must remain viewable even past the deadline");
  } finally {
    env.cleanup();
  }
});

test("an expired document shows the blocking banner instead of the consent checkbox/confirm button", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, { documents: [EXPIRED_DOC] });
    await ui.click(ui.cards()[0]);
    assert.match(ui.text(), /Hồ sơ đã hết hạn xác nhận/);
    const checkbox = ui.container.querySelector('input[type="checkbox"]');
    assert.equal(checkbox, null, "no consent checkbox must be offered for an expired document");
    const buttons = [...ui.container.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    assert.ok(!buttons.some((t) => t.includes("Xác nhận đồng ý")), "no confirm button must be offered for an expired document");
  } finally {
    env.cleanup();
  }
});

test("an actionable (not yet expired) document shows the deadline + informational remaining-time text, checkbox/button present", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, { documents: [ACTIONABLE_DOC] });
    await ui.click(ui.cards()[0]);
    assert.match(ui.text(), /Hạn xác nhận:/);
    assert.match(ui.text(), /Còn \d+ ngày/);
    const checkbox = ui.container.querySelector('input[type="checkbox"]');
    assert.ok(checkbox, "consent checkbox must be present for a still-valid document");
  } finally {
    env.cleanup();
  }
});

test("CONFIRMED document opens straight to the receipt view (step 4), not the deadline-gated consent view", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, { documents: [CONFIRMED_DOC] });
    await ui.click(ui.cards()[0]);
    assert.match(ui.text(), /SIG-OLD1/, "must show the existing receipt, not re-prompt for consent");
  } finally {
    env.cleanup();
  }
});
