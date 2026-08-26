/**
 * PUBLISH CHECKLIST (pure, no React/DOM) — the explicit operator gate required
 * before a template version is published, in addition to the machine checks
 * that /ai-analyze already computes (htmlValid, cssValid, security.errors).
 *
 * Publish must remain explicit and manual: this module NEVER auto-confirms
 * any checklist item — every operator checkbox starts false, and
 * canConfirmPublish() is the single source of truth for enabling the actual
 * "Xuất bản" button in PublishChecklistModal.
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

export type PublishMachineChecks = {
  htmlValid: boolean;
  cssValid: boolean;
  /** /ai-analyze's security.errors.length — ERROR-severity findings only; warnings never block. */
  securityBlockerCount: number;
};

export function machineChecksPassed(checks: PublishMachineChecks): boolean {
  return checks.htmlValid && checks.cssValid && checks.securityBlockerCount === 0;
}

/**
 * The actual publish gate: machine checks must have run and passed (structural
 * validity + zero security blockers — the same invariants the backend already
 * enforces independently at publish time via validatePlaceholderCoverage /
 * the security scanner), AND every operator checkbox must be explicitly
 * checked. `machine === null` (analysis not yet loaded/failed) always blocks.
 */
export function canConfirmPublish(machine: PublishMachineChecks | null, operator: PublishChecklistState): boolean {
  if (!machine) return false;
  return machineChecksPassed(machine) && allChecklistItemsConfirmed(operator);
}
