/* ============================================================
   DAILY INTAKE WORKFLOW — LUỒNG TIẾP NHẬN LAO ĐỘNG (thuần, không DB)
   ------------------------------------------------------------
   Nguồn sự thật DUY NHẤT cho các quy tắc phụ thuộc giữa 5 bước tiếp
   nhận: Đăng ký → Xếp việc → Nhập DW Data → Mã số công nhật →
   IT Code / Báo cơm. Mọi route (bulk-import, administration, fingerprint,
   meal) phải gọi qua đây — KHÔNG tự viết lại điều kiện lọc/eligibility.

   QUY TẮC CỨNG (đề bài mục I, VII, IX, XV):
   - "Đã nhập DW Data" là MỘT hành động rõ ràng (dwImportedAt), KHÔNG được
     suy diễn từ status/isImported.
   - Document Merge / IT CODE KHÔNG BAO GIỜ là điều kiện của bước khác.
   - Mã số công nhật LÀ điều kiện cho Fingerprint queue và Meal export.
   - IT CODE KHÔNG BAO GIỜ là điều kiện của Meal export.
   ============================================================ */

export type WorkflowApplicationStatus = {
  status: string;
  dwImportedAt: Date | string | null;
};

/** Xếp việc phải xảy ra TRƯỚC Nhập DW Data (đề bài mục I, IV). */
export function canImportToDw(app: WorkflowApplicationStatus): { ok: true } | { ok: false; reason: string } {
  if (app.status !== "APPROVED") {
    return { ok: false, reason: "Hồ sơ chưa được xếp việc (status khác APPROVED) — cần xếp việc trước khi nhập DW Data." };
  }
  return { ok: true };
}

export function isAlreadyImportedToDw(app: { dwImportedAt: Date | string | null }): boolean {
  return app.dwImportedAt !== null && app.dwImportedAt !== undefined;
}

export type DwImportDecision =
  | { action: "SKIP_NOT_APPROVED"; reason: string }
  | { action: "SKIP_ALREADY_IMPORTED"; reason: string }
  | { action: "LINK_EXISTING"; dwId: string }
  | { action: "INSERT_NEW" };

/**
 * Quyết định hành động Nhập vào DW Data cho 1 hồ sơ (mục IV, XVI CASE 13/14).
 * - Đã nhập rồi (dwImportedAt) -> SKIP, không tạo trùng (idempotent).
 * - Đã có dwId (người DW cũ quay lại đăng ký, dwMatch=MATCHED từ lúc đăng ký) -> LINK_EXISTING,
 *   KHÔNG insert dòng dw_data mới.
 * - Chưa có dwId -> INSERT_NEW (người hoàn toàn mới trong DW Data).
 */
export function decideDwImportAction(app: {
  status: string;
  dwImportedAt: Date | string | null;
  dwId: string | null;
}): DwImportDecision {
  const approvalCheck = canImportToDw(app);
  if (!approvalCheck.ok) return { action: "SKIP_NOT_APPROVED", reason: approvalCheck.reason };
  if (isAlreadyImportedToDw(app)) {
    return { action: "SKIP_ALREADY_IMPORTED", reason: "Hồ sơ đã được nhập vào DW Data trước đó — bỏ qua (idempotent)." };
  }
  if (app.dwId) return { action: "LINK_EXISTING", dwId: app.dwId };
  return { action: "INSERT_NEW" };
}

export type DwCodeSource = { code: string | null };

/** Mã số công nhật đã được cấp chưa (dw_data.code). */
export function hasDailyCode(dw: DwCodeSource): boolean {
  return typeof dw.code === "string" && dw.code.trim().length > 0;
}

/**
 * Đủ điều kiện vào hàng chờ IT Code / Vân tay (mục VII, VIII):
 * đã nhập DW Data VÀ đã có Mã số công nhật. IT CODE tự nó KHÔNG phải điều kiện.
 */
export function isEligibleForFingerprintQueue(app: WorkflowApplicationStatus, dw: DwCodeSource): boolean {
  return isAlreadyImportedToDw(app) && hasDailyCode(dw);
}

/**
 * Đủ điều kiện Báo cơm (mục IX): đã nhập DW Data VÀ đã có Mã số công nhật.
 * KHÔNG yêu cầu IT CODE (đề bài mục IX, XV — cấm dùng IT CODE làm blocker Meal).
 */
export function isEligibleForMealExport(app: WorkflowApplicationStatus, dw: DwCodeSource): boolean {
  return isAlreadyImportedToDw(app) && hasDailyCode(dw);
}

/* ============================================================
   PII MASKING (mục IX, X) — áp dụng quyền privacy.view_cccd/phone/address
   hiện có cho các danh sách/export nghiệp vụ mới (Meal, Administration,
   Fingerprint). KHÔNG tự phát minh cơ chế permission mới.
   ============================================================ */
const MASK = "••••••••";

export function maskTail(value: string | null, visibleTail: number, canView: boolean): string | null {
  if (!value) return value;
  if (canView) return value;
  return value.length > visibleTail ? `${MASK}${value.slice(-visibleTail)}` : MASK;
}

export function maskCccd(value: string | null, canView: boolean): string | null {
  return maskTail(value, 4, canView);
}

export function maskPhone(value: string | null, canView: boolean): string | null {
  return maskTail(value, 3, canView);
}

export function maskAddress(value: string | null, canView: boolean): string | null {
  if (!value) return value;
  return canView ? value : MASK;
}
