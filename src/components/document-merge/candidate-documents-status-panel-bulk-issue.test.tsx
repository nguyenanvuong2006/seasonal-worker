/**
 * CandidateDocumentsStatusPanel — bulk issue UI regression tests (2026-09,
 * Defect 3). Real render in jsdom (see render-tsx.ts), real clicks —
 * verifies row/select-all checkboxes are eligible-only (READY rows only),
 * the selected count and "Phát hành đã chọn (N)" button, and that the
 * request sent to the existing POST .../issue-ready endpoint carries
 * exactly the selected ids. Server-side enforcement itself (CAS,
 * idempotency, partial-failure isolation) is covered at the route level in
 * issue-ready-execution.test.ts — this file covers the UI's own contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../lib/test-support/render-tsx.ts";

type FetchCall = { url: string; method: string; body?: unknown };

const ROWS = [
  { id: "ready-1", applicationId: "a1", status: "READY", applicantFullName: "Ung vien A", templateName: "Mau A", issuedAt: null, viewedAt: null, errorMessage: null, confirmation: null },
  { id: "ready-2", applicationId: "a2", status: "READY", applicantFullName: "Ung vien B", templateName: "Mau A", issuedAt: null, viewedAt: null, errorMessage: null, confirmation: null },
  { id: "issued-1", applicationId: "a3", status: "ISSUED", applicantFullName: "Ung vien C", templateName: "Mau A", issuedAt: "2026-09-01T00:00:00Z", viewedAt: null, errorMessage: null, confirmation: null },
];

async function renderPanel(env: RenderEnv, opts: { onIssueReady?: (body: unknown) => { status: number; body: unknown } } = {}) {
  const calls: FetchCall[] = [];
  let currentRows = ROWS;

  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const bodyParsed = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method, body: bodyParsed });
    const json = async (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    if (url.endsWith("/api/document-merge/candidate-documents") && method === "GET") {
      const summary = {
        total: currentRows.length,
        generating: 0,
        ready: currentRows.filter((r) => r.status === "READY").length,
        issued: currentRows.filter((r) => r.status === "ISSUED").length,
        viewed: 0,
        confirmed: 0,
        failed: 0,
      };
      return json({ documents: currentRows, summary });
    }
    if (url.endsWith("/api/document-merge/candidate-documents/issue-ready") && method === "POST") {
      const result = opts.onIssueReady?.(bodyParsed) ?? { status: 200, body: { processed: 0, issued: 0, results: [] } };
      // Simulate the server-side effect for the next GET (fresh statuses).
      if (result.status === 200 && bodyParsed && Array.isArray((bodyParsed as { ids?: string[] }).ids)) {
        const ids = new Set((bodyParsed as { ids: string[] }).ids);
        currentRows = currentRows.map((r) => (ids.has(r.id) && r.status === "READY" ? { ...r, status: "ISSUED" } : r));
      }
      return json(result.body, result.status);
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

  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  return {
    calls,
    container,
    click,
    text: () => container.textContent ?? "",
    checkboxes: () => [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[],
    buttonsLabelled: (label: string) => [...container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label)),
  };
}

test("checkbox is present ONLY for READY (eligible) rows — never for ISSUED/CONFIRMED/etc.", async () => {
  const env = installDom();
  try {
    const ui = await renderPanel(env);
    // 1 header "select all" + 2 row checkboxes for the 2 READY rows = 3 total.
    assert.equal(ui.checkboxes().length, 3, "expected 1 select-all + 2 eligible-row checkboxes (ISSUED row has none)");
  } finally {
    env.cleanup();
  }
});

test("select 2 READY rows individually → count shows 2, bulk button shows 'Phát hành đã chọn (2)'", async () => {
  const env = installDom();
  try {
    const ui = await renderPanel(env);
    const rowCheckboxes = ui.checkboxes().slice(1); // skip header select-all
    for (const cb of rowCheckboxes) {
      await ui.click(cb);
    }
    assert.match(ui.text(), /Đã chọn 2 hồ sơ/);
    assert.ok(ui.buttonsLabelled("Phát hành đã chọn (2)").length > 0);
  } finally {
    env.cleanup();
  }
});

test("'Chọn tất cả' selects every eligible (READY) row at once, and toggling again deselects", async () => {
  const env = installDom();
  try {
    const ui = await renderPanel(env);
    const selectAll = ui.checkboxes()[0];
    await ui.click(selectAll);
    assert.match(ui.text(), /Đã chọn 2 hồ sơ/);

    await ui.click(selectAll);
    assert.doesNotMatch(ui.text(), /Đã chọn/);
  } finally {
    env.cleanup();
  }
});

test("clicking 'Phát hành đã chọn (N)' sends exactly the selected ids to POST .../issue-ready, then refreshes", async () => {
  const env = installDom();
  // installDom() installs its OWN confirm() stub (always true) AFTER this
  // point — any override set before installDom() would just be clobbered.
  (globalThis as Record<string, unknown>).confirm = () => true;
  try {
    const ui = await renderPanel(env, {
      onIssueReady: (body) => {
        const ids = (body as { ids: string[] }).ids;
        return { status: 200, body: { processed: ids.length, issued: ids.length, results: ids.map((id) => ({ id, outcome: "issued" })) } };
      },
    });
    const rowCheckboxes = ui.checkboxes().slice(1);
    await ui.click(rowCheckboxes[0]); // select only ready-1

    const bulkBtn = ui.buttonsLabelled("Phát hành đã chọn (1)")[0];
    await ui.click(bulkBtn);

    const issueCall = ui.calls.find((c) => c.url.endsWith("/issue-ready") && c.method === "POST");
    assert.ok(issueCall, "must POST to the existing issue-ready endpoint — no new endpoint reimplemented");
    // Body also carries the (default 3-day) confirmation-deadline policy
    // alongside `ids` — see confirmation-deadline.ts's DEFAULT_CONFIRMATION_WINDOW_DAYS.
    assert.deepEqual(issueCall!.body, { ids: ["ready-1"], deadlineDays: 3 });

    // After refresh, ready-1 is ISSUED and no longer selectable/selected.
    assert.doesNotMatch(ui.text(), /Đã chọn/, "selection must clear after a successful bulk issue");
  } finally {
    env.cleanup();
  }
});

test("declining the confirm() dialog sends no request", async () => {
  const env = installDom();
  (globalThis as Record<string, unknown>).confirm = () => false;
  try {
    const ui = await renderPanel(env);
    const rowCheckboxes = ui.checkboxes().slice(1);
    await ui.click(rowCheckboxes[0]);
    const bulkBtn = ui.buttonsLabelled("Phát hành đã chọn (1)")[0];
    await ui.click(bulkBtn);

    assert.equal(ui.calls.filter((c) => c.url.endsWith("/issue-ready")).length, 0);
  } finally {
    env.cleanup();
  }
});
