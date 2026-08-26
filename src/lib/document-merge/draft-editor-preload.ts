/**
 * DRAFT EDITOR PRELOAD (pure string/boolean logic, no DOM/React).
 *
 * Backs "Sửa HTML/CSS — phiên bản vN (DRAFT)" (DraftVersionEditorModal in
 * version-clone-modals.tsx). That modal already initializes its "HTML / CSS
 * nâng cao" textareas straight from the explicit DRAFT version passed in
 * (`useState(version.htmlBody ?? "")` / `useState(version.printCss ?? "")`)
 * — NEVER from `current_published_version`. What was actually missing:
 *
 *   - "Dán HTML hoàn chỉnh" mode starts with an empty paste box by design
 *     (it is a paste TARGET) with no way to load the current DRAFT into it
 *     for manual editing — `composeFullHtmlDocument` is the button action
 *     behind "Nạp HTML hiện tại", building one complete document out of the
 *     DRAFT's current `html_body` + `print_css` so the operator can edit it
 *     in place instead of starting from a blank box.
 *   - There was no way to discard local, unsaved edits and go back to the
 *     DRAFT content that was loaded when the editor opened ("Khôi phục nội
 *     dung đã lưu") — `isDraftEditorDirty` is the pure check that decides
 *     whether a close-without-saving warning is needed at all.
 *
 * Round-trips with normalizeFullHtmlDocument() in full-document-normalizer.ts
 * (see its test suite): the composed document's <style> content extracts
 * back out to printCss, and its <body> span extracts back out to htmlBody
 * (modulo the surrounding newlines this function adds for readability,
 * which normalizeFullHtmlDocument — like any HTML parser — does not strip;
 * trimming is left to the operator/analyzer, same as any other pasted doc).
 */

export function composeFullHtmlDocument(htmlBody: string, printCss: string): string {
  const css = (printCss ?? "").trim();
  const body = htmlBody ?? "";
  const styleBlock = css ? `\n<style>\n${css}\n</style>` : "";
  return `<!DOCTYPE html>\n<html>\n<head>${styleBlock}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/**
 * True when EITHER representation (the split "HTML / CSS nâng cao"
 * textareas, or the "Dán HTML hoàn chỉnh" paste box) has local content that
 * differs from what was loaded — regardless of which mode is currently
 * active, since switching modes does not clear the other mode's state.
 */
export function isDraftEditorDirty(input: {
  html: string;
  css: string;
  rawPaste: string;
  baselineHtml: string;
  baselineCss: string;
  baselineRawPaste: string;
}): boolean {
  return (
    input.html !== input.baselineHtml ||
    input.css !== input.baselineCss ||
    input.rawPaste !== input.baselineRawPaste
  );
}
