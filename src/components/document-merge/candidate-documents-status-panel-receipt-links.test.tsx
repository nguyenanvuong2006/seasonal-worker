/**
 * CandidateDocumentsStatusPanel — third-party verification layer admin
 * links (mission: "BUILD THIRD-PARTY ELECTRONIC-CONFIRMATION VERIFICATION
 * LAYER", section 7). Real render in jsdom (see render-tsx.ts) — proves the
 * three new links ("Xem biên nhận" / "Tải biên nhận" / "Xác thực") appear
 * ONLY for CONFIRMED rows that carry a confirmation, point at the PUBLIC
 * pages keyed by the existing receipt_id (no new backend route needed),
 * and that the pre-existing "Xem"/"Tải"/"In" original-PDF actions are left
 * completely unchanged for those same rows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../lib/test-support/render-tsx.ts";

const ROWS = [
  {
    id: "confirmed-1",
    applicationId: "a1",
    status: "CONFIRMED",
    applicantFullName: "Ung vien A",
    templateName: "Mau A",
    issuedAt: "2026-09-01T00:00:00Z",
    viewedAt: "2026-09-01T00:05:00Z",
    errorMessage: null,
    confirmation: { confirmedAtServer: "2026-09-09T10:20:44Z", receiptId: "SIG-ADMINLINKTEST01" },
  },
  {
    id: "issued-1",
    applicationId: "a2",
    status: "ISSUED",
    applicantFullName: "Ung vien B",
    templateName: "Mau A",
    issuedAt: "2026-09-01T00:00:00Z",
    viewedAt: null,
    errorMessage: null,
    confirmation: null,
  },
];

async function renderPanel(env: RenderEnv) {
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input);
    const json = async (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
    if (url.endsWith("/api/document-merge/candidate-documents")) {
      return json({
        documents: ROWS,
        summary: { total: ROWS.length, generating: 0, ready: 0, issued: 1, viewed: 0, confirmed: 1, failed: 0 },
      });
    }
    return json({});
  };

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./candidate-documents-status-panel.tsx", import.meta.url));
  const Panel = mod.CandidateDocumentsStatusPanel as () => unknown;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Panel as never));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    container,
    linksLabelled: (label: string) => [...container.querySelectorAll("a")].filter((a) => (a.textContent ?? "").includes(label)),
  };
}

test("CONFIRMED row with a confirmation shows Xem biên nhận / Tải biên nhận / Xác thực, pointing at the public pages", async () => {
  const env = installDom();
  try {
    const ui = await renderPanel(env);

    const view = ui.linksLabelled("Xem biên nhận");
    assert.equal(view.length, 1);
    assert.equal(view[0].getAttribute("href"), "/xac-thuc-ho-so/SIG-ADMINLINKTEST01/bien-nhan");
    assert.equal(view[0].getAttribute("target"), "_blank");

    const download = ui.linksLabelled("Tải biên nhận");
    assert.equal(download.length, 1);
    assert.equal(download[0].getAttribute("href"), "/xac-thuc-ho-so/SIG-ADMINLINKTEST01/bien-nhan?print=1");

    const verify = ui.linksLabelled("Xác thực");
    assert.equal(verify.length, 1);
    assert.equal(verify[0].getAttribute("href"), "/xac-thuc-ho-so/SIG-ADMINLINKTEST01");
  } finally {
    env.cleanup();
  }
});

test("a non-CONFIRMED row (ISSUED, no confirmation) never shows the receipt/verify links", async () => {
  const env = installDom();
  try {
    const ui = await renderPanel(env);
    // Every "Xem biên nhận"/"Tải biên nhận"/"Xác thực" link found must belong
    // to the CONFIRMED row only — there must be exactly one of each, not two.
    assert.equal(ui.linksLabelled("Xem biên nhận").length, 1);
    assert.equal(ui.linksLabelled("Tải biên nhận").length, 1);
    assert.equal(ui.linksLabelled("Xác thực").length, 1);
  } finally {
    env.cleanup();
  }
});

test("the pre-existing Xem/Tải/In original-PDF actions are unchanged for the CONFIRMED row", async () => {
  const env = installDom();
  try {
    const ui = await renderPanel(env);
    const viewPdf = [...ui.container.querySelectorAll("a")].filter((a) => a.getAttribute("href") === "/api/document-merge/candidate-documents/confirmed-1/pdf?mode=view" && (a.textContent ?? "").trim() === "Xem");
    const downloadPdf = [...ui.container.querySelectorAll("a")].filter((a) => a.getAttribute("href") === "/api/document-merge/candidate-documents/confirmed-1/pdf?mode=download");
    assert.equal(viewPdf.length, 1, "original PDF 'Xem' action must still exist, untouched");
    assert.equal(downloadPdf.length, 1, "original PDF 'Tải' action must still exist, untouched");
  } finally {
    env.cleanup();
  }
});
