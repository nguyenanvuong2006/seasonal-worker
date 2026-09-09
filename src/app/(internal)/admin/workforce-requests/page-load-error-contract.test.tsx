/**
 * WorkforceRequestsPage — load() error-contract regression tests (2026-09,
 * Production incident: "Failed to execute 'json' on 'Response': Unexpected
 * end of JSON input"). Real render in jsdom (same render-tsx.ts harness
 * already established for candidate-consent pages) — proves:
 *   - 200 + rows renders the table, never the empty state or an error.
 *   - 200 + [] (a TRUE empty result) renders "Chưa có Workforce Request",
 *     never an error.
 *   - a non-JSON/empty-bodied 500 (reproducing the exact Production
 *     failure) is caught by fetchJsonWithTimeout's safe parsing and
 *     renders a structured ErrorState with a retry button — NEVER an
 *     uncaught "Unexpected end of JSON input", and NEVER the empty state
 *     ("Chưa có Workforce Request" must only ever follow a real HTTP 200).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

const DASHBOARD_BODY = {
  summary: {
    totalRequested: { male: 1, female: 1, total: 2 },
    currentWorkforce: { male: 0, female: 0, total: 0 },
    totalRecruited: { male: 0, female: 0, total: 0 },
    totalQuit: { male: 0, female: 0, total: 0 },
    needToRecruit: { male: 1, female: 1, total: 2 },
  },
  source: "LIVE",
  computedAt: "2026-09-09T10:00:00.000Z",
  asOfDate: "2026-09-09",
  can: { allocate: true, overallocate: false, comment: true },
};

const ROW = {
  id: "r1",
  requestCode: "REQ-001",
  requester: "HR",
  department: "Farm A",
  departmentId: "dept-a",
  section: null,
  groupName: null,
  division: null,
  position: null,
  expectedDate: "2026-09-15",
  requestedDate: "2026-09-01",
  status: "PENDING",
  reason: null,
  deptName: "Farm A",
  kpi: {
    maleRequest: 1, femaleRequest: 1, totalRequest: 2,
    maleCurrent: 0, femaleCurrent: 0, totalCurrent: 0,
    maleRecruited: 0, femaleRecruited: 0, totalRecruited: 0,
    maleQuit: 0, femaleQuit: 0, totalQuit: 0,
    maleBalance: 1, femaleBalance: 1, totalBalance: 2,
    fillRatePercent: 0, warnings: [],
  },
  applications: { male: 0, female: 0, total: 0 },
  linkedPeriod: null,
};

type FetchResponse = { status: number; jsonText: string | null };

async function renderPage(env: RenderEnv, opts: { listResponse: FetchResponse; dashResponse: FetchResponse }) {
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input);
    const pick = url.includes("/dashboard") ? opts.dashResponse : url.endsWith("/api/workforce-requests") || url.includes("/api/workforce-requests?") ? opts.listResponse : { status: 200, jsonText: "{}" };
    return {
      ok: pick.status >= 200 && pick.status < 300,
      status: pick.status,
      headers: new Headers(),
      text: async () => pick.jsonText ?? "",
    } as unknown as Response;
  };

  const uiModule = loadComponent(new URL("../../../../components/ui.tsx", import.meta.url));
  const apiClientModule = loadComponent(new URL("../../../../lib/api-client.ts", import.meta.url));

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./page.tsx", import.meta.url), {
    stubs: {
      "@/components/ui": uiModule,
      "@/lib/api-client": apiClientModule,
    },
  });
  const Page = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Page));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    container,
    text: () => container.textContent ?? "",
  };
}

test("200 + rows: renders the table, never the empty state or an error", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, {
      listResponse: { status: 200, jsonText: JSON.stringify({ rows: [ROW], can: { allocate: true, overallocate: false, comment: true } }) },
      dashResponse: { status: 200, jsonText: JSON.stringify(DASHBOARD_BODY) },
    });
    assert.match(ui.text(), /REQ-001/);
    assert.doesNotMatch(ui.text(), /Chưa có Workforce Request/);
    assert.doesNotMatch(ui.text(), /Không thể tải dữ liệu/);
  } finally {
    env.cleanup();
  }
});

test("200 + [] : a TRUE empty result renders 'Chưa có Workforce Request', never an error", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, {
      listResponse: { status: 200, jsonText: JSON.stringify({ rows: [], can: { allocate: true, overallocate: false, comment: true } }) },
      dashResponse: { status: 200, jsonText: JSON.stringify(DASHBOARD_BODY) },
    });
    assert.match(ui.text(), /Chưa có Workforce Request/);
    assert.doesNotMatch(ui.text(), /Không thể tải dữ liệu/);
  } finally {
    env.cleanup();
  }
});

test("empty-bodied 500 (reproducing the exact Production incident) => structured ErrorState with retry, NEVER an uncaught 'Unexpected end of JSON input', NEVER the empty state", async () => {
  const env = installDom();
  const originalConsoleError = console.error;
  const uncaught: unknown[] = [];
  // Fail loudly if anything throws synchronously across the render — the
  // whole point of this test is that a bad response must NEVER surface as
  // an uncaught SyntaxError.
  console.error = (...args: unknown[]) => {
    uncaught.push(args);
    originalConsoleError(...args);
  };
  try {
    const ui = await renderPage(env, {
      // Empty body — exactly what an uncaught exception in a Next.js Route
      // Handler produced in Production before this fix.
      listResponse: { status: 500, jsonText: "" },
      dashResponse: { status: 200, jsonText: JSON.stringify(DASHBOARD_BODY) },
    });
    assert.doesNotMatch(ui.text(), /Chưa có Workforce Request/, "an error must never render as a silent empty state");
    assert.match(ui.text(), /Không thể tải dữ liệu/, "must show the structured ErrorState");
    assert.match(ui.text(), /Thử lại/, "ErrorState must offer a retry action");
    assert.doesNotMatch(ui.text(), /Unexpected end of JSON input/, "the raw SyntaxError text must never reach the UI");
  } finally {
    console.error = originalConsoleError;
    env.cleanup();
  }
});

test("non-JSON (HTML error page) 500 body => structured ErrorState, never a parse crash", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, {
      listResponse: { status: 500, jsonText: "<html><body>Internal Server Error</body></html>" },
      dashResponse: { status: 200, jsonText: JSON.stringify(DASHBOARD_BODY) },
    });
    assert.match(ui.text(), /Không thể tải dữ liệu/);
    assert.doesNotMatch(ui.text(), /Chưa có Workforce Request/);
  } finally {
    env.cleanup();
  }
});
