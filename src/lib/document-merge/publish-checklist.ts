/**
 * PUBLISH CHECKLIST (pure, no React/DOM) — the explicit operator gate required
 * before a template version is published, in addition to the machine checks
 * that /ai-analyze already computes (htmlValid, cssValid, security.errors).
 *
 * Publish must remain explicit and manual: this module NEVER auto-confirms
 * any checklist item — every operator checkbox starts false, and
 * canConfirmPublish() is the single source of truth for enabling the actual
 * "Xuất bản" button in PublishChecklistModal.
 *
 * MACHINE CHECKS — the gate mirrors EVERY precondition the backend
 * `publishTemplateVersion` enforces (template-versions.ts), so the checklist
 * can never be more permissive than the API:
 *   1. htmlValid / cssValid          — structural validity (ai-analyze)
 *   2. securityBlockerCount === 0    — security scanner (ai-analyze)
 *   3. hasHtmlBody                   — backend 400 "chưa có nội dung HTML"
 *   4. placeholderCoverageOk         — backend validatePlaceholderCoverage:
 *      UNMAPPED + REQUIRED_UNRESOLVABLE placeholders block publish
 *   5. statusPublishable             — DRAFT → publishable; ARCHIVED → restorable
 *      (rollback); PUBLISHED → nothing to do (backend no-op, UI must not offer it)
 *
 * describePublishBlockers() renders the SAME preconditions as operator-facing
 * reasons with the specific placeholder names — a disabled Confirm button must
 * always be explainable from the checklist itself, never a silent disable.
 */

export const PUBLISH_CHECKLIST_ITEMS = [
  { key: "previewed", label: "Tôi đã xem Preview" },
  { key: "printed", label: "Tôi đã mở/In PDF TEST" },
  { key: "layoutA4", label: "Tôi xác nhận bố cục A4" },
  { key: "legalContent", label: "Tôi xác nhận nội dung pháp lý" },
  { key: "mergeData", label: "Tôi xác nhận dữ liệu merge đúng" },
] as const;

export type PublishChecklistKey = (typeof PUBLISH_CHECKLIST_ITEMS)[number]["key"];
export type PublishChecklistState = Record<PublishChecklistKey, boolean>;

/** Every checklist item starts unchecked — never pre-confirmed. */
export function emptyPublishChecklistState(): PublishChecklistState {
  return Object.fromEntries(PUBLISH_CHECKLIST_ITEMS.map((item) => [item.key, false])) as PublishChecklistState;
}

export function allChecklistItemsConfirmed(state: PublishChecklistState): boolean {
  return PUBLISH_CHECKLIST_ITEMS.every((item) => state[item.key] === true);
}

/**
 * One of the machine checks, as computed by the checklist from the FRESH
 * server row (GET /versions) + the /ai-analyze response. `machine === null`
 * means "not yet loaded / load failed" and always blocks confirm.
 */
export type PublishMachineChecks = {
  /** /ai-analyze: HTML well-formedness on the version's current html_body. */
  htmlValid: boolean;
  /** Count of structural HTML issues (for the blocker text). */
  htmlIssueCount: number;
  /** /ai-analyze: CSS parse validity (print_css may legitimately be empty). */
  cssValid: boolean;
  /** Count of structural CSS issues (for the blocker text). */
  cssIssueCount: number;
  /** /ai-analyze's security.errors.length — ERROR-severity findings only; warnings never block. */
  securityBlockerCount: number;
  /**
   * /ai-analyze's placeholderCoverage — the SAME validatePlaceholderCoverage
   * the backend runs inside publishTemplateVersion (live non-orphaned fields
   * vs the version's html_body). False ⇔ publish would be rejected with 400.
   */
  placeholderCoverageOk: boolean;
  /** Placeholders present in the HTML but with NO mapping row at all. */
  unmappedPlaceholders: string[];
  /** Mapped but isRequired=true with no sourceField/sourcePath/fallbackValue. */
  requiredUnresolvablePlaceholders: string[];
  /** Version's html_body is non-empty (backend 400 otherwise). */
  hasHtmlBody: boolean;
  /**
   * Version's ACTUAL status at checklist time, re-read from the server:
   * DRAFT publishable via publish; ARCHIVED publishable via rollback
   * ("Khôi phục"); PUBLISHED → no-op, the UI must not offer (re)publish.
   */
  versionStatus: "DRAFT" | "PUBLISHED" | "ARCHIVED" | "UNKNOWN";
  /** True iff the current action can proceed against versionStatus. */
  statusPublishable: boolean;
};

export function machineChecksPassed(checks: PublishMachineChecks): boolean {
  return (
    checks.htmlValid &&
    checks.cssValid &&
    checks.securityBlockerCount === 0 &&
    checks.hasHtmlBody &&
    checks.placeholderCoverageOk &&
    checks.statusPublishable
  );
}

/**
 * The actual publish gate: machine checks must have run and passed (structural
 * validity + zero security blockers + placeholder coverage + non-empty HTML +
 * publishable status — the same invariants the backend already enforces
 * independently at publish time via validatePlaceholderCoverage / the security
 * scanner / the htmlBody guard), AND every operator checkbox must be explicitly
 * checked. `machine === null` (analysis not yet loaded/failed) always blocks.
 */
export function canConfirmPublish(machine: PublishMachineChecks | null, operator: PublishChecklistState): boolean {
  if (!machine) return false;
  return machineChecksPassed(machine) && allChecklistItemsConfirmed(operator);
}

/**
 * Operator-facing blocker lines — one per failed machine check, with the
 * SPECIFIC placeholder names, in checklist order. Empty array = no blocker:
 * every time this list is non-empty the Confirm button must be disabled AND
 * this exact list must be visible to the operator (no silent disable).
 */
export function describePublishBlockers(checks: PublishMachineChecks): string[] {
  const blockers: string[] = [];
  if (!checks.hasHtmlBody) {
    blockers.push("Version chưa có nội dung HTML (html_body trống) — không thể publish.");
  }
  if (!checks.htmlValid) {
    blockers.push(`HTML có ${checks.htmlIssueCount} lỗi cấu trúc cần khắc phục.`);
  }
  if (!checks.cssValid) {
    blockers.push(`CSS bản in có ${checks.cssIssueCount} lỗi cấu trúc cần khắc phục.`);
  }
  if (checks.securityBlockerCount > 0) {
    blockers.push(`${checks.securityBlockerCount} mã nguy hiểm bị chặn (bỏ <script>/onclick/javascript: URL...) trước khi publish.`);
  }
  if (checks.unmappedPlaceholders.length > 0) {
    blockers.push(
      `${checks.unmappedPlaceholders.length} placeholder trong HTML chưa được mapping: ${checks.unmappedPlaceholders.join(", ")}.`,
    );
  }
  if (checks.requiredUnresolvablePlaceholders.length > 0) {
    blockers.push(
      `${checks.requiredUnresolvablePlaceholders.length} placeholder BẮT BUỘC chưa có nguồn dữ liệu/fallback: ${checks.requiredUnresolvablePlaceholders.join(", ")}.`,
    );
  }
  if (!checks.statusPublishable) {
    if (checks.versionStatus === "PUBLISHED") {
      blockers.push("Version này HIỆN ĐANG PUBLISHED — không có gì để publish/khôi phục. Đóng checklist này lại.");
    } else if (checks.versionStatus === "ARCHIVED") {
      blockers.push("Version này hiện đang ARCHIVED — để đưa lại làm bản hiện hành hãy dùng nút \"Khôi phục\".");
    } else if (checks.versionStatus === "DRAFT") {
      blockers.push("Version này hiện đang DRAFT — để xuất bản hãy dùng nút \"Xuất bản phiên bản\".");
    } else {
      blockers.push("Không xác định được trạng thái version trên server — hãy tải lại danh sách phiên bản.");
    }
  }
  return blockers;
}
