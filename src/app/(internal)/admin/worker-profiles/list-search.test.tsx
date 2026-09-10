/**
 * "Hồ sơ Tập nghề" list page (page.tsx) — search-only regression test
 * (2026-09-10 Worker 360° Profile mission, Section 2). Real render in
 * jsdom.
 *
 * The list page never renders profile DETAIL inline anymore (that moved
 * to the canonical opaque-workerId route, see the sibling
 * detail-confirmation-history.test.tsx) — a CCCD/name search only ever
 * surfaces a "Xem hồ sơ →" link pointing at /admin/worker-profiles/[workerId],
 * never a link built from CCCD (Section 1: "Never put CCCD... into the URL").
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

async function renderPage(env: RenderEnv) {
  // next/link's mount-time prefetch effect calls requestIdleCallback(), which
  // references `self` (a real-browser global jsdom's installDom() does not
  // set up) — without it, mounting a rendered <Link> throws "self is not
  // defined" during the passive-effect phase, unrelated to anything this
  // test actually asserts.
  (globalThis as Record<string, unknown>).self = env.window;
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input);
    const json = async (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
    if (url.includes("/api/worker-profiles/010000000001")) {
      return json({ profile: { id: "w1", cccd: "010000000001", fullName: "Nguyen Van A", phone: "0900000001" } });
    }
    return json({});
  };

  const uiModule = loadComponent(new URL("../../../../components/ui.tsx", import.meta.url));
  const validatorsModule = loadComponent(new URL("../../../../lib/validators.ts", import.meta.url));
  const nextNavigationStub = { useSearchParams: () => new URLSearchParams() };

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./page.tsx", import.meta.url), {
    stubs: {
      "@/components/ui": uiModule,
      "@/lib/validators": validatorsModule,
      "next/navigation": nextNavigationStub,
    },
  });
  const Page = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Page));
  });

  return { container, act };
}

test("list page: CCCD search surfaces a link to the canonical opaque-workerId profile route, never a CCCD-bearing URL", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    const cccdInput = ui.container.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(env.window.HTMLInputElement.prototype, "value")!.set!;
    await ui.act(async () => {
      setter.call(cccdInput, "010000000001");
      cccdInput.dispatchEvent(new env.window.Event("input", { bubbles: true }));
    });
    const searchBtn = [...ui.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Tra cứu theo CCCD")) as HTMLButtonElement;
    await ui.act(async () => {
      searchBtn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const link = [...ui.container.querySelectorAll("a")].find((a) => (a.textContent ?? "").includes("Xem hồ sơ")) as HTMLAnchorElement;
    assert.ok(link, "a link to the profile detail route must render after a successful search");
    assert.equal(link.getAttribute("href"), "/admin/worker-profiles/w1");
    assert.ok(!link.getAttribute("href")!.includes("010000000001"), "the URL must never carry the CCCD");
  } finally {
    delete (globalThis as Record<string, unknown>).self;
    env.cleanup();
  }
});
