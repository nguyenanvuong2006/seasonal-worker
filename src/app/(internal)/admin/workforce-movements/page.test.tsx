/**
 * WorkforceMovementsPage — BULK RESIGNATION APPROVAL UI (2026-09). Real
 * render in jsdom (same render-tsx.ts harness as ai-assistant/page.test.tsx
 * and candidate-documents-status-panel-bulk-issue.test.tsx). Proves:
 *
 *   - a checkbox exists ONLY for resignation rows currently at PENDING_HR
 *     (the same eligibility the existing single-row "Duyệt nghỉ việc"
 *     button already uses) — never for INACTIVE/REJECTED/transfer rows.
 *   - single + multi selection, "Chọn tất cả đang chờ duyệt" (select/
 *     deselect all eligible at once).
 *   - clicking "Duyệt nghỉ việc đã chọn (N)" opens exactly ONE confirmation
 *     dialog naming N — never N separate confirmations.
 *   - confirming sends exactly ONE POST to bulk-approve-resignation with
 *     the selected ids — never N separate PATCH calls (the old manual
 *     "approve, wait, next" workflow).
 *   - cancelling the confirmation sends zero requests.
 *   - after a response, ONE consolidated result summary renders (Thành
 *     công/Bỏ qua/Lỗi) — never one toast per worker — and the list
 *     refreshes.
 *   - the existing single-row "Duyệt nghỉ việc" PATCH flow is unaffected
 *     (regression guard) — bulk is additive, not a replacement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

type FetchResponse = { status: number; jsonText: string };
type FetchCall = { method: string; url: string; body: unknown };

const DEPTS = { rows: [{ id: "d1", deptName: "Đóng gói", groupName: null }] };
const STAGES_RESIGNATION = { rows: [{ stageKey: "PENDING_HR", label: "Chờ HR duyệt", color: "amber" }, { stageKey: "INACTIVE", label: "Đã nghỉ việc", color: "gray" }, { stageKey: "REJECTED", label: "HR từ chối", color: "red" }] };
const STAGES_TRANSFER = { rows: [{ stageKey: "PENDING_HR", label: "Chờ HR duyệt", color: "amber" }] };

const ROWS = [
  { id: "m1", movementType: "resignation", workerId: "w1", workerName: "Nguyen Van A", workerCccd: "010000000001", fromDeptId: "d1", toDeptId: null, effectiveDate: "2026-09-15", reason: null, note: null, status: "PENDING_HR", relatedMovementId: null, requestedBy: "manager1", createdAt: "2026-09-01T00:00:00Z" },
  { id: "m2", movementType: "resignation", workerId: "w2", workerName: "Tran Thi B", workerCccd: "010000000002", fromDeptId: "d1", toDeptId: null, effectiveDate: "2026-09-16", reason: null, note: null, status: "PENDING_HR", relatedMovementId: null, requestedBy: "manager1", createdAt: "2026-09-01T00:00:00Z" },
  { id: "m3", movementType: "resignation", workerId: "w3", workerName: "Le Van C", workerCccd: "010000000003", fromDeptId: "d1", toDeptId: null, effectiveDate: "2026-08-01", reason: null, note: null, status: "INACTIVE", relatedMovementId: null, requestedBy: "manager1", createdAt: "2026-08-01T00:00:00Z" },
  { id: "m4", movementType: "transfer", workerId: "w4", workerName: "Pham Thi D", workerCccd: "010000000004", fromDeptId: "d1", toDeptId: "d1", effectiveDate: "2026-09-20", reason: null, note: null, status: "PENDING_HR", relatedMovementId: null, requestedBy: "manager1", createdAt: "2026-09-01T00:00:00Z" },
];

async function renderPage(env: RenderEnv, respond: (method: string, url: string, body: unknown) => FetchResponse) {
  const requests: FetchCall[] = [];
  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url, body });
    const picked = respond(method, url, body);
    return { ok: picked.status >= 200 && picked.status < 300, status: picked.status, json: async () => JSON.parse(picked.jsonText) } as unknown as Response;
  };

  const uiModule = loadComponent(new URL("../../../../components/ui.tsx", import.meta.url));
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./page.tsx", import.meta.url), {
    stubs: {
      "@/components/ui": uiModule,
      "next/navigation": { useSearchParams: () => ({ get: () => null }) },
    },
  });
  const Page = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Page));
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }

  return {
    container,
    requests,
    text: () => container.textContent ?? "",
    checkboxes: () => [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[],
    buttonsLabelled: (label: string) => [...container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label)),
    async click(el: Element) {
      await act(async () => {
        el.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
    },
    async clickLabelled(label: string) {
      const el = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
      if (!el) throw new Error(`No button found matching "${label}"`);
      await act(async () => {
        el.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
    },
  };
}

function defaultRespond(overrides: Partial<Record<string, FetchResponse>> = {}) {
  return (method: string, url: string): FetchResponse => {
    if (url.endsWith("/api/workforce-movements") && method === "GET") return overrides.movements ?? { status: 200, jsonText: JSON.stringify({ rows: ROWS }) };
    if (url.includes("/api/departments")) return overrides.depts ?? { status: 200, jsonText: JSON.stringify(DEPTS) };
    if (url.includes("entityType=resignation")) return overrides.stagesResignation ?? { status: 200, jsonText: JSON.stringify(STAGES_RESIGNATION) };
    if (url.includes("entityType=transfer")) return overrides.stagesTransfer ?? { status: 200, jsonText: JSON.stringify(STAGES_TRANSFER) };
    return { status: 200, jsonText: "{}" };
  };
}

test("checkbox exists ONLY for eligible rows (resignation + PENDING_HR) — never INACTIVE or transfer rows", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    // 1 header "select all" + 2 eligible rows (m1, m2) = 3 total. m3 (INACTIVE) and m4 (transfer) get none.
    assert.equal(ui.checkboxes().length, 3, "expected header select-all + exactly 2 eligible-row checkboxes");
  } finally {
    env.cleanup();
  }
});

test("single selection: checking one eligible row shows the bulk bar with 'Đã chọn: 1' and the approve button", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    const rowBoxes = ui.checkboxes().slice(1);
    await ui.click(rowBoxes[0]);
    assert.match(ui.text(), /Đã chọn: 1/);
    assert.ok(ui.buttonsLabelled("Duyệt nghỉ việc đã chọn (1)").length > 0);
  } finally {
    env.cleanup();
  }
});

test("multiple selection: checking both eligible rows shows 'Đã chọn: 2'", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    const rowBoxes = ui.checkboxes().slice(1);
    await ui.click(rowBoxes[0]);
    await ui.click(rowBoxes[1]);
    assert.match(ui.text(), /Đã chọn: 2/);
  } finally {
    env.cleanup();
  }
});

test("'Chọn tất cả đang chờ duyệt' selects every eligible row, toggling again deselects", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    const selectAll = ui.checkboxes()[0];
    await ui.click(selectAll);
    assert.match(ui.text(), /Đã chọn: 2/);
    await ui.click(selectAll);
    assert.doesNotMatch(ui.text(), /Đã chọn:/);
  } finally {
    env.cleanup();
  }
});

test("'Bỏ chọn' clears the selection and hides the bulk bar", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    await ui.click(ui.checkboxes()[0]);
    assert.match(ui.text(), /Đã chọn: 2/);
    await ui.clickLabelled("Bỏ chọn");
    assert.doesNotMatch(ui.text(), /Đã chọn:/);
  } finally {
    env.cleanup();
  }
});

test("clicking the bulk approve button opens exactly ONE confirmation dialog naming the count — no request sent yet", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    await ui.click(ui.checkboxes()[0]); // select-all -> 2
    await ui.clickLabelled("Duyệt nghỉ việc đã chọn (2)");
    assert.match(ui.text(), /Bạn sắp duyệt nghỉ việc cho 2 người/);
    assert.equal(ui.requests.filter((r) => r.url.includes("bulk-approve-resignation")).length, 0, "no request until confirmed");
    // Exactly one confirm affordance, not N.
    assert.equal(ui.buttonsLabelled("Xác nhận duyệt 2 người").length, 1);
  } finally {
    env.cleanup();
  }
});

test("cancelling the confirmation dialog sends ZERO writes", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    await ui.click(ui.checkboxes()[0]);
    await ui.clickLabelled("Duyệt nghỉ việc đã chọn (2)");
    await ui.clickLabelled("Huỷ");
    assert.equal(ui.requests.filter((r) => r.method !== "GET").length, 0, "cancelling must never write anything");
  } finally {
    env.cleanup();
  }
});

test("confirming sends exactly ONE bulk POST with the selected ids — never one PATCH per row (the slow manual workflow being replaced)", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(
      env,
      defaultRespond({
        movements: { status: 200, jsonText: JSON.stringify({ rows: ROWS }) },
      }),
    );
    // Wire the bulk endpoint response AFTER initial load via a stateful respond wrapper.
    let bulkCalls = 0;
    (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      ui.requests.push({ method, url, body });
      if (url.endsWith("/api/workforce-movements") && method === "GET") return { ok: true, status: 200, json: async () => ({ rows: ROWS }) } as unknown as Response;
      if (url.includes("/api/departments")) return { ok: true, status: 200, json: async () => DEPTS } as unknown as Response;
      if (url.includes("entityType=resignation")) return { ok: true, status: 200, json: async () => STAGES_RESIGNATION } as unknown as Response;
      if (url.includes("entityType=transfer")) return { ok: true, status: 200, json: async () => STAGES_TRANSFER } as unknown as Response;
      if (url.endsWith("/bulk-approve-resignation") && method === "POST") {
        bulkCalls += 1;
        const ids = (body as { requestIds: string[] }).requestIds;
        return {
          ok: true,
          status: 200,
          json: async () => ({ bulkOperationId: "op1", requested: ids.length, approved: ids.length, alreadyApproved: 0, outOfScope: 0, noLongerEligible: 0, failed: 0, results: ids.map((id) => ({ id, outcome: "APPROVED" })) }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    };

    await ui.click(ui.checkboxes()[0]); // select all -> m1, m2
    await ui.clickLabelled("Duyệt nghỉ việc đã chọn (2)");
    await ui.clickLabelled("Xác nhận duyệt 2 người");

    const bulkPosts = ui.requests.filter((r) => r.url.endsWith("/bulk-approve-resignation") && r.method === "POST");
    assert.equal(bulkPosts.length, 1, "exactly one bulk request, not one per worker");
    assert.deepEqual(new Set((bulkPosts[0].body as { requestIds: string[] }).requestIds), new Set(["m1", "m2"]));
    const perRowPatches = ui.requests.filter((r) => r.method === "PATCH" && /\/api\/workforce-movements\/m[12]$/.test(r.url));
    assert.equal(perRowPatches.length, 0, "bulk approval must never fall back to per-row PATCH calls");
    assert.equal(bulkCalls, 1);

    // ONE consolidated result summary — never a per-worker toast.
    assert.match(ui.text(), /Duyệt nghỉ việc hoàn tất/);
    assert.match(ui.text(), /Thành công/);
  } finally {
    env.cleanup();
  }
});

test("partial-success result summary shows Thành công/Bỏ qua/Lỗi counts and a 'Xem chi tiết' toggle", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      ui.requests.push({ method, url, body });
      if (url.endsWith("/api/workforce-movements") && method === "GET") return { ok: true, status: 200, json: async () => ({ rows: ROWS }) } as unknown as Response;
      if (url.includes("/api/departments")) return { ok: true, status: 200, json: async () => DEPTS } as unknown as Response;
      if (url.includes("entityType=resignation")) return { ok: true, status: 200, json: async () => STAGES_RESIGNATION } as unknown as Response;
      if (url.includes("entityType=transfer")) return { ok: true, status: 200, json: async () => STAGES_TRANSFER } as unknown as Response;
      if (url.endsWith("/bulk-approve-resignation") && method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            bulkOperationId: "op1",
            requested: 2,
            approved: 1,
            alreadyApproved: 1,
            outOfScope: 0,
            noLongerEligible: 0,
            failed: 0,
            results: [{ id: "m1", outcome: "APPROVED" }, { id: "m2", outcome: "ALREADY_APPROVED" }],
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    };

    await ui.click(ui.checkboxes()[0]);
    await ui.clickLabelled("Duyệt nghỉ việc đã chọn (2)");
    await ui.clickLabelled("Xác nhận duyệt 2 người");

    assert.match(ui.text(), /Duyệt nghỉ việc hoàn tất/);
    await ui.clickLabelled("Xem chi tiết");
    assert.match(ui.text(), /Đã được duyệt trước đó/);
  } finally {
    env.cleanup();
  }
});

test("single-row regression: the existing 'Duyệt nghỉ việc' button still opens its own confirm modal and PATCHes that one row — unaffected by bulk mode", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      ui.requests.push({ method, url, body });
      if (url.endsWith("/api/workforce-movements") && method === "GET") return { ok: true, status: 200, json: async () => ({ rows: ROWS }) } as unknown as Response;
      if (url.includes("/api/departments")) return { ok: true, status: 200, json: async () => DEPTS } as unknown as Response;
      if (url.includes("entityType=resignation")) return { ok: true, status: 200, json: async () => STAGES_RESIGNATION } as unknown as Response;
      if (url.includes("entityType=transfer")) return { ok: true, status: 200, json: async () => STAGES_TRANSFER } as unknown as Response;
      if (url.endsWith("/api/workforce-movements/m1") && method === "PATCH") {
        return { ok: true, status: 200, json: async () => ({ success: true, movement: { ...ROWS[0], status: "INACTIVE" } }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    };

    await ui.clickLabelled("Duyệt nghỉ việc"); // row-level button (first match, unrelated to bulk bar which isn't shown yet)
    assert.match(ui.text(), /Xác nhận hành động/);
    await ui.clickLabelled("Xác nhận");

    const patchCall = ui.requests.find((r) => r.method === "PATCH" && r.url.endsWith("/api/workforce-movements/m1"));
    assert.ok(patchCall, "single-row approval must still PATCH the existing endpoint");
    assert.equal((patchCall!.body as { action: string }).action, "APPROVE_RESIGNATION");
    assert.equal(ui.requests.filter((r) => r.url.endsWith("/bulk-approve-resignation")).length, 0);
  } finally {
    env.cleanup();
  }
});
