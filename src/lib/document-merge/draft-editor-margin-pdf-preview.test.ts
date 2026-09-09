/**
 * TEMPLATE-VERSION-SPECIFIC A4 MARGIN CONTROLS — DraftVersionEditorModal.
 *
 * The DB schema, server-side validation (validateMargins/resolveAndValidateMargins
 * in template-versions.ts), the PATCH route, and the 4 margin input fields
 * themselves already existed before this change (Phase 4) — see
 * template-versions.test.ts / template-version-edit.test.ts /
 * page-margins.test.ts for that coverage. This file locks the two things
 * added here:
 *
 *   1. The margin inputs use the requested "Lề trên/dưới/trái/phải (mm)"
 *      labels inside a "Cài đặt trang" section, 0-60mm, step 1.
 *   2. An authoritative "Xem trước PDF A4" button now lives NEXT TO those
 *      margin fields (same editor, same box as "Lưu bản nháp") — calling
 *      the EXACT SAME /preview-pdf endpoint as draft-version-preview-modal.tsx
 *      (no second Chromium/render configuration), disabled while there are
 *      unsaved edits so it can never preview stale-vs-editor content.
 *
 * Repo has no jsdom (see draft-editor-save-loop.test.ts) — tests read the
 * real production source and lock these facts via static assertions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MODAL_PATH = "src/components/document-merge/version-clone-modals.tsx";
const modalFile = readFileSync(new URL(`../../../${MODAL_PATH}`, import.meta.url), "utf8");

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Slice the DraftVersionEditorModal body (declaration to the next modal). */
function sliceDraftEditorModal(source: string): string {
  const startMarker = "export function DraftVersionEditorModal(";
  const endMarker = "\nfunction ApplyToDraftConfirmModal(";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start !== -1, "DraftVersionEditorModal not found — has it been renamed/moved?");
  assert.ok(end !== -1 && end > start, "ApplyToDraftConfirmModal boundary not found");
  return stripComments(source.slice(start, end));
}

const editor = sliceDraftEditorModal(modalFile);

test("Cài đặt trang section carries the requested Lề trên/dưới/trái/phải (mm) labels, 0-60mm step 1", () => {
  assert.match(editor, /Cài đặt trang \(A4\)/);
  for (const label of ["Lề trên (mm)", "Lề dưới (mm)", "Lề trái (mm)", "Lề phải (mm)"]) {
    assert.ok(editor.includes(label), `missing margin label: ${label}`);
  }
  const marginInputBlock = editor.slice(editor.indexOf("Cài đặt trang"), editor.indexOf("Mặc định 10/10/12/12mm"));
  const numberInputs = marginInputBlock.match(/type="number"/g) ?? [];
  assert.equal(numberInputs.length, 4, "exactly 4 numeric margin inputs");
  assert.equal((marginInputBlock.match(/min=\{0\}/g) ?? []).length, 4);
  assert.equal((marginInputBlock.match(/max=\{60\}/g) ?? []).length, 4);
  assert.equal((marginInputBlock.match(/step=\{1\}/g) ?? []).length, 4);
});

test("margin inputs are bound to marginTopMm/BottomMm/LeftMm/RightMm state (same fields the PATCH save() call sends)", () => {
  for (const field of ["marginTopMm", "marginBottomMm", "marginLeftMm", "marginRightMm"]) {
    assert.match(editor, new RegExp(`value=\\{${field}\\}`), `input not bound to ${field}`);
    assert.match(editor, new RegExp(`onChange=\\{\\(e\\) => set${field[0].toUpperCase()}${field.slice(1)}\\(Number\\(e\\.target\\.value\\)\\)\\}`));
  }
});

test("Xem trước PDF A4 button sits next to Lưu bản nháp, calls the SAME /preview-pdf endpoint, no second render config", () => {
  // Anchor on the actual button onClick wiring, not the label text — the
  // Công cụ phân trang toolbar's own helper text also mentions both button
  // labels in prose (bấm Lưu bản nháp rồi Xem trước PDF A4), so a bare
  // indexOf() on the labels alone would match that prose instead of the
  // real buttons.
  const saveOnClickIdx = editor.indexOf("onClick={() => void save()}");
  const pdfOnClickIdx = editor.indexOf("onClick={() => void runPdfPreview()}");
  assert.ok(saveOnClickIdx !== -1 && pdfOnClickIdx !== -1);
  assert.ok(pdfOnClickIdx > saveOnClickIdx, "Xem trước PDF A4 must appear after Lưu bản nháp in the same box");
  assert.ok(pdfOnClickIdx - saveOnClickIdx < 1000, "Xem trước PDF A4 must be close to (in the same box as) Lưu bản nháp");

  assert.match(
    editor,
    /\/api\/document-merge\/templates\/\$\{templateId\}\/versions\/\$\{version\.id\}\/preview-pdf/,
    "must call the exact same preview-pdf route the authoritative preview modal uses, addressed at THIS versionId",
  );
  // Never a second Chromium/page.pdf() configuration — this route call is
  // the ONLY thing runPdfPreview does; no local PDF rendering library.
  assert.doesNotMatch(editor, /page\.pdf\(|puppeteer|new Chromium|launch\(/i);
});

test("Xem trước PDF A4 is disabled while there are unsaved edits (dirty) — never previews stale-vs-editor content", () => {
  const pdfOnClickIdx = editor.indexOf("onClick={() => void runPdfPreview()}");
  const button = editor.slice(pdfOnClickIdx - 50, editor.indexOf("Xem trước PDF A4", pdfOnClickIdx));
  assert.match(button, /disabled=\{pdfLoading \|\| dirty \|\| conflict\}/);
});

test("runPdfPreview requires a selected candidate and sends signingContext, mirroring the authoritative preview modal's contract", () => {
  const handlerStart = editor.indexOf("const runPdfPreview = async () => {");
  assert.ok(handlerStart !== -1);
  const handler = editor.slice(handlerStart, editor.indexOf("\n  };", handlerStart));
  assert.match(handler, /if \(!selectedCandidate\)/);
  assert.match(handler, /applicationId: selectedCandidate\.id/);
  assert.match(handler, /signingContext: signingContextBody\(signingContext\)/);
  assert.match(handler, /method: "POST"/);
});

test("PDF result is never persisted — blob: URL only, revoked on replace/unmount", () => {
  assert.match(editor, /URL\.createObjectURL\(blob\)/);
  assert.match(editor, /URL\.revokeObjectURL\(/);
  assert.doesNotMatch(editor, /candidateDocuments|mergeJobs|merge_jobs|storage\.put|getStorageProvider/);
});
