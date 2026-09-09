/**
 * TEMPLATE EDITOR — USER-CONTROLLED PAGINATION TOOLS (Phase 17).
 *
 * Goal: a non-technical operator controls page breaks inside a DRAFT
 * template through Template Editor's "Công cụ phân trang" toolbar — no SQL
 * migration, no PR, no deploy — then confirms with the authoritative
 * "Xem trước PDF A4" (real Chromium). This file locks the editor-side wiring
 * added in DraftVersionEditorModal:
 *
 *   - "Chèn ngắt trang" inserts `<!-- NGẮT TRANG A4 --> / <div
 *     class="manual-page-break"></div>` at the cursor in the html textarea.
 *   - "Giữ cùng trang" wraps the current selection (or an empty template at
 *     the cursor) in `<div class="keep-together">...</div>`.
 *   - "Giữ với nội dung sau" reuses the EXISTING `keep-with-next-small`
 *     utility class (no duplicate CSS) by editing the class attribute of a
 *     selected opening tag.
 *   - "Xóa ngắt trang" removes the marker nearest the cursor.
 *
 * `.manual-page-break` / `.keep-together` themselves are defined ONCE in the
 * shared LAYOUT_UTILITY_CSS (html-renderer.ts, see layout-utilities.test.ts)
 * — this modal never re-declares that CSS, so the tools work identically for
 * every template, present and future.
 *
 * Repo has no jsdom (see draft-editor-save-loop.test.ts) — tests read the
 * real production source and lock these facts via static assertions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LAYOUT_UTILITY_CSS } from "./html-renderer.ts";

const MODAL_PATH = "src/components/document-merge/version-clone-modals.tsx";
const modalFile = readFileSync(new URL(`../../../${MODAL_PATH}`, import.meta.url), "utf8");

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Slice the DraftVersionEditorModal body (declaration to the next helper). */
function sliceDraftEditorModal(source: string): string {
  const startMarker = "export function DraftVersionEditorModal(";
  const endMarker = "\nfunction ApplyToDraftConfirmModal(";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start !== -1, "DraftVersionEditorModal not found — has it been renamed/moved?");
  assert.ok(end !== -1 && end > start, "ApplyToDraftConfirmModal boundary not found");
  return stripComments(source.slice(start, end));
}

/** Slice the read-only VersionHtmlViewerModal body (PUBLISHED/ARCHIVED). */
function sliceViewerModal(source: string): string {
  const startMarker = "export function VersionHtmlViewerModal(";
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, "VersionHtmlViewerModal not found — has it been renamed/moved?");
  return stripComments(source.slice(start));
}

const editor = sliceDraftEditorModal(modalFile);
const viewer = sliceViewerModal(modalFile);

test("Công cụ phân trang section sits between Cài đặt trang (A4) and Lưu bản nháp / Xem trước PDF A4", () => {
  const marginsIdx = editor.indexOf("Cài đặt trang (A4)");
  const toolsIdx = editor.indexOf("Công cụ phân trang");
  const saveIdx = editor.indexOf("Lưu bản nháp");
  assert.ok(marginsIdx !== -1 && toolsIdx !== -1 && saveIdx !== -1);
  assert.ok(marginsIdx < toolsIdx, "pagination tools must come after page margins");
  assert.ok(toolsIdx < saveIdx, "pagination tools must come before Lưu bản nháp / Xem trước PDF A4");
});

test("Chèn ngắt trang inserts the commented manual-page-break marker at the cursor position", () => {
  assert.match(editor, /Chèn ngắt trang/);
  const handlerStart = editor.indexOf("const insertPageBreak = () => {");
  assert.ok(handlerStart !== -1);
  const handler = editor.slice(handlerStart, editor.indexOf("\n  };", handlerStart));
  assert.match(handler, /selectionStart/);
  assert.match(handler, /<!-- NGẮT TRANG A4 -->/);
  assert.match(handler, /<div class="manual-page-break"><\/div>/);
  assert.doesNotMatch(handler, /<br\s*\/?>/i, "must never insert repeated <br> tags");
});

test("Giữ cùng trang wraps the selection (or inserts an empty template) in .keep-together without corrupting HTML", () => {
  assert.match(editor, /Giữ cùng trang/);
  const handlerStart = editor.indexOf("const wrapKeepTogether = () => {");
  assert.ok(handlerStart !== -1);
  const handler = editor.slice(handlerStart, editor.indexOf("\n  };", handlerStart));
  assert.match(handler, /class="keep-together"/);
  assert.match(handler, /start === end/, "must handle the no-selection case explicitly (safer empty-template fallback)");
});

test("Giữ với nội dung sau reuses the EXISTING keep-with-next-small class — no duplicate CSS class introduced", () => {
  assert.match(editor, /Giữ với nội dung sau/);
  assert.match(editor, /KEEP_WITH_NEXT_CLASS\s*=\s*"keep-with-next-small"/);
  const handlerStart = editor.indexOf("const applyKeepWithNext = () => {");
  assert.ok(handlerStart !== -1);
  const handler = editor.slice(handlerStart, editor.indexOf("\n  };", handlerStart));
  // Safe implementation: requires selecting an existing opening tag and edits
  // its class attribute — never blind-wraps arbitrary selected HTML.
  assert.match(handler, /tagMatch/);
  assert.match(handler, /setPaginationNotice/, "must show a friendly message instead of guessing on a bad selection");
  // Never defines its own break-after/page-break-after rule — reuses the
  // shared utility class only.
  assert.doesNotMatch(editor, /\.keep-with-next-small\s*\{/, "must not re-declare the CSS rule — it already lives in LAYOUT_UTILITY_CSS");
});

test("Xóa ngắt trang removes the marker nearest the cursor", () => {
  assert.match(editor, /Xóa ngắt trang/);
  const handlerStart = editor.indexOf("const removePageBreak = () => {");
  assert.ok(handlerStart !== -1);
  const handler = editor.slice(handlerStart, editor.indexOf("\n  };", handlerStart));
  assert.match(handler, /manual-page-break/);
  assert.match(handler, /setPaginationNotice/);
});

test("all four pagination tool buttons are wired to their handlers and disabled under the same DRAFT-only guard as Save/Preview", () => {
  for (const [label, handler] of [
    ["Chèn ngắt trang", "insertPageBreak"],
    ["Giữ cùng trang", "wrapKeepTogether"],
    ["Giữ với nội dung sau", "applyKeepWithNext"],
    ["Xóa ngắt trang", "removePageBreak"],
  ] as const) {
    const onClickIdx = editor.indexOf(`onClick={${handler}}`);
    assert.ok(onClickIdx !== -1, `missing onClick wiring for ${handler}`);
    const buttonBlock = editor.slice(onClickIdx, onClickIdx + 1000);
    assert.ok(buttonBlock.includes(label), `${handler}'s button block does not contain label ${label}`);
    assert.match(buttonBlock, /disabled=\{disablePaginationTools\}/, `${label} must share the DRAFT-only guard`);
  }
  assert.match(editor, /const disablePaginationTools = conflict \|\| saving;/);
});

test("the html textarea carries the ref the pagination handlers read cursor position from", () => {
  const textareaIdx = editor.indexOf("HTML hiện tại (html_body");
  const textareaBlock = editor.slice(textareaIdx, textareaIdx + 400);
  assert.match(textareaBlock, /ref=\{htmlTextareaRef\}/);
});

test("PUBLISHED/ARCHIVED viewer (VersionHtmlViewerModal) has none of the pagination tool buttons — read-only stays read-only", () => {
  for (const label of ["Chèn ngắt trang", "Giữ cùng trang", "Giữ với nội dung sau", "Xóa ngắt trang", "Công cụ phân trang"]) {
    assert.ok(!viewer.includes(label), `pagination tool leaked into read-only viewer: ${label}`);
  }
});

test("LAYOUT_UTILITY_CSS (the single shared source) already defines .manual-page-break and .keep-together — the editor only ever writes markup, never CSS", () => {
  assert.match(LAYOUT_UTILITY_CSS, /\.manual-page-break\s*\{[^}]*break-before:\s*page/);
  assert.match(LAYOUT_UTILITY_CSS, /\.keep-together\s*\{[^}]*break-inside:\s*avoid/);
  // The editor component itself must never inject a competing definition —
  // template isolation / future-template support depends on there being
  // exactly one definition, shared by every template.
  assert.doesNotMatch(modalFile, /\.manual-page-break\s*\{/);
  assert.doesNotMatch(modalFile, /\.keep-together\s*\{/);
});
