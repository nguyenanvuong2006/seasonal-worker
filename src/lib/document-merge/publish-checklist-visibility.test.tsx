/**
 * PUBLISH CHECKLIST — REPRO BUG PRODUCTION v16 "bấm 'Xuất bản phiên bản'
 * không thấy checklist, không có POST /publish".
 *
 * BẰNG CHỨNG PRODUCTION (được coi là FACT, không debug thêm):
 *   • Click 1: GET /versions → 200, POST /ai-analyze → 200, KHÔNG có POST
 *     /publish, và Publish Checklist KHÔNG HIỆN RA.
 *   • Click 2 (không reload, đã clear Network/Console): Network HOÀN TOÀN
 *     TRỐNG — không versions, không ai-analyze, không publish.
 *   • Nút THẬT, `disabled === false`, `aria-disabled === null`,
 *     `getComputedStyle().pointerEvents === "auto"`.
 *   • Console không có TypeError / ReferenceError / lỗi JSON / lỗi render.
 *
 * CHUỖI SUY LUẬN KHÓA CHẶT NGUYÊN NHÂN (không cần DevTools thêm):
 *   1. Click 1 CÓ tạo GET /versions + POST /ai-analyze → đây chính xác là 2
 *      request trong `useEffect` của PublishChecklistModal ⇒ modal ĐÃ MOUNT
 *      và ĐÃ fetch thành công. Vậy nút, handler, state, effect đều CHẠY.
 *   2. Click 2 KHÔNG tạo request nào ⇒ modal VẪN CÒN MOUNT: nếu nó đã bị
 *      unmount thì `publishChecklistTarget` phải là null, click 2 sẽ mount
 *      lại và effect chạy lại (deps đổi từ "chưa có" → có) ⇒ phải có request.
 *      Không có request ⇒ effect deps `[templateId, target.id,
 *      currentPublishedVersionId, action]` KHÔNG ĐỔI ⇒ modal chưa từng đóng.
 *   3. (1) + (2) ⇒ modal có trong DOM, đã fetch xong, nhưng KHÔNG NHÌN THẤY.
 *      Không phải disabled, không phải pointer-events, không phải exception.
 *   4. Vậy lỗi nằm ở bước CUỐI của chuỗi: "checklist render" → "paint nhìn
 *      thấy được" ⇒ một lỗi THUẦN CSS về thứ tự vẽ (z-index/stacking).
 *
 * ROOT CAUSE (file này chứng minh bằng CSS THẬT của repo):
 *   `src/app/(internal)/admin/document-merge/document-merge-parity.css` có
 *       .document-merge-parity .fixed.inset-0.z-50 { z-index: 9999 !important; }
 *   rule này nâng modal "Sửa Template" (template-library.tsx, `z-50`) lên
 *   9999, TRONG KHI PublishChecklistModal chỉ là `z-[100]` = 100. Checklist
 *   vì vậy bị vẽ DƯỚI modal "Sửa Template" — mà modal đó phủ kín viewport
 *   bằng panel `bg-white` ⇒ operator thấy "bấm không có gì xảy ra".
 *   (Cùng lỗi này chôn luôn ApplyToDraftConfirmModal `z-[60]` = 60.)
 *
 * VÌ SAO MỌI TEST CŨ ĐỀU PASS: chúng chỉ so CHUỖI class ("z-[100] > z-50"),
 * không hề nạp `document-merge-parity.css`. File này nạp CSS Tailwind THẬT
 * (biên dịch bằng chính pipeline của repo) + parity CSS THẬT, render
 * component THẬT, rồi đọc `getComputedStyle().zIndex` — đúng thứ trình duyệt
 * của operator dùng để quyết định vẽ gì trên cùng.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDom, loadComponent, type RenderEnv } from "../test-support/render-tsx.ts";
import { documentMergeStylesheets, zIndexUtilitiesFor } from "../test-support/parity-css.ts";

/** Template production: "Đăng ký tập nghề - Quy định tập nghề". */
const TEMPLATE = {
  id: "tpl-dang-ky-tap-nghe",
  name: "Đăng ký tập nghề - Quy định tập nghề",
  description: null,
  googleDocId: "gdoc-tap-nghe",
  outputFolderId: null,
  outputFileNamePattern: null,
  defaultMergeMode: "INDIVIDUAL_DOCUMENTS",
  documentKind: "B",
  dataSources: [],
  isActive: true,
  currentPublishedVersion: 11,
  retentionYears: 3,
};

const V16_DRAFT_ID = "v16-draft-id";
const V11_PUBLISHED_ID = "v11-published-id";

/**
 * Đúng hiện trạng production: v16 = DRAFT, v11 = PUBLISHED, tổng 16 version.
 * Danh sách DÀI là một phần của kịch bản (operator phải cuộn xuống v16).
 */
const PRODUCTION_VERSIONS = Array.from({ length: 16 }, (_, i) => {
  const version = i + 1;
  const id = version === 16 ? V16_DRAFT_ID : version === 11 ? V11_PUBLISHED_ID : `v${version}-id`;
  const status = version === 16 ? "DRAFT" : version === 11 ? "PUBLISHED" : "ARCHIVED";
  return {
    id,
    templateId: TEMPLATE.id,
    version,
    status,
    htmlBody: `<h1>Quy định tập nghề v${version}</h1>`,
    printCss: "@page { size: A4; margin: 20mm; }",
    sourceDocxName: null,
    retentionYears: 3,
    mappingSnapshot: [],
    createdBy: "admin",
    publishedAt: null,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
});

/**
 * ai-analyze THẬT của production (đúng các field được capture):
 * READ_ONLY_ANALYZE, mutated=false, 49/49 placeholder OK, KHÔNG blocker,
 * chỉ có cảnh báo layout NOWRAP_DYNAMIC_CONTENT (WARNING, không chặn publish).
 */
const PRODUCTION_ANALYZE = {
  mode: "READ_ONLY_ANALYZE",
  mutated: false,
  baseVersion: 11,
  baseVersionStatus: "PUBLISHED",
  htmlValid: true,
  htmlIssues: [],
  cssValid: true,
  cssIssues: [],
  placeholders: { total: 49, unchanged: 49, added: 0, removed: 0 },
  mappingsAffected: 0,
  security: { errors: [], warnings: [] },
  layoutWarnings: [
    { code: "NOWRAP_DYNAMIC_CONTENT", message: "Ô nowrap chứa placeholder động — dữ liệu dài có thể tràn." },
    { code: "NOWRAP_DYNAMIC_CONTENT", message: "Ô nowrap chứa placeholder động — dữ liệu dài có thể tràn." },
  ],
  needsAttention: [],
  diff: {
    summary: { total: 49, unchanged: 49, added: 0, removed: 0, mappingChanged: 0, requiredChanged: 0, orphaned: 0, unmapped: 0 },
  },
  placeholderCoverage: { ok: true, issues: [], totalPlaceholders: 49, mappedFields: 49 },
};

type FetchCall = { url: string; method: string };

/**
 * Render TemplateLibrary THẬT, bọc trong `.document-merge-parity` đúng như
 * `src/app/(internal)/admin/document-merge/layout.tsx` bọc nó ở production,
 * và NẠP CSS THẬT để `getComputedStyle` trả về z-index như trình duyệt.
 */
async function renderProductionPage(env: RenderEnv) {
  const calls: FetchCall[] = [];
  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const json = async (body: unknown, status = 200) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
    if (url.endsWith("/api/document-merge/templates")) return json([TEMPLATE]);
    if (/\/versions$/.test(url)) return json(PRODUCTION_VERSIONS);
    if (/\/fields$/.test(url)) return json([]);
    if (/\/ai-analyze$/.test(url)) return json(PRODUCTION_ANALYZE);
    return json({});
  };

  // --- Tầng CSS thật: Tailwind (pipeline của repo) + parity CSS của layout. ---
  const stylesheets = await documentMergeStylesheets();
  for (const css of stylesheets) {
    const style = env.document.createElement("style");
    style.textContent = css;
    env.document.head.appendChild(style);
  }

  // --- Bọc #root trong `.document-merge-parity` như layout thật. ---
  const root = env.document.getElementById("root") as HTMLElement;
  const parityWrapper = env.document.createElement("div");
  parityWrapper.className = "document-merge-parity";
  env.document.body.appendChild(parityWrapper);
  parityWrapper.appendChild(root);

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const mod = loadComponent(new URL("../../components/document-merge/template-library.tsx", import.meta.url));
  const TemplateLibrary = mod.TemplateLibrary as (props: unknown) => unknown;

  const reactRoot = createRoot(root);
  await act(async () => {
    reactRoot.render(React.createElement(TemplateLibrary as never, { onSelectForMerge: () => {} } as never));
  });

  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  };

  // Mở modal "Sửa Template" — card version nằm BÊN TRONG modal này.
  const editBtn = [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Sửa"));
  assert.ok(editBtn, "không tìm thấy nút mở 'Sửa Template'");
  await click(editBtn!);

  const overlays = () =>
    [...root.querySelectorAll("div")].filter((d) => (d.className ?? "").includes("fixed inset-0"));
  const overlayWith = (zClass: string) =>
    overlays().find((d) => (d.className ?? "").split(/\s+/).includes(zClass)) ?? null;

  return {
    calls,
    root,
    act,
    click,
    overlays,
    overlayWith,
    /** z-index HIỆU DỤNG (đã qua cascade + `!important`), như trình duyệt tính. */
    zIndexOf: (el: Element | null) => (el ? env.window.getComputedStyle(el).zIndex : null),
    buttonsLabelled: (label: string) =>
      [...root.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === label),
    checklistHeading: () =>
      [...root.querySelectorAll("h3")].find((h) => (h.textContent ?? "").includes("Xác nhận xuất bản")) ?? null,
    text: () => root.textContent ?? "",
  };
}

/** Thứ tự vẽ: cùng stacking context, z-index lớn hơn thì vẽ TRÊN. */
function paintsAbove(zA: string | null, zB: string | null): boolean {
  const a = Number.parseInt(zA ?? "auto", 10);
  const b = Number.parseInt(zB ?? "auto", 10);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

test("PRODUCTION REPRO — click 'Xuất bản phiên bản' v16 DRAFT: checklist PHẢI vẽ TRÊN modal 'Sửa Template'", async () => {
  const env = installDom();
  try {
    const ui = await renderProductionPage(env);

    // --- Transition 1: BUTTON CLICK → React onClick → state. ---
    const publishBtn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    assert.ok(publishBtn, "v16 DRAFT phải có nút 'Xuất bản phiên bản'");
    assert.equal(publishBtn.disabled, false, "production: button.disabled === false");
    assert.equal(publishBtn.getAttribute("aria-disabled"), null, "production: aria-disabled === null");
    assert.equal(env.window.getComputedStyle(publishBtn).pointerEvents, "auto", "production: pointer-events auto");

    const before = ui.calls.length;
    await ui.click(publishBtn);

    // --- Transition 2..8: modal mount → GET versions → POST ai-analyze. ---
    const newCalls = ui.calls.slice(before);
    assert.deepEqual(
      newCalls.map((c) => `${c.method} ${c.url.replace(/^https?:\/\/[^/]+/, "")}`),
      ["GET /api/document-merge/templates/tpl-dang-ky-tap-nghe/versions", "POST /api/document-merge/templates/tpl-dang-ky-tap-nghe/ai-analyze"],
      "đúng cặp request production quan sát được ở click 1 — chứng tỏ modal ĐÃ mount",
    );
    assert.ok(ui.checklistHeading(), "PublishChecklistModal phải có trong DOM");
    assert.match(ui.text(), /49/, "machine check 49 placeholder phải render");
    assert.equal(
      newCalls.some((c) => /\/publish$/.test(c.url)),
      false,
      "chưa confirm thì không được có POST /publish",
    );

    // --- Transition 9: CHECKLIST RENDER → PAINT NHÌN THẤY ĐƯỢC. ---
    // Đây là FIRST_BROKEN_TRANSITION của bug production.
    await zIndexUtilitiesFor(["z-50", "z-[100]"]);
    const editorOverlay = ui.overlayWith("z-50");
    const checklistOverlay = ui.overlayWith("z-[100]");
    assert.ok(editorOverlay, "modal 'Sửa Template' (z-50) phải đang mở");
    assert.ok(checklistOverlay, "PublishChecklistModal (z-[100]) phải đang mở");
    assert.equal(editorOverlay!.contains(checklistOverlay!), false, "checklist không nằm trong overlay editor");

    const editorZ = ui.zIndexOf(editorOverlay);
    const checklistZ = ui.zIndexOf(checklistOverlay);
    assert.ok(
      paintsAbove(checklistZ, editorZ),
      `BUG PRODUCTION: PublishChecklistModal bị vẽ DƯỚI modal "Sửa Template" — ` +
        `z-index hiệu dụng checklist=${checklistZ} nhưng editor=${editorZ}. ` +
        `Modal có mount + fetch 200 nhưng bị panel bg-white của editor che kín, ` +
        `nên operator thấy "bấm không có gì xảy ra".`,
    );
  } finally {
    env.cleanup();
  }
});

test("PRODUCTION REPRO — click 2 không được là NO-OP: operator phải luôn thấy checklist", async () => {
  const env = installDom();
  try {
    const ui = await renderProductionPage(env);
    const publishBtn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    await ui.click(publishBtn);

    // Click 2: production thấy Network HOÀN TOÀN TRỐNG. Điều đó chỉ xảy ra khi
    // modal chưa từng đóng (effect deps không đổi) — tức nó đang mở nhưng vô
    // hình. Sau fix, modal mở và NHÌN THẤY ĐƯỢC, nên click 2 không còn là
    // "bấm vào hư không": checklist vẫn ở trên cùng và operator thao tác được.
    const beforeSecond = ui.calls.length;
    await ui.click(publishBtn);

    assert.ok(ui.checklistHeading(), "checklist vẫn phải mở sau click 2");
    assert.equal(
      ui.calls.length,
      beforeSecond,
      "click 2 không tạo request mới (effect deps không đổi) — đúng như Network trống ở production",
    );
    await zIndexUtilitiesFor(["z-50", "z-[100]"]);
    assert.ok(
      paintsAbove(ui.zIndexOf(ui.overlayWith("z-[100]")), ui.zIndexOf(ui.overlayWith("z-50"))),
      "sau click 2 checklist VẪN phải vẽ trên modal 'Sửa Template' (không phải no-op vô hình)",
    );
  } finally {
    env.cleanup();
  }
});

test("GUARD — mọi overlay Document Merge phải vẽ TRÊN modal 'Sửa Template' mà nó được mở từ đó", async () => {
  const env = installDom();
  try {
    const ui = await renderProductionPage(env);
    const publishBtn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    await ui.click(publishBtn);

    await zIndexUtilitiesFor(["z-50", "z-[60]", "z-[100]"]);
    const editorZ = ui.zIndexOf(ui.overlayWith("z-50"));
    const overlays = ui
      .overlays()
      .map((el) => ({ cls: (el.className ?? "").trim(), z: ui.zIndexOf(el) }))
      .filter((o) => o.cls !== (ui.overlayWith("z-50")?.className ?? "").trim());

    assert.ok(overlays.length > 0, "phải có ít nhất một overlay lồng nhau để kiểm tra");
    for (const overlay of overlays) {
      assert.ok(
        paintsAbove(overlay.z, editorZ),
        `Overlay "${overlay.cls}" có z-index hiệu dụng ${overlay.z} <= modal "Sửa Template" ${editorZ} — ` +
          `nó sẽ bị chôn dưới modal editor (cùng lớp lỗi với PublishChecklistModal z-[100]). ` +
          `Thêm lớp của nó vào thang z-index trong document-merge-parity.css.`,
      );
    }
  } finally {
    env.cleanup();
  }
});

test("GUARD — thang z-index trong parity CSS không được chôn bất kỳ lớp modal Document Merge nào", async () => {
  const env = installDom();
  try {
    // Dựng một cây tối thiểu nhưng dùng CSS THẬT: nếu parity CSS nâng một
    // lớp LÊN TRÊN lớp vốn cao hơn nó, thứ tự khai báo của component bị đảo.
    for (const css of await documentMergeStylesheets()) {
      const style = env.document.createElement("style");
      style.textContent = css;
      env.document.head.appendChild(style);
    }
    const host = env.document.createElement("div");
    host.className = "document-merge-parity";
    env.document.body.appendChild(host);

    // Khám phá MỌI lớp z-index mà overlay `fixed inset-0` của Document Merge
    // đang khai báo (nguồn: chính các component thật). Regex chỉ dùng để TÌM
    // lớp; kết luận vẫn dựa trên cascade CSS thật bên dưới.
    const declared = discoverDocumentMergeOverlayLayers();
    assert.ok(
      declared.includes("z-50") && declared.includes("z-[100]"),
      `phải khám phá được lớp của modal editor (z-50) và PublishChecklistModal (z-[100]), thực tế: ${declared.join(", ")}`,
    );
    await zIndexUtilitiesFor(declared);

    const effective = new Map<string, number>();
    for (const layer of declared) {
      const el = env.document.createElement("div");
      el.className = `fixed inset-0 ${layer}`;
      host.appendChild(el);
      effective.set(layer, Number(env.window.getComputedStyle(el).zIndex));
    }

    // Lớp cơ sở: modal "Sửa Template" — mọi modal Document Merge khác đều được
    // mở TỪ nó nên phải vẽ trên nó.
    const editorLayer = effective.get("z-50");
    assert.ok(editorLayer !== undefined);
    const reported = declared.map((l) => `${l}=${effective.get(l)}`).join(", ");
    for (const layer of declared) {
      if (layer === "z-50") continue;
      assert.ok(
        (effective.get(layer) as number) > (editorLayer as number),
        `Lớp overlay "${layer}" có z-index hiệu dụng ${effective.get(layer)} <= modal "Sửa Template" ${editorLayer} ` +
          `(${reported}) — nó sẽ bị chôn dưới modal editor, đúng lớp lỗi production của PublishChecklistModal. ` +
          `Hãy thêm lớp này vào thang z-index trong document-merge-parity.css.`,
      );
    }

    // Thứ tự tương đối mà component khai báo phải được GIỮ (50 < 60 < 100).
    const ordered = [...declared].sort(
      (a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")),
    );
    for (let i = 1; i < ordered.length; i += 1) {
      assert.ok(
        (effective.get(ordered[i]) as number) > (effective.get(ordered[i - 1]) as number),
        `parity CSS đảo thứ tự khai báo giữa ${ordered[i - 1]} và ${ordered[i]} (${reported})`,
      );
    }
  } finally {
    env.cleanup();
  }
});

/**
 * Quét các component Document Merge thật để lấy mọi lớp z-index mà overlay
 * `fixed inset-0` đang khai báo. Trả về danh sách đã sort theo số.
 */
function discoverDocumentMergeOverlayLayers(): string[] {
  const files = [
    "../../components/document-merge/template-library.tsx",
    "../../components/document-merge/publish-checklist-modal.tsx",
    "../../components/document-merge/draft-version-preview-modal.tsx",
    "../../components/document-merge/version-clone-modals.tsx",
  ];
  const layers = new Set<string>();
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(/fixed inset-0 (z-(?:\[\d+\]|\d+))/g)) layers.add(match[1]);
  }
  return [...layers].sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
}
