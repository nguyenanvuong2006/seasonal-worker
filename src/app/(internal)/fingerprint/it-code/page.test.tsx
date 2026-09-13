/**
 * IT Code / Vân tay page — GLOBAL DATE RANGE STANDARDIZATION DOM tests.
 * Real render in jsdom (same render-tsx.ts harness as other page.test.tsx
 * files). Proves:
 *   - the screen shows "Từ ngày" / "Đến ngày" (a real date RANGE), never a
 *     single "Ngày" label.
 *   - "Loại công nhật" (classification) and "Trạng thái IT Code"
 *     (itCodeStatus) are TWO INDEPENDENT dropdowns, never one combined
 *     dropdown — and selecting one does not reset/ignore the other.
 *   - the shared DateRangeFilter renders with mobile-first responsive
 *     classes (stacked on narrow screens, inline from `sm:` up).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

const DEPTS = { rows: [{ id: "d1", deptName: "Đóng gói", groupName: null }] };

const ROWS = [
  { dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", deptId: "d1", deptName: "Đóng gói", groupName: null, dwDataId: "dw-1", code: "CN-001", itCode: "IT-001", itCodeUpdatedAt: null, itCodeUpdatedBy: null, classification: "RETURNING" },
  { dailyApplicationId: "app-2", cccd: "010000000002", fullName: "Tran Thi B", deptId: "d1", deptName: "Đóng gói", groupName: null, dwDataId: "dw-2", code: "CN-002", itCode: null, itCodeUpdatedAt: null, itCodeUpdatedBy: null, classification: "NEW" },
  { dailyApplicationId: "app-3", cccd: "010000000003", fullName: "Le Van C", deptId: "d1", deptName: "Đóng gói", groupName: null, dwDataId: "dw-3", code: "CN-003", itCode: null, itCodeUpdatedAt: null, itCodeUpdatedBy: null, classification: "TRANSFERRED" },
];

async function renderPage(env: RenderEnv) {
  const requests: string[] = [];
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/api/departments")) return { ok: true, status: 200, json: async () => DEPTS } as unknown as Response;
    if (url.includes("/api/fingerprint/it-code")) return { ok: true, status: 200, json: async () => ({ rows: ROWS }) } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  };

  const uiModule = loadComponent(new URL("../../../../components/ui.tsx", import.meta.url));
  const dateRangeModule = loadComponent(new URL("../../../../lib/date-range.ts", import.meta.url));
  const dateRangeFilterModule = loadComponent(new URL("../../../../components/date-range-filter.tsx", import.meta.url), {
    stubs: { "@/components/ui": uiModule, "@/lib/date-range": dateRangeModule },
  });

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./page.tsx", import.meta.url), {
    stubs: {
      "@/components/ui": uiModule,
      "@/lib/date-range": dateRangeModule,
      "@/components/date-range-filter": dateRangeFilterModule,
    },
  });
  const Page = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Page));
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });

  return {
    container,
    requests,
    text: () => container.textContent ?? "",
    selects: () => [...container.querySelectorAll("select")] as HTMLSelectElement[],
    labelParagraphs: () => [...container.querySelectorAll("p")].map((p) => p.textContent?.trim()),
    async selectOption(select: HTMLSelectElement, value: string) {
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new env.window.Event("change", { bubbles: true }));
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
    },
    // Unmount BEFORE env.cleanup() so the search-debounce effect's cleanup
    // (clearTimeout) actually runs — otherwise its pending 350ms setTimeout
    // fires later against a torn-down jsdom window ("window is not defined").
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

function labelledSelect(ui: Awaited<ReturnType<typeof renderPage>>, label: string): HTMLSelectElement {
  const p = [...ui.container.querySelectorAll("p")].find((el) => el.textContent?.trim() === label);
  if (!p) throw new Error(`No label paragraph found for "${label}"`);
  const wrapper = p.parentElement!;
  const select = wrapper.querySelector("select");
  if (!select) throw new Error(`No <select> found under label "${label}"`);
  return select;
}

test("shows 'Từ ngày' and 'Đến ngày' — a real range, never a single 'Ngày' label", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    assert.match(ui.text(), /Từ ngày/);
    assert.match(ui.text(), /Đến ngày/);
    const exactNgay = ui.labelParagraphs().filter((t) => t === "Ngày");
    assert.equal(exactNgay.length, 0, "must not have a standalone single 'Ngày' label left over from the old single-date screen");
    await ui.unmount();
  } finally {
    env.cleanup();
  }
});

test("'Loại công nhật' (classification) and 'Trạng thái IT Code' (itCodeStatus) are TWO INDEPENDENT dropdowns", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    const classificationSelect = labelledSelect(ui, "Loại công nhật");
    const itCodeStatusSelect = labelledSelect(ui, "Trạng thái IT Code");
    assert.notEqual(classificationSelect, itCodeStatusSelect, "must be two distinct <select> elements, never one combined dropdown");

    const classificationOptions = [...classificationSelect.options].map((o) => o.value);
    assert.deepEqual(classificationOptions, ["ALL", "NEW", "RETURNING", "TRANSFERRED"]);
    const itCodeStatusOptions = [...itCodeStatusSelect.options].map((o) => o.value);
    assert.deepEqual(itCodeStatusOptions, ["ALL", "MISSING", "HAS"]);
    await ui.unmount();
  } finally {
    env.cleanup();
  }
});

test("selecting a classification does not reset/override the independently-selected itCodeStatus filter", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    const classificationSelect = labelledSelect(ui, "Loại công nhật");
    const itCodeStatusSelect = labelledSelect(ui, "Trạng thái IT Code");

    // Default itCodeStatus is "MISSING" (page default) — app-2/app-3 have no IT Code.
    assert.equal(itCodeStatusSelect.value, "MISSING");
    await ui.selectOption(classificationSelect, "RETURNING");
    assert.equal(itCodeStatusSelect.value, "MISSING", "changing classification must not reset itCodeStatus");
    // RETURNING+MISSING should show zero rows (app-1 is RETURNING but HAS an IT Code already).
    assert.match(ui.text(), /Không có lao động nào phù hợp bộ lọc/);

    await ui.selectOption(itCodeStatusSelect, "HAS");
    assert.equal(classificationSelect.value, "RETURNING", "changing itCodeStatus must not reset classification");
    // RETURNING+HAS should show exactly app-1.
    assert.match(ui.text(), /Nguyen Van A/);
    assert.doesNotMatch(ui.text(), /Tran Thi B/);
    await ui.unmount();
  } finally {
    env.cleanup();
  }
});

test("DateRangeFilter renders with mobile-first responsive classes (stacked by default, inline from sm: up)", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    const fromLabel = [...ui.container.querySelectorAll("p")].find((p) => p.textContent?.trim() === "Từ ngày");
    assert.ok(fromLabel, "'Từ ngày' label must be present");
    // Walk up to the DateRangeFilter's root wrapper (flex-col ... sm:flex-row).
    let node: HTMLElement | null = fromLabel!.parentElement;
    let found = false;
    for (let i = 0; i < 5 && node; i++) {
      if (node.className.includes("flex-col") && node.className.includes("sm:flex-row")) {
        found = true;
        break;
      }
      node = node.parentElement;
    }
    assert.ok(found, "DateRangeFilter root must stack vertically by default and switch to a row layout at the sm breakpoint");
    await ui.unmount();
  } finally {
    env.cleanup();
  }
});
