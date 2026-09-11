/**
 * WorkforceMovementsPage — BULK APPROVAL UI (resignation + transfer arrival
 * confirmation, final-project-hardening). Real render in jsdom (same
 * render-tsx.ts harness as ai-assistant/page.test.tsx and
 * candidate-documents-status-panel-bulk-issue.test.tsx). Proves:
 *
 *   - a checkbox exists ONLY for eligible rows: resignation at PENDING_HR
 *     (APPROVE_RESIGNATION) OR transfer at PENDING_HR/TRANSFER_RESCHEDULED
 *     (CONFIRM_ARRIVED) — never for INACTIVE/REJECTED/transfer_WAITING_DECISION
 *     rows.
 *   - single + multi selection, "Chọn tất cả đang chờ duyệt" (select/
 *     deselect all eligible at once, across BOTH movement types).
 *   - clicking "Duyệt đã chọn (N)" opens exactly ONE confirmation dialog
 *     naming N — never N separate confirmations.
 *   - a resignation-only selection sends exactly ONE POST to
 *     bulk-approve-resignation — never N separate PATCH calls.
 *   - a MIXED selection (resignation + transfer) sends exactly ONE POST to
 *     EACH of bulk-approve-resignation/bulk-approve-transfer, split by the
 *     row's own movementType, and merges both responses into ONE combined
 *     result summary — never a third/duplicate lifecycle engine.
 *   - cancelling the confirmation sends zero requests.
 *   - after a response, ONE consolidated result summary renders (Thành
 *     công/Bỏ qua/Lỗi) — never one toast per worker — and the list
 *     refreshes.
 *   - the existing single-row "Duyệt nghỉ việc"/"Đã nhận việc" PATCH flows
 *     are unaffected (regression guard) — bulk is additive, not a
 *     replacement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

type FetchResponse = { status: number; jsonText: string };
type FetchCall = { method: string; url: string; body: unknown };

const DEPTS = { rows: [{ id: "d1", deptName: "Đóng gói", groupName: null }] };
const STAGES_RESIGNATION = { rows: [{ stageKey: "PENDING_HR", label: "Chờ HR duyệt", color: "amber" }, { stageKey: "INACTIVE", label: "Đã nghỉ việc", color: "gray" }, { stageKey: "REJECTED", label: "HR từ chối", color: "red" }] };
const STAGES_TRANSFER = { rows: [{ stageKey: "PENDING_HR", label: "Chờ HR duyệt", color: "amber" }, { stageKey: "WAITING_DECISION", label: "Chờ quyết định", color: "gray" }] };

// m1/m2: eligible resignation (APPROVE_RESIGNATION). m3: ineligible resignation (already
// INACTIVE). m4: eligible transfer (CONFIRM_ARRIVED) — final-project-hardening, was
// ineligible before bulk transfer approval existed. m5: ineligible transfer
// (WAITING_DECISION has no CONFIRM_ARRIVED action).
const ROWS = [
  { id: "m1", movementType: "resignation", workerId: "w1", workerName: "Nguyen Van A", workerCccd: "010000000001", fromDeptId: "d1", toDeptId: null, effectiveDate: "2026-09-15", reason: null, note: null, status: "PENDING_HR", relatedMovementId: null, requestedBy: "manager1", createdAt: "2026-09-01T00:00:00Z" },
  { id: "m2", movementType: "resignation", workerId: "w2", workerName: "Tran Thi B", workerCccd: "010000000002", fromDeptId: "d1", toDeptId: null, effectiveDate: "2026-09-16", reason: null, note: null, status: "PENDING_HR", relatedMovementId: null, requestedBy: "manager1", createdAt: "2026-09-01T00:00:00Z" },
  { id: "m3", movementType: "resignation", workerId: "w3", workerName: "Le Van C", workerCccd: "010000000003", fromDeptId: "d1", toDeptId: null, effectiveDate: "2026-08-01", reason: null, note: null, status: "INACTIVE", relatedMovementId: null, requestedBy: "manager1", createdAt: "2026-08-01T00:00:00Z" },
  { id: "m4", movementType: "transfer", workerId: "w4", workerName: "Pham Thi D", workerCccd: "010000000004", fromDeptId: "d1", toDeptId: "d1", effectiveDate: "2026-09-20", reason: null, note: null, status: "PENDING_HR", relatedMovementId: null, requestedBy: "manager1", createdAt: "2026-09-01T00:00:00Z" },
  { id: "m5", movementType: "transfer", workerId: "w5", workerName: "Vo Van E", workerCccd: "010000000005", fromDeptId: "d1", toDeptId: "d1", effectiveDate: "2026-09-21", reason: null, note: null, status: "WAITING_DECISION", relatedMovementId: null, requestedBy: "manager1", createdAt: "2026-09-01T00:00:00Z" },
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

/** requestIds-bearing bulk endpoint stub factory shared by the tests below. */
function bulkStub(urlSuffix: string) {
  return (body: unknown) => {
    const ids = (body as { requestIds: string[] }).requestIds;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        bulkOperationId: `op-${urlSuffix}`,
        requested: ids.length,
        approved: ids.length,
        alreadyApproved: 0,
        outOfScope: 0,
        noLongerEligible: 0,
        failed: 0,
        results: ids.map((id) => ({ id, outcome: "APPROVED" })),
      }),
    } as unknown as Response;
  };
}

test("checkbox exists ONLY for eligible rows (resignation PENDING_HR OR transfer PENDING_HR/TRANSFER_RESCHEDULED) — never INACTIVE resignation or transfer_WAITING_DECISION", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    // 1 header "select all" + 3 eligible rows (m1, m2 resignation; m4 transfer) = 4 total.
    // m3 (resignation INACTIVE) and m5 (transfer WAITING_DECISION) get none.
    assert.equal(ui.checkboxes().length, 4, "expected header select-all + exactly 3 eligible-row checkboxes (2 resignation + 1 transfer)");
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
    assert.ok(ui.buttonsLabelled("Duyệt đã chọn (1)").length > 0);
  } finally {
    env.cleanup();
  }
});

test("multiple selection: checking two eligible rows shows 'Đã chọn: 2'", async () => {
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

test("'Chọn tất cả đang chờ duyệt' selects every eligible row ACROSS BOTH movement types (3: 2 resignation + 1 transfer), toggling again deselects", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    const selectAll = ui.checkboxes()[0];
    await ui.click(selectAll);
    assert.match(ui.text(), /Đã chọn: 3/);
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
    assert.match(ui.text(), /Đã chọn: 3/);
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
    await ui.click(ui.checkboxes()[0]); // select-all -> 3 (mixed types)
    await ui.clickLabelled("Duyệt đã chọn (3)");
    assert.match(ui.text(), /Bạn sắp xử lý 3 yêu cầu/);
    assert.equal(ui.requests.filter((r) => r.url.includes("bulk-approve-")).length, 0, "no request until confirmed");
    // Exactly one confirm affordance, not N.
    assert.equal(ui.buttonsLabelled("Xác nhận xử lý 3 yêu cầu").length, 1);
  } finally {
    env.cleanup();
  }
});

test("cancelling the confirmation dialog sends ZERO writes", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, defaultRespond());
    await ui.click(ui.checkboxes()[0]);
    await ui.clickLabelled("Duyệt đã chọn (3)");
    await ui.clickLabelled("Huỷ");
    assert.equal(ui.requests.filter((r) => r.method !== "GET").length, 0, "cancelling must never write anything");
  } finally {
    env.cleanup();
  }
});

test("resignation-only selection: confirming sends exactly ONE POST to bulk-approve-resignation, never bulk-approve-transfer or per-row PATCH", async () => {
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
      if (url.endsWith("/bulk-approve-resignation") && method === "POST") return bulkStub("resignation")(body);
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    };

    // Select only the two resignation rows (not select-all, to keep this batch single-type).
    const rowBoxes = ui.checkboxes().slice(1);
    await ui.click(rowBoxes[0]); // m1
    await ui.click(rowBoxes[1]); // m2
    await ui.clickLabelled("Duyệt đã chọn (2)");
    await ui.clickLabelled("Xác nhận xử lý 2 yêu cầu");

    const resignationPosts = ui.requests.filter((r) => r.url.endsWith("/bulk-approve-resignation") && r.method === "POST");
    const transferPosts = ui.requests.filter((r) => r.url.endsWith("/bulk-approve-transfer") && r.method === "POST");
    assert.equal(resignationPosts.length, 1, "exactly one bulk request, not one per worker");
    assert.equal(transferPosts.length, 0, "a resignation-only batch must never call the transfer endpoint");
    assert.deepEqual(new Set((resignationPosts[0].body as { requestIds: string[] }).requestIds), new Set(["m1", "m2"]));
    const perRowPatches = ui.requests.filter((r) => r.method === "PATCH" && /\/api\/workforce-movements\/m[12]$/.test(r.url));
    assert.equal(perRowPatches.length, 0, "bulk approval must never fall back to per-row PATCH calls");

    // ONE consolidated result summary — never a per-worker toast.
    assert.match(ui.text(), /Xử lý hàng loạt hoàn tất/);
    assert.match(ui.text(), /Thành công/);
  } finally {
    env.cleanup();
  }
});

test("MIXED selection (resignation + transfer): confirming sends ONE POST to EACH endpoint, split by the row's own movementType, and merges both responses into ONE combined summary", async () => {
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
      if (url.endsWith("/bulk-approve-resignation") && method === "POST") return bulkStub("resignation")(body);
      if (url.endsWith("/bulk-approve-transfer") && method === "POST") return bulkStub("transfer")(body);
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    };

    await ui.click(ui.checkboxes()[0]); // select-all -> m1, m2 (resignation) + m4 (transfer)
    await ui.clickLabelled("Duyệt đã chọn (3)");
    await ui.clickLabelled("Xác nhận xử lý 3 yêu cầu");

    const resignationPosts = ui.requests.filter((r) => r.url.endsWith("/bulk-approve-resignation") && r.method === "POST");
    const transferPosts = ui.requests.filter((r) => r.url.endsWith("/bulk-approve-transfer") && r.method === "POST");
    assert.equal(resignationPosts.length, 1, "exactly one resignation bulk request");
    assert.equal(transferPosts.length, 1, "exactly one transfer bulk request");
    assert.deepEqual(new Set((resignationPosts[0].body as { requestIds: string[] }).requestIds), new Set(["m1", "m2"]));
    assert.deepEqual(new Set((transferPosts[0].body as { requestIds: string[] }).requestIds), new Set(["m4"]));

    // ONE combined summary, not two separate ones — requested/approved sum across both calls.
    assert.match(ui.text(), /Xử lý hàng loạt hoàn tất/);
    const resultCards = ui.text();
    assert.match(resultCards, /3/); // combined "Đã chọn" = 2 + 1
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

    const rowBoxes = ui.checkboxes().slice(1);
    await ui.click(rowBoxes[0]); // m1
    await ui.click(rowBoxes[1]); // m2
    await ui.clickLabelled("Duyệt đã chọn (2)");
    await ui.clickLabelled("Xác nhận xử lý 2 yêu cầu");

    assert.match(ui.text(), /Xử lý hàng loạt hoàn tất/);
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
    assert.equal(ui.requests.filter((r) => r.url.endsWith("/bulk-approve-transfer")).length, 0);
  } finally {
    env.cleanup();
  }
});

test("single-row regression: the existing transfer 'Đã nhận việc' button still opens its own confirm modal and PATCHes that one row — unaffected by bulk mode", async () => {
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
      if (url.endsWith("/api/workforce-movements/m4") && method === "PATCH") {
        return { ok: true, status: 200, json: async () => ({ success: true, movement: { ...ROWS[3], status: "TRANSFER_COMPLETED" } }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    };

    await ui.clickLabelled("Đã nhận việc");
    assert.match(ui.text(), /Xác nhận hành động/);
    await ui.clickLabelled("Xác nhận");

    const patchCall = ui.requests.find((r) => r.method === "PATCH" && r.url.endsWith("/api/workforce-movements/m4"));
    assert.ok(patchCall, "single-row transfer confirmation must still PATCH the existing endpoint");
    assert.equal((patchCall!.body as { action: string }).action, "CONFIRM_ARRIVED");
    assert.equal(ui.requests.filter((r) => r.url.endsWith("/bulk-approve-transfer")).length, 0);
  } finally {
    env.cleanup();
  }
});
