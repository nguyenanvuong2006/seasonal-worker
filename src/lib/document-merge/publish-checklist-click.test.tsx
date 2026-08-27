/**
 * PUBLISH CHECKLIST — REPRO HÀNH VI THẬT (Phase 2 / Phase 6)
 * cho bug production: "v16 DRAFT — nút 'Xuất bản phiên bản' HIỆN RA nhưng
 * BẤM KHÔNG CÓ GÌ XẢY RA: không modal, không lỗi, không request".
 *
 * VÌ SAO CẦN FILE NÀY (khác publish-checklist-repro.test.ts):
 *   File repro cũ chỉ đọc source bằng REGEX. Regex xác nhận được "có
 *   onClick={() => setPublishChecklistTarget(...)}" và "có
 *   {editing && publishChecklistTarget && <PublishChecklistModal .../>}",
 *   nhưng KHÔNG THỂ phát hiện triệu chứng thật của bug này: click có fire
 *   không, state có đổi không, modal có MOUNT không, effect có reset state
 *   không, ai-analyze fail thì modal có biến mất không. Đó đúng là các câu
 *   hỏi Phase 1. Nên file này render component THẬT trong jsdom và bấm nút
 *   THẬT (dispatch MouseEvent bubbling như trình duyệt).
 *
 * KHÔNG ghi DB, không gọi mạng thật: fetch được stub và mọi request đều
 * được ghi lại để assert "click = zero DB writes".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../test-support/render-tsx.ts";

const MODAL_URL = new URL("../../components/document-merge/publish-checklist-modal.tsx", import.meta.url);

/** v16-like DRAFT — đúng hình dạng row server trả về. */
const V16 = {
  id: "3f2b9c14-9a77-4d51-8c3e-16f0aa77b016",
  templateId: "tpl-hd-thoi-vu",
  version: 16,
  status: "DRAFT" as const,
  htmlBody: "<h1>Hợp đồng thời vụ</h1><p>Ông/Bà {{full_name}}</p>",
  printCss: "@page { size: A4; margin: 20mm; }",
  sourceDocxName: null,
  retentionYears: 3,
  mappingSnapshot: [],
  createdBy: "admin",
  publishedAt: null,
  archivedAt: null,
  createdAt: "2026-08-27T00:00:00.000Z",
};

const V15_ARCHIVED = { ...V16, id: "v15-archived-id", version: 15, status: "ARCHIVED" as const, htmlBody: "<h1>v15</h1>" };
const V14_PUBLISHED = { ...V16, id: "v14-published-id", version: 14, status: "PUBLISHED" as const, htmlBody: "<h1>v14</h1>" };

const ANALYZE_OK = {
  htmlValid: true,
  htmlIssues: [],
  cssValid: true,
  cssIssues: [],
  security: { errors: [], warnings: [] },
  placeholders: { unchanged: 1, added: 0, removed: 0 },
  mappingsAffected: 0,
  layoutWarnings: [],
  placeholderCoverage: { ok: true, totalPlaceholders: 1, mappedFields: 1, issues: [] },
};

type FetchCall = { url: string; method: string };

/**
 * Render TemplateLibrary thật với template đang mở (editing) + danh sách
 * version, rồi trả về helper để bấm nút trên card.
 */
async function renderLibrary(
  env: RenderEnv,
  versions: unknown[],
  opts: {
    analyzeStatus?: number;
    analyzeBody?: unknown;
    versionsStatusAfterOpen?: number;
    /** Treo vĩnh viễn POST .../archive để mô phỏng latch versionAction bị kẹt. */
    hangArchive?: boolean;
  } = {},
) {
  const calls: FetchCall[] = [];
  let versionsGets = 0;
  const template = {
    id: "tpl-hd-thoi-vu",
    name: "Hợp đồng lao động thời vụ",
    description: null,
    googleDocId: "gdoc-1",
    outputFolderId: null,
    outputFileNamePattern: null,
    defaultMergeMode: "INDIVIDUAL_DOCUMENTS",
    documentKind: "A",
    dataSources: [],
    isActive: true,
    currentPublishedVersion: 14,
    retentionYears: 3,
  };

  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const json = async (body: unknown, status = 200) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    if (url.endsWith("/api/document-merge/templates")) return json([template]);
    if (/\/versions$/.test(url)) {
      // Lần GET đầu tiên (openEdit) luôn thành công để card version render
      // được; chỉ lần GET của CHECKLIST mới mô phỏng lỗi server.
      versionsGets += 1;
      if (opts.versionsStatusAfterOpen && versionsGets > 1) {
        return json({ error: "Server lỗi khi đọc version." }, opts.versionsStatusAfterOpen);
      }
      return json(versions);
    }
    if (/\/mappings/.test(url)) return json([]);
    // Request không bao giờ resolve → versionAction giữ nguyên giá trị
    // (đúng kịch bản production: mạng treo / tab ngủ / request bị huỷ).
    if (/\/archive$/.test(url) && opts.hangArchive) return new Promise<Response>(() => {});
    if (/\/ai-analyze$/.test(url)) {
      const status = opts.analyzeStatus ?? 200;
      return json(opts.analyzeBody ?? (status >= 400 ? { error: "AI analyze sập." } : ANALYZE_OK), status);
    }
    return json({});
  };

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("../../components/document-merge/template-library.tsx", import.meta.url));
  const TemplateLibrary = mod.TemplateLibrary as (props: unknown) => unknown;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(TemplateLibrary as never, { onSelectForMerge: () => {} } as never));
  });

  // Mở "Sửa Template" (đưa component vào đúng trạng thái production: card
  // version nằm BÊN TRONG modal lớn "Sửa Template").
  const editBtn = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Sửa"));
  assert.ok(editBtn, "không tìm thấy nút mở template để sửa");
  await act(async () => {
    editBtn!.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });

  return {
    calls,
    container,
    root,
    act,
    /** Tất cả nút có nhãn chính xác (trên card version, không tính nút trong modal checklist). */
    buttonsLabelled: (label: string) =>
      [...container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === label),
    checklistModal: () =>
      [...container.querySelectorAll("h3")].find((h) => (h.textContent ?? "").includes("Xác nhận xuất bản")) ?? null,
    text: () => container.textContent ?? "",
  };
}

test("PHASE 1/2 — v16 DRAFT: click 'Xuất bản phiên bản' PHẢI mở PublishChecklistModal (repro click thật, không regex)", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V16, V15_ARCHIVED, V14_PUBLISHED]);

    const publishButtons = ui.buttonsLabelled("Xuất bản phiên bản");
    // Q1 — nút có tồn tại và KHÔNG bị disabled?
    assert.equal(publishButtons.length, 1, "DRAFT v16 phải có đúng 1 nút 'Xuất bản phiên bản' trên card");
    const btn = publishButtons[0] as HTMLButtonElement;
    assert.equal(btn.disabled, false, "Q1: nút không được disabled khi không có version action nào chạy");

    // Q2 — CSS pointer-events có chặn click không?
    assert.notEqual(env.window.getComputedStyle(btn).pointerEvents, "none", "Q2: pointer-events:none sẽ nuốt click");

    // Q4..Q7 — click THẬT (bubbling như trình duyệt) → state → modal mount.
    const before = ui.calls.length;
    await ui.act(async () => {
      btn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    // Q7 — modal phải render.
    assert.ok(
      ui.checklistModal(),
      "BUG: click nút publish của v16 DRAFT KHÔNG mở PublishChecklistModal (đúng triệu chứng production: bấm không có gì xảy ra)",
    );

    // Q9/Q5 — modal phải đọc lại version từ server theo ĐÚNG versionId v16.
    const newCalls = ui.calls.slice(before);
    assert.ok(
      newCalls.some((c) => /\/versions$/.test(c.url) && c.method === "GET"),
      "modal phải GET lại danh sách version (server-fresh) sau khi mở",
    );

    // Phase 6.9 — click KHÔNG được ghi DB.
    assert.equal(
      newCalls.filter((c) => c.method !== "GET" && !/ai-analyze$/.test(c.url)).length,
      0,
      "click mở checklist phải là ZERO DB writes (chỉ GET + POST ai-analyze read-only)",
    );
  } finally {
    env.cleanup();
  }
});

test("PHASE 6.7 — modal KHÔNG tự đóng sau khi ai-analyze xong (không có effect reset state)", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V16]);
    const btn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    await ui.act(async () => {
      btn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.ok(ui.checklistModal(), "modal phải mở");

    // Cho mọi promise/effect chạy xong — Q8: modal có bị effect nào reset không?
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.ok(ui.checklistModal(), "Q8: modal KHÔNG được tự đóng sau khi analyze hoàn tất");
  } finally {
    env.cleanup();
  }
});

test("PHASE 6.6 — ai-analyze lỗi: modal VẪN hiển thị và hiện lỗi rõ ràng (không im lặng, không đóng)", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V16], { analyzeStatus: 500, analyzeBody: { error: "AI analyze sập." } });
    const btn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    await ui.act(async () => {
      btn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.ok(ui.checklistModal(), "modal phải VẪN mở khi ai-analyze fail");
    assert.match(ui.text(), /AI analyze sập\./, "lỗi ai-analyze phải hiển thị cho operator (không silent)");
  } finally {
    env.cleanup();
  }
});

test("PHASE 5 — GET versions lỗi: modal mở và hiện lỗi, KHÔNG tự đóng", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V16], { versionsStatusAfterOpen: 500 });
    const btn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    await ui.act(async () => {
      btn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.ok(ui.checklistModal(), "GET versions fail vẫn phải giữ modal mở");
    assert.match(ui.text(), /Server lỗi khi đọc version\.|Không tải được phiên bản/, "phải hiện lỗi trong modal");
  } finally {
    env.cleanup();
  }
});

test("PHASE 6.2/6.3 — ARCHIVED không có nút publish; PUBLISHED không có nút publish thường", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V15_ARCHIVED, V14_PUBLISHED]);
    assert.equal(ui.buttonsLabelled("Xuất bản phiên bản").length, 0, "ARCHIVED/PUBLISHED không được có nút 'Xuất bản phiên bản'");
    assert.equal(ui.buttonsLabelled("Xuất bản lại").length, 0, "PUBLISHED không được có nút 'Xuất bản lại'");
    assert.equal(ui.buttonsLabelled("Khôi phục").length, 1, "ARCHIVED phải có nút 'Khôi phục'");
  } finally {
    env.cleanup();
  }
});

test("PHASE 6.4 — modal phân tích ĐÚNG versionId đã bấm (v16), không dùng current_published_version làm nguồn nội dung", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V16, V14_PUBLISHED]);
    const btn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    await ui.act(async () => {
      btn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // Modal hiển thị đúng v16 (không phải v14 đang PUBLISHED).
    const heading = ui.checklistModal();
    assert.ok(heading, "modal phải mở");
    assert.match(heading!.textContent ?? "", /v16/, "checklist phải nói về v16 — version vừa bấm");
  } finally {
    env.cleanup();
  }
});

/** PHASE 3 — stacking: checklist phải nằm TRÊN modal 'Sửa Template'. */
test("PHASE 3 — PublishChecklistModal có z-index CAO HƠN modal 'Sửa Template' và không bị clip", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V16]);
    const btn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    await ui.act(async () => {
      btn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const overlays = [...ui.container.querySelectorAll("div")].filter((d) => d.className.includes("fixed inset-0"));
    const templateOverlay = overlays.find((d) => d.className.includes("z-50"));
    const checklistOverlay = overlays.find((d) => d.className.includes("z-[100]"));
    assert.ok(templateOverlay, "modal 'Sửa Template' phải là overlay fixed z-50");
    assert.ok(checklistOverlay, "checklist phải là overlay fixed z-[100] — cao hơn z-50");
    // Checklist KHÔNG được nằm bên trong overlay template (tránh stacking context/overflow clip).
    assert.equal(
      templateOverlay!.contains(checklistOverlay!),
      false,
      "checklist không được render BÊN TRONG overlay template (sẽ bị stacking context / overflow-y-auto clip)",
    );
  } finally {
    env.cleanup();
  }
});

test("PHASE 4/6.10 — Hủy checklist: modal đóng, ZERO DB writes", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V16]);
    const btn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    await ui.act(async () => {
      btn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const cancel = ui.buttonsLabelled("Hủy")[0] as HTMLButtonElement;
    assert.ok(cancel, "phải có nút Hủy");
    await ui.act(async () => {
      cancel.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.equal(ui.checklistModal(), null, "Hủy phải đóng checklist");
    assert.equal(
      ui.calls.filter((c) => c.method === "POST" && !/ai-analyze$/.test(c.url)).length,
      0,
      "Hủy phải là ZERO DB writes",
    );
  } finally {
    env.cleanup();
  }
});


/* ============================================================
   ROOT CAUSE — LATCH `versionAction` LÀM NÚT PUBLISH CHẾT ÂM THẦM
   ------------------------------------------------------------
   Đây là repro CHÍNH XÁC của bug production v16: nút hiện ra, bấm
   KHÔNG có modal / KHÔNG lỗi / KHÔNG request. Nguyên nhân: nút có
   `disabled={versionAction !== null}` — latch dùng chung cho mọi
   version action; một request trước đó chưa kết thúc là nút chết,
   mà `disabled:opacity-50` trên nền emerald-700 gần như không thấy
   được nên operator tưởng nút vẫn bình thường.
   ============================================================ */

test("ROOT CAUSE — thao tác khác đang chạy: nút publish v16 VẪN bấm được VÀ click LUÔN có phản hồi nhìn thấy (không im lặng)", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V16], { hangArchive: true });

    // Operator bấm "Lưu trữ" trước — request treo → versionAction bị kẹt.
    const archive = ui.buttonsLabelled("Lưu trữ")[0] as HTMLButtonElement;
    assert.ok(archive, "DRAFT phải có nút 'Lưu trữ'");
    await ui.act(async () => {
      archive.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const btn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    assert.ok(btn, "nút publish vẫn phải hiển thị");

    // REGRESSION 1 — nút KHÔNG được disabled (trước fix: true → click bị nuốt).
    assert.equal(
      btn.disabled,
      false,
      "REGRESSION: nút publish bị disabled bởi latch versionAction → click bị trình duyệt nuốt, đúng bug production 'bấm không có gì xảy ra'",
    );

    // REGRESSION 2 — click PHẢI tạo phản hồi nhìn thấy được (Phase 4).
    const before = ui.container.textContent ?? "";
    await ui.act(async () => {
      btn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const modalOpened = ui.checklistModal() !== null;
    const alertShown = (ui.container.querySelector("[role=alert]")?.textContent ?? "").trim().length > 0;
    assert.ok(
      modalOpened || alertShown,
      "PHASE 4: click PHẢI cho phản hồi — mở checklist HOẶC hiện lỗi giải thích. Không bao giờ im lặng.",
    );
    assert.notEqual(ui.container.textContent, before, "giao diện phải thay đổi sau click (bằng chứng có phản hồi)");
  } finally {
    env.cleanup();
  }
});

test("PHASE 4 — thông báo 'không mở được' hiển thị BÊN TRONG modal Sửa Template (không bị overlay che)", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V16], { hangArchive: true });
    const archive = ui.buttonsLabelled("Lưu trữ")[0] as HTMLButtonElement;
    await ui.act(async () => {
      archive.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const btn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    await ui.act(async () => {
      btn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const alertEl = ui.container.querySelector("[role=alert]");
    if (alertEl) {
      const overlay = [...ui.container.querySelectorAll("div")].find(
        (d) => d.className.includes("fixed inset-0") && d.className.includes("z-50"),
      );
      assert.ok(overlay, "modal 'Sửa Template' phải tồn tại");
      assert.ok(
        overlay!.contains(alertEl),
        "thông báo phải nằm TRONG modal đang mở — nếu nằm ngoài, operator không nhìn thấy và click vẫn là no-op im lặng",
      );
    }
  } finally {
    env.cleanup();
  }
});

test("PHASE 6.1 — không có thao tác nào chạy: click v16 DRAFT mở checklist bình thường (fix không chặn happy path)", async () => {
  const env = installDom();
  try {
    const ui = await renderLibrary(env, [V16]);
    const btn = ui.buttonsLabelled("Xuất bản phiên bản")[0] as HTMLButtonElement;
    assert.equal(btn.disabled, false);
    await ui.act(async () => {
      btn.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.ok(ui.checklistModal(), "happy path phải mở checklist");
    assert.equal(ui.container.querySelector("[role=alert]"), null, "happy path không được hiện lỗi");
  } finally {
    env.cleanup();
  }
});
