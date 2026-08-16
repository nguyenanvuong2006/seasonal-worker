/**
 * EMPLOYMENT LIFECYCLE — LOGIC THUẦN (không import DB/Next.js) để test được bằng node:test
 * và dùng chung cho cả server (guard) lẫn client (badge).
 *
 * SOURCE OF TRUTH (bắt buộc đọc trước khi sửa nghiệp vụ):
 *   - daily_applications      = LỊCH SỬ ĐĂNG KÝ/XIN VIỆC. Không overwrite, không xoá.
 *   - employment_sessions     = LỊCH SỬ LÀM VIỆC THẬT. Mỗi đợt làm việc = 1 session.
 *   - workforce_movements     = SỰ KIỆN nghỉ việc/thuyên chuyển đã xác nhận.
 *
 * ĐỊNH NGHĨA "ĐANG LÀM VIỆC" (ACTIVE): status = 'APPROVED' AND end_date IS NULL.
 * (PENDING/WAITLIST session chỉ là liên kết đăng ký — chưa phải employment.)
 *
 * INVARIANT #1: 1 worker (1 CCCD) = tối đa 1 session ACTIVE tại một thời điểm.
 * PHÂN BIỆT 3 TRẠNG THÁI:
 *   APPLICATION (đăng ký xin việc) ≠ ALLOCATION/PLANNING (được tính vào request nào)
 *   ≠ EMPLOYMENT (thực sự đang làm ở đâu).
 *   - Planning request hết hạn KHÔNG kết thúc Employment.
 *   - Allocation bị chuyển KHÔNG phải Resignation.
 *   - Chỉ nghiệp vụ Resignation ĐÃ XÁC NHẬN mới kết thúc Employment Session vì nghỉ việc.
 */

/** Trạng thái vòng đời của employment session. */
export const SESSION_ENDED_STATUS = "ENDED";

export const END_REASONS = ["RESIGNATION", "TRANSFER", "RECONCILIATION", "OTHER"] as const;
export type EndReason = (typeof END_REASONS)[number];

export const MOVEMENT_SOURCES = [
  "DEPT_REPORT", // Bộ phận báo nghỉ (Department Manager trong Data Scope)
  "RECRUITER_CONFIRM", // Recruiter có quyền xác nhận nghỉ khi xếp việc mới
  "RECRUITER_REQUEST", // Recruiter yêu cầu xác nhận nghỉ (task chờ xử lý)
  "SELF_DECLARATION", // NLĐ tự khai (KHÔNG bao giờ tự đóng session)
  "RECONCILIATION", // Admin đối soát dữ liệu lịch sử
  "LEGACY", // dữ liệu trước nâng cấp
] as const;
export type MovementSource = (typeof MOVEMENT_SOURCES)[number];

export type SessionLike = {
  status: string;
  endDate: string | null;
};

/** ACTIVE := APPROVED và chưa có end_date. Đây là ĐỊNH NGHĨA duy nhất — không suy đoán chỗ khác. */
export function isSessionActive(session: SessionLike | null | undefined): boolean {
  if (!session) return false;
  return session.status === "APPROVED" && !session.endDate;
}

/**
 * RULE #10 — DEFAULT START DATE: ngày nhận việc mặc định = ngày Recruiter thao tác
 * (hôm nay theo Asia/Ho_Chi_Minh), KHÔNG phải ngày đăng ký (application_date ≠ employment_start_date).
 */
export function defaultStartDate(todayVn: string): string {
  return todayVn;
}

/**
 * RULE #11 — KHÔNG backdate tuỳ ý: Recruiter chỉ được đặt starting_date = hôm nay hoặc tương lai
 * gần. Ngày quá khứ phải đi qua START_DATE_CORRECTION_REQUEST (Admin duyệt).
 * Trả về lý do từ chối (string) hoặc null nếu hợp lệ.
 */
export function validateStartingDateInput(startingDate: string, todayVn: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startingDate)) return "Ngày nhận việc không đúng định dạng YYYY-MM-DD.";
  if (startingDate < todayVn) {
    return "Không được tự đặt ngày nhận việc trong quá khứ. Dùng chức năng “Yêu cầu điều chỉnh ngày nhận việc” để Admin duyệt.";
  }
  return null;
}

/** Các hành động Recruiter được phép khi ứng viên ĐANG có Employment Session ACTIVE ở nơi khác. */
export type ActiveEmploymentAction =
  | "REJECT_ASSIGNMENT" // A. Từ chối xếp việc
  | "REQUEST_RESIGNATION_CONFIRMATION" // B. Tạo task xác nhận nghỉ
  | "CONFIRM_RESIGNATION_AND_ASSIGN" // C. Xác nhận nghỉ & xếp việc mới (cần quyền riêng)
  | "VIEW_HISTORY";

/**
 * RULE #8 — KHÔNG cho xếp việc âm thầm. Quyết định hành động hợp lệ dựa trên
 * trạng thái employment + quyền của người thao tác.
 */
export function resolveAssignmentActions(input: {
  hasOtherActiveSession: boolean;
  canConfirmResignation: boolean;
}): ActiveEmploymentAction[] {
  if (!input.hasOtherActiveSession) return []; // xếp việc bình thường, không cần action đặc biệt
  const actions: ActiveEmploymentAction[] = ["REJECT_ASSIGNMENT", "REQUEST_RESIGNATION_CONFIRMATION", "VIEW_HISTORY"];
  if (input.canConfirmResignation) actions.push("CONFIRM_RESIGNATION_AND_ASSIGN");
  return actions;
}

/**
 * Guard server-side khi chuyển 1 application/session sang APPROVED (xếp việc).
 * Trả về mã lỗi để route dịch thành HTTP response — logic thuần để test được.
 */
export type AssignmentGuardResult =
  | { ok: true }
  | { ok: false; code: "ACTIVE_EMPLOYMENT_EXISTS"; message: string }
  | { ok: false; code: "CONFIRMATION_REQUIRES_PERMISSION"; message: string }
  | { ok: false; code: "CONFIRMATION_REQUIRES_DATE"; message: string };

export function guardAssignment(input: {
  /** Worker có session ACTIVE KHÁC (không phải session đang xếp) hay không. */
  hasOtherActiveSession: boolean;
  activeDeptName?: string | null;
  /** Người thao tác gửi kèm xác nhận nghỉ (Option C)? */
  confirmPreviousResignation: boolean;
  actualResignationDate?: string | null;
  canConfirmResignation: boolean;
}): AssignmentGuardResult {
  if (!input.hasOtherActiveSession) return { ok: true };
  if (!input.confirmPreviousResignation) {
    return {
      ok: false,
      code: "ACTIVE_EMPLOYMENT_EXISTS",
      message: `Người lao động hiện đang được ghi nhận ĐANG LÀM VIỆC tại: ${input.activeDeptName ?? "bộ phận khác"}. Không thể xếp việc mới khi chưa xác nhận nghỉ tại bộ phận cũ.`,
    };
  }
  if (!input.canConfirmResignation) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRES_PERMISSION",
      message: "Bạn không có quyền “Xác nhận nghỉ & xếp việc mới” (employment.resignation.confirm). Hãy dùng “Yêu cầu xác nhận nghỉ”.",
    };
  }
  if (!input.actualResignationDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.actualResignationDate)) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRES_DATE",
      message: "Cần nhập Ngày nghỉ thực tế (Actual Resignation Date) khi xác nhận nghỉ bộ phận cũ.",
    };
  }
  return { ok: true };
}

/**
 * RULE #6 — SELF-DECLARATION không bao giờ tự động đóng session/tạo resignation/xoá allocation.
 * Hàm này CHỈ chuẩn hoá dữ liệu khai báo để lưu vào daily_applications; mọi field trả về là
 * thông tin chờ Recruiter xác minh.
 */
export function normalizeSelfDeclaration(input: {
  hasActiveSession: boolean;
  declared: boolean;
  declaredResignationDate?: string | null;
  declaredNote?: string | null;
  activeDeptId?: string | null;
  activeSessionId?: string | null;
  now: Date;
}): {
  workerDeclaredPreviousResignation: boolean;
  declaredPreviousDeptId: string | null;
  declaredPreviousSessionId: string | null;
  declaredResignationDate: string | null;
  declaredResignationNote: string | null;
  declaredAt: Date | null;
} {
  // Không có session ACTIVE → không có gì để khai; bỏ qua flag client gửi bừa.
  if (!input.hasActiveSession || !input.declared) {
    return {
      workerDeclaredPreviousResignation: false,
      declaredPreviousDeptId: null,
      declaredPreviousSessionId: null,
      declaredResignationDate: null,
      declaredResignationNote: null,
      declaredAt: null,
    };
  }
  const date = input.declaredResignationDate && /^\d{4}-\d{2}-\d{2}$/.test(input.declaredResignationDate)
    ? input.declaredResignationDate
    : null;
  return {
    workerDeclaredPreviousResignation: true,
    declaredPreviousDeptId: input.activeDeptId ?? null,
    declaredPreviousSessionId: input.activeSessionId ?? null,
    declaredResignationDate: date,
    declaredResignationNote: (input.declaredNote ?? "").trim() || null,
    declaredAt: input.now,
  };
}

/** Badge trạng thái lao động cho danh sách Xếp việc (UX #23). */
export type EmploymentBadge = "MOI" | "DANG_LAM" | "DA_TUNG_LAM" | "CHO_XAC_NHAN_NGHI" | "CAN_DOI_SOAT";

export function classifyEmploymentBadge(input: {
  hasActiveSession: boolean;
  pastEndedSessions: number;
  hasPendingResignationConfirmation: boolean;
  hasDuplicateActive: boolean;
}): EmploymentBadge {
  if (input.hasDuplicateActive) return "CAN_DOI_SOAT";
  if (input.hasPendingResignationConfirmation) return "CHO_XAC_NHAN_NGHI";
  if (input.hasActiveSession) return "DANG_LAM";
  if (input.pastEndedSessions > 0) return "DA_TUNG_LAM";
  return "MOI";
}

export const EMPLOYMENT_BADGE_META: Record<EmploymentBadge, { label: string; tone: "gray" | "green" | "amber" | "red" | "blue" | "purple" }> = {
  MOI: { label: "MỚI", tone: "gray" },
  DANG_LAM: { label: "ĐANG LÀM", tone: "green" },
  DA_TUNG_LAM: { label: "ĐÃ TỪNG LÀM", tone: "blue" },
  CHO_XAC_NHAN_NGHI: { label: "CHỜ XÁC NHẬN NGHỈ", tone: "amber" },
  CAN_DOI_SOAT: { label: "CẦN ĐỐI SOÁT", tone: "red" },
};

/**
 * START DATE CORRECTION — máy trạng thái thuần (#11-12).
 * PENDING_ADMIN_APPROVAL → APPROVED | REJECTED. Không có đường khác.
 */
export type CorrectionDecision = "APPROVE" | "REJECT";

export function decideCorrection(input: {
  status: string;
  decision: CorrectionDecision;
  requestedBy: string;
  decidedBy: string;
}): { ok: true; nextStatus: "APPROVED" | "REJECTED" } | { ok: false; message: string } {
  if (input.status !== "PENDING_ADMIN_APPROVAL") {
    return { ok: false, message: `Yêu cầu đã được xử lý trước đó (trạng thái hiện tại: ${input.status}).` };
  }
  // Không tự duyệt yêu cầu của chính mình — kể cả Admin tạo hộ.
  if (input.requestedBy === input.decidedBy) {
    return { ok: false, message: "Không thể tự duyệt yêu cầu điều chỉnh do chính mình tạo." };
  }
  return { ok: true, nextStatus: input.decision === "APPROVE" ? "APPROVED" : "REJECTED" };
}

/** Số ngày giữa 2 ngày YYYY-MM-DD (hiển thị Duration ở Lịch sử làm việc). */
export function durationDays(startDate: string | null, endDate: string | null, todayVn: string): number | null {
  if (!startDate) return null;
  const end = endDate ?? todayVn;
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 86400000));
}
