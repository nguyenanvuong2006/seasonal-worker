/**
 * CandidateDocumentsStatusPanel — confirmation-deadline UI regression tests
 * (2026-09-10, Electronic Confirmation deadline mission). Real render in
 * jsdom, real clicks — verifies: the deadline preset picker defaults to 3
 * days and its choice is sent with single/bulk issue requests; the deadline
 * column renders confirmationDeadlineAt/engagementStartingDate; the
 * EXPIRED effective status overrides the badge for an ISSUED row past its
 * deadline while the row's underlying actions still key off the real
 * status; and "Gia hạn" only appears for ISSUED/VIEWED rows and posts to
 * the new extend-deadline endpoint.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../lib/test-support/render-tsx.ts";

type FetchCall = { url: string; method: string; body?: unknown };

async function renderPanel(env: RenderEnv, rows: Record<string, unknown>[], opts: { onExtend?: (body: unknown) => { status: number; body: unknown } } = {}) {
  const calls: FetchCall[] = [];

  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const bodyParsed = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method, body: bodyParsed });
    const json = async (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    if (url.endsWith("/api/document-merge/candidate-documents") && method === "GET") {
      const summary = {
        total: rows.length,
        generating: 0,
        ready: rows.filter((r) => r.status === "READY").length,
        issued: rows.filter((r) => r.status === "ISSUED").length,
        viewed: 0,
        confirmed: 0,
        failed: 0,
        expired: rows.filter((r) => r.effectiveStatus === "EXPIRED").length,
      };
      return json({ documents: rows, summary });
    }
    if (url.includes("/issue-ready") && method === "POST") {
      return json({ processed: 0, issued: 0, results: [] });
    }
    if (url.endsWith("/issue") && method === "POST") {
      return json({ success: true, id: "d1", status: "ISSUED", alreadyIssued: false, confirmationDeadlineAt: new Date().toISOString() });
    }
    if (url.endsWith("/extend-deadline") && method === "POST") {
      const result = opts.onExtend?.(bodyParsed) ?? { status: 200, body: { success: true } };
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
    buttonsLabelled: (label: string) => [...container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label)),
    deadlineSelect: () => container.querySelector('select[aria-label="Hạn xác nhận"]') as HTMLSelectElement,
  };
}

test("deadline preset selector defaults to 3 ngày and its value is sent as deadlineDays with a single 'Phát hành'", async () => {
  const env = installDom();
  (globalThis as Record<string, unknown>).confirm = () => true;
  try {
    const rows = [{ id: "d1", applicationId: "a1", status: "READY", effectiveStatus: "READY", applicantFullName: "Ung vien A", templateName: "Mau A", issuedAt: null, viewedAt: null, confirmationDeadlineAt: null, engagementStartingDate: null, errorMessage: null, confirmation: null }];
    const ui = await renderPanel(env, rows);
    assert.equal(ui.deadlineSelect().value, "3");

    // "Phát hành" alone matches the per-row button exactly; the batch/bulk
    // buttons always carry a "(...)" count suffix, so an exact-trim match
    // disambiguates the single-row action from them.
    const issueBtn = ui.buttonsLabelled("Phát hành").find((b) => (b.textContent ?? "").trim() === "Phát hành");
    assert.ok(issueBtn);
    await ui.click(issueBtn!);
    const issueCall = ui.calls.find((c) => c.url.endsWith("/d1/issue") && c.method === "POST");
    assert.ok(issueCall);
    assert.deepEqual(issueCall!.body, { deadlineDays: 3 });
  } finally {
    env.cleanup();
  }
});

test("changing the preset to 7 ngày sends deadlineDays: 7 with a batch issue", async () => {
  const env = installDom();
  (globalThis as Record<string, unknown>).confirm = () => true;
  try {
    const rows = [{ id: "d1", applicationId: "a1", status: "READY", effectiveStatus: "READY", applicantFullName: "Ung vien A", templateName: "Mau A", issuedAt: null, viewedAt: null, confirmationDeadlineAt: null, engagementStartingDate: null, errorMessage: null, confirmation: null }];
    const ui = await renderPanel(env, rows);

    const select = ui.deadlineSelect();
    await (async () => {
      const { act } = await import("react");
      await act(async () => {
        select.value = "7";
        select.dispatchEvent(new env.window.Event("change", { bubbles: true }));
        await Promise.resolve();
      });
    })();
    assert.equal(select.value, "7");

    const batchBtn = ui.buttonsLabelled("Phát hành hồ sơ đã sẵn sàng")[0];
    await ui.click(batchBtn);
    const call = ui.calls.find((c) => c.url.endsWith("/issue-ready") && c.method === "POST");
    assert.ok(call);
    assert.deepEqual(call!.body, { deadlineDays: 7 });
  } finally {
    env.cleanup();
  }
});

test("deadline column shows the formatted confirmationDeadlineAt and engagementStartingDate", async () => {
  const env = installDom();
  try {
    const rows = [
      {
        id: "d1",
        applicationId: "a1",
        status: "ISSUED",
        effectiveStatus: "ISSUED",
        applicantFullName: "Ung vien A",
        templateName: "Mau A",
        issuedAt: "2026-09-10T00:00:00Z",
        viewedAt: null,
        confirmationDeadlineAt: "2026-09-13T10:00:00.000Z",
        engagementStartingDate: "2026-09-15",
        errorMessage: null,
        confirmation: null,
      },
    ];
    const ui = await renderPanel(env, rows);
    assert.match(ui.text(), /2026-09-15/, "engagement starting date must be shown");
    assert.match(ui.text(), /13\/09\/2026/, "formatted confirmation deadline must be shown");
  } finally {
    env.cleanup();
  }
});

test("an ISSUED row with effectiveStatus EXPIRED shows the HẾT HẠN badge, while 'Gia hạn' (keyed off the real persisted status) is still offered", async () => {
  const env = installDom();
  try {
    const rows = [
      {
        id: "d1",
        applicationId: "a1",
        status: "ISSUED",
        effectiveStatus: "EXPIRED",
        applicantFullName: "Ung vien A",
        templateName: "Mau A",
        issuedAt: "2026-01-01T00:00:00Z",
        viewedAt: null,
        confirmationDeadlineAt: "2026-01-04T00:00:00.000Z",
        engagementStartingDate: null,
        errorMessage: null,
        confirmation: null,
      },
    ];
    const ui = await renderPanel(env, rows);
    assert.match(ui.text(), /HẾT HẠN/);
    assert.ok(ui.buttonsLabelled("Gia hạn").length === 1, "Gia hạn must still be offered for an EXPIRED-effective ISSUED row");
  } finally {
    env.cleanup();
  }
});

test("'Gia hạn' is never shown for a CONFIRMED row (nothing left to extend)", async () => {
  const env = installDom();
  try {
    const rows = [
      {
        id: "d1",
        applicationId: "a1",
        status: "CONFIRMED",
        effectiveStatus: "CONFIRMED",
        applicantFullName: "Ung vien A",
        templateName: "Mau A",
        issuedAt: "2026-01-01T00:00:00Z",
        viewedAt: "2026-01-02T00:00:00Z",
        confirmationDeadlineAt: "2026-01-04T00:00:00.000Z",
        engagementStartingDate: null,
        errorMessage: null,
        confirmation: { confirmedAtServer: "2026-01-02T00:00:00Z", receiptId: "receipt-1" },
      },
    ];
    const ui = await renderPanel(env, rows);
    assert.equal(ui.buttonsLabelled("Gia hạn").length, 0);
  } finally {
    env.cleanup();
  }
});

test("clicking 'Gia hạn' posts to the extend-deadline endpoint with the selected deadline policy and refreshes", async () => {
  const env = installDom();
  (globalThis as Record<string, unknown>).confirm = () => true;
  try {
    const rows = [
      {
        id: "d1",
        applicationId: "a1",
        status: "VIEWED",
        effectiveStatus: "VIEWED",
        applicantFullName: "Ung vien A",
        templateName: "Mau A",
        issuedAt: "2026-01-01T00:00:00Z",
        viewedAt: "2026-01-02T00:00:00Z",
        confirmationDeadlineAt: "2099-01-04T00:00:00.000Z",
        engagementStartingDate: null,
        errorMessage: null,
        confirmation: null,
      },
    ];
    const ui = await renderPanel(env, rows);
    const extendBtn = ui.buttonsLabelled("Gia hạn")[0];
    await ui.click(extendBtn);

    const extendCall = ui.calls.find((c) => c.url.endsWith("/d1/extend-deadline") && c.method === "POST");
    assert.ok(extendCall, "must POST to the new extend-deadline endpoint");
    assert.deepEqual(extendCall!.body, { deadlineDays: 3 });
  } finally {
    env.cleanup();
  }
});

test("declining the confirm() dialog on 'Gia hạn' sends no request", async () => {
  const env = installDom();
  (globalThis as Record<string, unknown>).confirm = () => false;
  try {
    const rows = [
      {
        id: "d1",
        applicationId: "a1",
        status: "ISSUED",
        effectiveStatus: "ISSUED",
        applicantFullName: "Ung vien A",
        templateName: "Mau A",
        issuedAt: "2026-01-01T00:00:00Z",
        viewedAt: null,
        confirmationDeadlineAt: "2099-01-04T00:00:00.000Z",
        engagementStartingDate: null,
        errorMessage: null,
        confirmation: null,
      },
    ];
    const ui = await renderPanel(env, rows);
    const extendBtn = ui.buttonsLabelled("Gia hạn")[0];
    await ui.click(extendBtn);
    assert.equal(ui.calls.filter((c) => c.url.endsWith("/extend-deadline")).length, 0);
  } finally {
    env.cleanup();
  }
});
