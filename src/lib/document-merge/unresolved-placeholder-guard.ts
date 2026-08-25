/**
 * UNRESOLVED PLACEHOLDER GUARD (H2 fix — Defect A / Phase 4).
 *
 * A literal `<<placeholder>>` can only survive canonical rendering when that
 * placeholder has NO corresponding mapping row at all (see
 * unsaved-preview-resolution.test.ts, test #8 vs #9: "optional and blank" is
 * a MAPPED field that resolves to an empty string, never a literal tag — a
 * literal tag always means "genuinely unmapped"). Existing canonical
 * behavior already surfaces this via `unreplaced`/`valid` on the render
 * result; this module does not change that — it only builds ONE clear,
 * reusable, operator-facing Vietnamese message from it, so Preview and Print
 * show the SAME wording instead of two ad-hoc implementations (Phase 3: "the
 * fix must be reusable... do not create two different resolution
 * implementations").
 *
 * Pure, dependency-free — no DOM, no db, no io.
 */

/**
 * Build the operator-facing warning for a render result carrying unresolved
 * placeholders. Returns null when nothing is unresolved (the common case).
 */
export function buildUnresolvedPlaceholderWarning(unreplaced: readonly string[]): string | null {
  if (unreplaced.length === 0) return null;
  const keys = unreplaced.map((p) => `<<${p}>>`).join(", ");
  return `Không thể xem trước đầy đủ: còn ${unreplaced.length} trường chưa được thay thế: ${keys}. Các trường này chưa có mapping — mở Mapping Inspector để gán nguồn dữ liệu trước khi Áp dụng/Xuất bản.`;
}

/** Short banner-title variant (no key list) for tight UI spaces like the print toolbar. */
export function buildUnresolvedPlaceholderTitle(unreplaced: readonly string[]): string | null {
  if (unreplaced.length === 0) return null;
  return `⚠ CẢNH BÁO: còn ${unreplaced.length} trường chưa được thay thế — xem chi tiết trong bản xem trước trước khi in.`;
}
