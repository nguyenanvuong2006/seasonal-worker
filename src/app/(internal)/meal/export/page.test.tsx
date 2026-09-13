/**
 * Báo cơm page — GLOBAL DATE RANGE STANDARDIZATION DOM test. Real render in
 * jsdom (same render-tsx.ts harness as other page.test.tsx files). Proves
 * the screen shows "Từ ngày" / "Đến ngày" (a real date RANGE), never a
 * single "Ngày" label, and the shared DateRangeFilter renders with
 * mobile-first responsive classes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

const DEPTS = { rows: [{ id: "d1", deptName: "Đóng gói", groupName: null }] };
const ROWS = [
  { dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", phone: "0901", deptId: "d1", deptName: "Đóng gói", groupName: null, startingDate: null, code: "CN-001" },
];

async function renderPage(env: RenderEnv) {
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/departments")) return { ok: true, status: 200, json: async () => DEPTS } as unknown as Response;
    if (url.includes("/api/meal")) return { ok: true, status: 200, json: async () => ({ rows: ROWS }) } as unknown as Response;
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
    text: () => container.textContent ?? "",
    labelParagraphs: () => [...container.querySelectorAll("p")].map((p) => p.textContent?.trim()),
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
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

test("DateRangeFilter renders with mobile-first responsive classes (stacked by default, inline from sm: up)", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    const fromLabel = [...ui.container.querySelectorAll("p")].find((p) => p.textContent?.trim() === "Từ ngày");
    assert.ok(fromLabel, "'Từ ngày' label must be present");
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
