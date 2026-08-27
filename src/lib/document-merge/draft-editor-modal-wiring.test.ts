/**
 * DRAFT EDITOR PRELOAD WIRING — structural regression tests for
 * DraftVersionEditorModal (src/components/document-merge/version-clone-modals.tsx).
 *
 * No testing-library/jsdom is installed in this repo, so this component
 * cannot be rendered under `node --test`. Instead these tests read the REAL
 * production source and assert, on the isolated function body of
 * DraftVersionEditorModal (sliced between its own `export function` and the
 * next top-level declaration, so a match can never come from a sibling
 * modal in the same file), the specific wiring facts the "FIX DRAFT
 * HTML/CSS EDITOR — PRELOAD CURRENT TEMPLATE" mission requires:
 *
 *   1. html/css state is seeded straight from the explicit `version` prop
 *      (never from any current_published_version field).
 *   2. The editor opens on the mode that actually shows that preloaded
 *      content, not the empty "Dán HTML hoàn chỉnh" paste target.
 *   3./4. The "Nạp HTML hiện tại" / "Khôi phục nội dung đã lưu" actions are
 *      wired, local-only (no network request), and derive from the DRAFT
 *      version prop.
 *   8. Both close affordances (X, "Hủy") route through the dirty-check
 *      before calling onCancel, instead of closing unconditionally.
 *
 * Pure logic behind these facts (compose/dirty-check) has its own
 * behavioral unit tests in draft-editor-preload.test.ts — this file only
 * proves the component actually wires that logic in, since it cannot be
 * rendered here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const COMPONENT_PATH = "src/components/document-merge/version-clone-modals.tsx";
const source = readFileSync(new URL(`../../../${COMPONENT_PATH}`, import.meta.url), "utf8");

const startMarker = "export function DraftVersionEditorModal(";
const endMarker = "\nfunction ApplyToDraftConfirmModal(";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
assert.ok(start !== -1, "DraftVersionEditorModal not found — has it been renamed/moved?");
assert.ok(end !== -1 && end > start, "ApplyToDraftConfirmModal boundary not found — cannot isolate DraftVersionEditorModal");
const modalSource = source.slice(start, end);

// Strip comments the same way template-version-edit.test.ts does, so a
// mention inside a docblock (e.g. explaining what NOT to do) can never
// masquerade as the real wiring being asserted below.
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const modalCode = stripComments(modalSource);

test("DraftVersionEditorModal: HTML textarea state is seeded from the explicit version.htmlBody prop", () => {
  assert.match(modalCode, /useState\(\s*version\.htmlBody\s*\?\?\s*""\s*\)/);
});

test("DraftVersionEditorModal: CSS textarea state is seeded from the explicit version.printCss prop", () => {
  assert.match(modalCode, /useState\(\s*version\.printCss\s*\?\?\s*""\s*\)/);
});

test("DraftVersionEditorModal: never reads current_published_version / currentPublishedVersion as code (comments already stripped)", () => {
  assert.doesNotMatch(modalCode, /current_published_version/i);
  assert.doesNotMatch(modalCode, /currentPublishedVersion/);
});

test("DraftVersionEditorModal: opens on the mode that shows the preloaded html/css, not the empty paste target", () => {
  assert.match(modalCode, /useState<PasteMode>\(\s*"advanced"\s*\)/);
});

test("DraftVersionEditorModal: 'Nạp HTML hiện tại' composes from the DRAFT's saved html/css (baselineHtml/baselineCss), never from current_published_version", () => {
  assert.match(modalSource, /Nạp HTML hiện tại/);
  assert.match(modalCode, /composeFullHtmlDocument\(baselineHtml,\s*baselineCss\)/);
  // Baselines live in state (not derived from the prop) so a successful save
  // can advance them in place — that is what keeps the modal open for
  // repeated save loops. They are still seeded from the explicit DRAFT prop.
  assert.match(modalCode, /const \[baselineHtml, setBaselineHtml\] = useState\(version\.htmlBody \?\? ""\);/);
  assert.match(modalCode, /const \[baselineCss, setBaselineCss\] = useState\(version\.printCss \?\? ""\);/);
});

test("DraftVersionEditorModal: 'Khôi phục nội dung đã lưu' is local-only — its handler body makes no network request", () => {
  assert.match(modalSource, /Khôi phục nội dung đã lưu/);
  const fnMatch = modalCode.match(/const restoreSavedContent = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(fnMatch, "restoreSavedContent handler not found");
  assert.doesNotMatch(fnMatch![1], /fetch\(/, "restoreSavedContent must never call fetch — it is a pure local state reset");
});

test("DraftVersionEditorModal: modal-open effect only ever fires on a non-empty candidate SEARCH term (never on mount)", () => {
  // The only useEffect in this modal is the debounced candidate search; its
  // own state starts at "" and the effect itself early-returns under 2
  // characters — so mounting the modal alone can never trigger a fetch.
  assert.match(modalCode, /const \[candidateQuery, setCandidateQuery\] = useState\(""\);/);
  assert.match(modalCode, /if \(term\.length < 2\) \{/);
});

test("DraftVersionEditorModal: closing (X button and 'Hủy' button) both route through the unsaved-changes check, not onCancel directly", () => {
  assert.match(modalCode, /const requestClose = \(\) => \{/);
  assert.match(modalCode, /if \(dirty && !window\.confirm\(/);
  const closeCalls = modalCode.match(/onClick=\{requestClose\}/g) ?? [];
  assert.equal(closeCalls.length, 2, "expected exactly 2 close affordances (X + Hủy) wired to requestClose");
  // onCancel is still called, but only from inside requestClose itself —
  // never wired directly to a close button's onClick anymore.
  assert.doesNotMatch(modalCode, /onClick=\{onCancel\}/);
});

test("DraftVersionEditorModal: Save/Apply success paths report via onSaved(version.id) — the parent keeps the editor open (see draft-editor-save-loop.test.ts)", () => {
  assert.match(modalCode, /onSaved\(version\.id\);/);
});
