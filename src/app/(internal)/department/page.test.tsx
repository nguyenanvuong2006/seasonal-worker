/**
 * "Bộ phận của tôi" (department/page.tsx) — Worker Lifecycle Consistency audit (2026-09-10).
 * Real render in jsdom (render-tsx.ts harness). Proves:
 *   - default load fetches filter=ACTIVE from the NEW canonical endpoint — never a today-only
 *     date range against /api/registrations (the root cause of the reported Production bug).
 *   - switching filter chips re-fetches with the new filter value.
 *   - a worker with an upcoming resignation still shows under the default (ACTIVE) view with a
 *     "Sắp nghỉ" badge — never silently dropped before its effective date.
 *   - a history row (Đã nghỉ) renders but is NOT selectable for a new resignation/transfer.
 *   - bulk resignation submission still POSTs to /api/workforce-movements with the roster's
 *     own workerId (no CCCD lookup round-trip needed anymore).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../lib/test-support/render-tsx.ts";

type FetchCall = { url: string; method: string; body?: unknown };

const ACTIVE_ROWS = [
  { workerId: "w1", fullName: "Nguyen Van A", cccd: "010000000001", gender: "Nam", phone: "0900000001", deptId: "d1", deptName: "Đóng gói", groupName: null, section: null, startingDate: "2026-01-01", lifecycleState: "ACTIVE", upcoming: null, effectiveDate: null },
  { workerId: "w2", fullName: "Tran Thi B", cccd: "010000000002", gender: "Nữ", phone: "0900000002", deptId: "d1", deptName: "Đóng gói", groupName: null, section: null, startingDate: "2026-01-01", lifecycleState: "ACTIVE", upcoming: { type: "resignation", effectiveDate: "2026-09-20", toDeptName: null }, effectiveDate: null },
];

const RESIGNED_ROWS = [
  { workerId: "w9", fullName: "Pham Thi D", cccd: "010000000009", gender: "Nữ", phone: "0900000009", deptId: "d1", deptName: "Đóng gói", groupName: null, section: null, startingDate: null, lifecycleState: "RESIGNED", upcoming: null, effectiveDate: "2026-08-01" },
];

async function renderPage(env: RenderEnv, opts: { onResignationPost?: (body: unknown) => { status: number } } = {}) {
  const requests: FetchCall[] = [];
  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, body });
    const json = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data }) as unknown as Response;

    if (url.includes("/api/employment/current-workforce")) {
      // fetch() in the component uses a RELATIVE path — new URL() needs an explicit base or it
      // throws (caught silently by the component's own try/catch, masquerading as "Lỗi kết nối").
      const filter = new URL(url, "https://example.test").searchParams.get("filter") ?? "ACTIVE";
      if (filter === "RESIGNED") return json({ rows: RESIGNED_ROWS, filter });
      return json({ rows: ACTIVE_ROWS, filter });
    }
    if (url.includes("/api/departments")) return json({ rows: [{ id: "d1", deptName: "Đóng gói", groupName: null }] });
    if (url.endsWith("/api/workforce-movements") && method === "POST") {
      const result = opts.onResignationPost?.(body) ?? { status: 200 };
      return json({ success: true }, result.status);
    }
    return json({});
  };

  const uiModule = loadComponent(new URL("../../../components/ui.tsx", import.meta.url));
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./page.tsx", import.meta.url), { stubs: { "@/components/ui": uiModule } });
  const Page = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Page));
  });
  // Two independent effects (loadData, loadSummary) each chain Promise.all of 2 fetches + 2
  // .json() calls — more microtask hops than a single-fetch component, so more ticks are needed
  // to fully settle before asserting on the DOM.
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }

  return {
    container,
    requests,
    text: () => container.textContent ?? "",
    checkboxes: () => [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[],
    async clickLabelled(label: string) {
      const el = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
      if (!el) throw new Error(`No button found matching "${label}"`);
      await act(async () => {
        el.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
    },
  };
}

test("default load fetches filter=ACTIVE from the canonical endpoint — never /api/registrations, never a today-only date range", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    const rosterCall = ui.requests.find((r) => r.url.includes("/api/employment/current-workforce"));
    assert.ok(rosterCall, "must call the new canonical current-workforce endpoint");
    assert.match(rosterCall!.url, /filter=ACTIVE/);
    assert.ok(!ui.requests.some((r) => r.url.includes("/api/registrations")), "must never read from the registrations (daily_applications) table anymore");
  } finally {
    env.cleanup();
  }
});

test("a worker with an upcoming resignation is still shown (ACTIVE) with a 'Sắp nghỉ' badge, not silently dropped before the effective date", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    assert.match(ui.text(), /Tran Thi B/);
    assert.match(ui.text(), /Sắp nghỉ/);
  } finally {
    env.cleanup();
  }
});

test("switching to the 'Đã nghỉ' filter chip re-fetches with filter=RESIGNED and renders the history row without a selection checkbox", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    await ui.clickLabelled("Đã nghỉ");
    const resignedCall = ui.requests.filter((r) => r.url.includes("/api/employment/current-workforce")).find((r) => r.url.includes("filter=RESIGNED"));
    assert.ok(resignedCall, "clicking the 'Đã nghỉ' chip must re-fetch with filter=RESIGNED");
    assert.match(ui.text(), /Pham Thi D/);
    // Header select-all + 0 selectable row checkboxes: a RESIGNED (history) row is never selectable.
    assert.equal(ui.checkboxes().length, 0, "history rows must not expose a selection checkbox");
  } finally {
    env.cleanup();
  }
});

test("bulk resignation submit posts the roster's own workerId directly to /api/workforce-movements — no CCCD lookup round-trip", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, { onResignationPost: () => ({ status: 200 }) });
    // Select the first ACTIVE row's checkbox (header is index 0's select-all is a text button,
    // not a checkbox, in this table — row checkboxes start at index 0 here since there's no
    // separate header checkbox element unless rows exist; select w1's row checkbox).
    const rowCheckbox = ui.checkboxes()[0];
    const { act } = await import("react");
    await act(async () => {
      rowCheckbox.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await ui.clickLabelled("Báo nghỉ việc");
    await ui.clickLabelled("Xác nhận gửi yêu cầu báo nghỉ");

    const movementPost = ui.requests.find((r) => r.url.endsWith("/api/workforce-movements") && r.method === "POST");
    assert.ok(movementPost, "must submit a resignation request");
    const postBody = movementPost!.body as { workerId: string; movementType: string };
    assert.equal(postBody.movementType, "resignation");
    assert.ok(["w1", "w2"].includes(postBody.workerId), "workerId must come straight from the roster row, no /api/worker-profiles lookup needed");
    assert.ok(!ui.requests.some((r) => r.url.includes("/api/worker-profiles/")), "must never fall back to a CCCD lookup when workerId is already known");
  } finally {
    env.cleanup();
  }
});
