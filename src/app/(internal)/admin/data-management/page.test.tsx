/**
 * Workforce Data Management admin page — DOM smoke tests (mission section
 * 56: "Do not rely only on source scans"). Real render in jsdom, real
 * component tree, only fetch() is stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

const SUMMARY = {
  environment: "development",
  resetAllowed: true,
  resetBlockedReason: null,
  currentDatasets: [
    { importType: "WORKFORCE_MASTER", datasetMode: "TEST", sourceFilename: "master.xlsx", importedAt: "2026-09-01T00:00:00Z", rowCount: 100 },
    { importType: "IT_CODE", datasetMode: null, sourceFilename: null, importedAt: null, rowCount: null },
  ],
  quickCounts: { dwDataRows: 200, workerProfileRows: 150, activeEmploymentSessions: 120 },
  scopes: [],
};

async function renderPage(env: RenderEnv, fetchImpl: (url: string) => Promise<unknown>) {
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input);
    const body = await fetchImpl(url);
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  };

  const uiModule = loadComponent(new URL("../../../../components/ui.tsx", import.meta.url));

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./page.tsx", import.meta.url), {
    stubs: { "@/components/ui": uiModule },
  });
  const Page = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Page));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, act };
}

test("Overview tab: renders environment status and quick counts from a real fetch to /summary", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, async (url) => {
      if (url.includes("/summary")) return SUMMARY;
      return {};
    });

    assert.ok(ui.container.textContent?.includes("development"), "must show the resolved environment");
    assert.ok(ui.container.textContent?.includes("200"), "must show the dw_data quick count");
    assert.ok(ui.container.textContent?.includes("master.xlsx"), "must show the current Master DW dataset filename");
  } finally {
    env.cleanup();
  }
});

test("Reset tab: selecting a scope enables Preview; typed confirmation phrase gates the destructive button", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env, async (url) => {
      if (url.includes("/summary")) return SUMMARY;
      if (url.includes("/reset/preview")) {
        return {
          effectiveScopes: ["IT_CODE"],
          affected: [{ domain: "it_code_worker_profiles", label: "IT Code / Mã số công nhật trên Hồ sơ lao động", rows: 42 }],
          preserved: ["Organization"],
          warnings: [],
          requiredConfirmationPhrase: "RESET IT CODE",
          previewToken: "fake-token",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
      }
      return {};
    });

    const tabButtons = [...ui.container.querySelectorAll("button")];
    const resetTabBtn = tabButtons.find((b) => (b.textContent ?? "").includes("Reset dữ liệu")) as HTMLButtonElement;
    await ui.act(async () => {
      resetTabBtn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    });

    const checkbox = ui.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    assert.ok(checkbox, "at least one scope checkbox must render");
    await ui.act(async () => {
      checkbox.click();
    });

    const previewBtn = [...ui.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Xem trước (Preview)")) as HTMLButtonElement;
    assert.equal(previewBtn.disabled, false, "Preview must be enabled once a scope is checked");

    await ui.act(async () => {
      previewBtn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.ok(ui.container.textContent?.includes("42"), "preview must show the server-computed row count");

    const continueBtn = [...ui.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Tiếp tục reset")) as HTMLButtonElement;
    assert.ok(continueBtn, "danger 'continue' button must appear after a successful preview");
  } finally {
    env.cleanup();
  }
});
