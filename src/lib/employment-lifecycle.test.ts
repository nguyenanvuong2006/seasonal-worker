import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyEmploymentBadge,
  decideCorrection,
  defaultStartDate,
  durationDays,
  EMPLOYMENT_BADGE_META,
  guardAssignment,
  isSessionActive,
  normalizeSelfDeclaration,
  resolveAssignmentActions,
  validateStartingDateInput,
} from "./employment-lifecycle.ts";

/* ============================================================
   ĐỊNH NGHĨA ACTIVE
   ============================================================ */

test("ACTIVE := APPROVED + end_date IS NULL — mọi trường hợp khác không phải ACTIVE", () => {
  assert.equal(isSessionActive({ status: "APPROVED", endDate: null }), true);
  assert.equal(isSessionActive({ status: "APPROVED", endDate: "2026-07-20" }), false);
  assert.equal(isSessionActive({ status: "PENDING", endDate: null }), false);
  assert.equal(isSessionActive({ status: "ENDED", endDate: "2026-07-20" }), false);
  assert.equal(isSessionActive({ status: "WAITLIST", endDate: null }), false);
  assert.equal(isSessionActive(null), false);
  assert.equal(isSessionActive(undefined), false);
});

/* ============================================================
   TEST #2 (bắt buộc) — DEFAULT START DATE
   Application đăng ký 10/08, Recruiter xếp 16/08 → Start Date = 16/08.
   ============================================================ */

test("default start date = ngày Recruiter thao tác, KHÔNG phải ngày đăng ký", () => {
  const applicationDate = "2026-08-10";
  const recruiterActionDate = "2026-08-16";
  const startDate = defaultStartDate(recruiterActionDate);
  assert.equal(startDate, "2026-08-16");
  assert.notEqual(startDate, applicationDate);
});

/* ============================================================
   TEST #10 (bắt buộc) — KHÔNG backdate trực tiếp
   ============================================================ */

test("startingDate hôm nay/tương lai hợp lệ; quá khứ bị từ chối với hướng dẫn tạo correction request", () => {
  assert.equal(validateStartingDateInput("2026-08-16", "2026-08-16"), null);
  assert.equal(validateStartingDateInput("2026-08-17", "2026-08-16"), null);
  const err = validateStartingDateInput("2026-08-10", "2026-08-16");
  assert.ok(err && err.includes("Yêu cầu điều chỉnh ngày nhận việc"));
  assert.ok(validateStartingDateInput("16/08/2026", "2026-08-16"));
});

/* ============================================================
   TEST #5 (bắt buộc) — server reject khi assign lúc còn ACTIVE
   ============================================================ */

test("guardAssignment: không có ACTIVE khác → cho phép bình thường", () => {
  const r = guardAssignment({
    hasOtherActiveSession: false,
    confirmPreviousResignation: false,
    canConfirmResignation: false,
  });
  assert.deepEqual(r, { ok: true });
});

test("guardAssignment: còn ACTIVE + không xác nhận nghỉ → reject ACTIVE_EMPLOYMENT_EXISTS", () => {
  const r = guardAssignment({
    hasOtherActiveSession: true,
    activeDeptName: "Packing",
    confirmPreviousResignation: false,
    canConfirmResignation: true,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "ACTIVE_EMPLOYMENT_EXISTS");
    assert.ok(r.message.includes("Packing"));
  }
});

test("guardAssignment: xác nhận nghỉ nhưng KHÔNG có quyền → reject CONFIRMATION_REQUIRES_PERMISSION", () => {
  const r = guardAssignment({
    hasOtherActiveSession: true,
    confirmPreviousResignation: true,
    canConfirmResignation: false,
    actualResignationDate: "2026-08-15",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "CONFIRMATION_REQUIRES_PERMISSION");
});

test("guardAssignment: xác nhận nghỉ thiếu Actual Resignation Date → reject CONFIRMATION_REQUIRES_DATE", () => {
  const r = guardAssignment({
    hasOtherActiveSession: true,
    confirmPreviousResignation: true,
    canConfirmResignation: true,
    actualResignationDate: null,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "CONFIRMATION_REQUIRES_DATE");
});

test("guardAssignment: đủ quyền + đủ ngày → cho phép (transaction phía server tự đóng A mở B)", () => {
  const r = guardAssignment({
    hasOtherActiveSession: true,
    confirmPreviousResignation: true,
    canConfirmResignation: true,
    actualResignationDate: "2026-08-15",
  });
  assert.deepEqual(r, { ok: true });
});

/* ============================================================
   TEST #3-4 (bắt buộc) — self-declaration: warning + KHÔNG side-effect
   ============================================================ */

test("self-declaration: worker tick 'đã báo nghỉ' → chỉ lưu lời khai, không có side-effect nào khác", () => {
  const now = new Date("2026-08-16T08:00:00Z");
  const out = normalizeSelfDeclaration({
    hasActiveSession: true,
    declared: true,
    declaredResignationDate: "2026-08-12",
    declaredNote: "Đã báo tổ trưởng",
    activeDeptId: "dept-a",
    activeSessionId: "session-a",
    now,
  });
  assert.equal(out.workerDeclaredPreviousResignation, true);
  assert.equal(out.declaredPreviousDeptId, "dept-a");
  assert.equal(out.declaredPreviousSessionId, "session-a");
  assert.equal(out.declaredResignationDate, "2026-08-12");
  assert.equal(out.declaredResignationNote, "Đã báo tổ trưởng");
  assert.equal(out.declaredAt, now);
  // Object trả về CHỈ chứa các field khai báo — không có field đóng session/tạo movement.
  assert.deepEqual(Object.keys(out).sort(), [
    "declaredAt",
    "declaredPreviousDeptId",
    "declaredPreviousSessionId",
    "declaredResignationDate",
    "declaredResignationNote",
    "workerDeclaredPreviousResignation",
  ]);
});

test("self-declaration: client gửi flag bừa khi KHÔNG có ACTIVE session → bị bỏ qua", () => {
  const out = normalizeSelfDeclaration({
    hasActiveSession: false,
    declared: true,
    declaredResignationDate: "2026-08-12",
    now: new Date(),
  });
  assert.equal(out.workerDeclaredPreviousResignation, false);
  assert.equal(out.declaredAt, null);
});

test("self-declaration: ngày sai định dạng → lưu null (không crash, không tin dữ liệu client)", () => {
  const out = normalizeSelfDeclaration({
    hasActiveSession: true,
    declared: true,
    declaredResignationDate: "12/08/2026",
    now: new Date(),
  });
  assert.equal(out.workerDeclaredPreviousResignation, true);
  assert.equal(out.declaredResignationDate, null);
});

/* ============================================================
   #8 — hành động hợp lệ khi còn ACTIVE (không xếp âm thầm)
   ============================================================ */

test("resolveAssignmentActions: bình thường → không cần action đặc biệt", () => {
  assert.deepEqual(resolveAssignmentActions({ hasOtherActiveSession: false, canConfirmResignation: true }), []);
});

test("resolveAssignmentActions: còn ACTIVE, không quyền confirm → A/B/History, KHÔNG có C", () => {
  const actions = resolveAssignmentActions({ hasOtherActiveSession: true, canConfirmResignation: false });
  assert.deepEqual(actions, ["REJECT_ASSIGNMENT", "REQUEST_RESIGNATION_CONFIRMATION", "VIEW_HISTORY"]);
});

test("resolveAssignmentActions: có quyền confirm → thêm CONFIRM_RESIGNATION_AND_ASSIGN", () => {
  const actions = resolveAssignmentActions({ hasOtherActiveSession: true, canConfirmResignation: true });
  assert.ok(actions.includes("CONFIRM_RESIGNATION_AND_ASSIGN"));
});

/* ============================================================
   TEST #11-12 (bắt buộc) — Admin duyệt/reject correction
   ============================================================ */

test("correction: PENDING → APPROVE hợp lệ", () => {
  const r = decideCorrection({ status: "PENDING_ADMIN_APPROVAL", decision: "APPROVE", requestedBy: "recruiter1", decidedBy: "admin1" });
  assert.deepEqual(r, { ok: true, nextStatus: "APPROVED" });
});

test("correction: PENDING → REJECT giữ nguyên start date gốc (nextStatus=REJECTED)", () => {
  const r = decideCorrection({ status: "PENDING_ADMIN_APPROVAL", decision: "REJECT", requestedBy: "recruiter1", decidedBy: "admin1" });
  assert.deepEqual(r, { ok: true, nextStatus: "REJECTED" });
});

test("correction: đã xử lý rồi → không xử lý lại (idempotent với retry)", () => {
  const r = decideCorrection({ status: "APPROVED", decision: "APPROVE", requestedBy: "recruiter1", decidedBy: "admin1" });
  assert.equal(r.ok, false);
});

test("correction: không được tự duyệt yêu cầu của chính mình", () => {
  const r = decideCorrection({ status: "PENDING_ADMIN_APPROVAL", decision: "APPROVE", requestedBy: "admin1", decidedBy: "admin1" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.message.includes("tự duyệt"));
});

/* ============================================================
   #23 — badge phân loại danh sách Xếp việc
   ============================================================ */

test("badge: đủ 5 trạng thái, ưu tiên CẦN ĐỐI SOÁT > CHỜ XÁC NHẬN NGHỈ > ĐANG LÀM > ĐÃ TỪNG LÀM > MỚI", () => {
  assert.equal(classifyEmploymentBadge({ hasActiveSession: false, pastEndedSessions: 0, hasPendingResignationConfirmation: false, hasDuplicateActive: false }), "MOI");
  assert.equal(classifyEmploymentBadge({ hasActiveSession: true, pastEndedSessions: 0, hasPendingResignationConfirmation: false, hasDuplicateActive: false }), "DANG_LAM");
  assert.equal(classifyEmploymentBadge({ hasActiveSession: false, pastEndedSessions: 2, hasPendingResignationConfirmation: false, hasDuplicateActive: false }), "DA_TUNG_LAM");
  assert.equal(classifyEmploymentBadge({ hasActiveSession: true, pastEndedSessions: 1, hasPendingResignationConfirmation: true, hasDuplicateActive: false }), "CHO_XAC_NHAN_NGHI");
  assert.equal(classifyEmploymentBadge({ hasActiveSession: true, pastEndedSessions: 0, hasPendingResignationConfirmation: true, hasDuplicateActive: true }), "CAN_DOI_SOAT");
  for (const key of ["MOI", "DANG_LAM", "DA_TUNG_LAM", "CHO_XAC_NHAN_NGHI", "CAN_DOI_SOAT"] as const) {
    assert.ok(EMPLOYMENT_BADGE_META[key].label.length > 0);
  }
});

/* ============================================================
   TEST #9 (bắt buộc) + #15 — PHÂN BIỆT 3 TRẠNG THÁI
   Employment chỉ phụ thuộc (status, end_date) của employment_sessions —
   KHÔNG phụ thuộc planning/allocation. Planning hết hạn hay allocation bị
   chuyển đều không đổi kết quả isSessionActive.
   ============================================================ */

test("planning expired / allocation moved KHÔNG kết thúc employment (ACTIVE chỉ phụ thuộc session)", () => {
  const session = { status: "APPROVED", endDate: null };
  // Mô phỏng: planning period đã EXPIRED, allocation bị chuyển sang period khác —
  // không có trường nào của session thay đổi ⇒ vẫn ACTIVE.
  const planningExpired = true;
  const allocationMoved = true;
  void planningExpired;
  void allocationMoved;
  assert.equal(isSessionActive(session), true);
  // Chỉ Resignation ĐÃ XÁC NHẬN (ghi end_date + status ENDED) mới kết thúc employment.
  assert.equal(isSessionActive({ status: "ENDED", endDate: "2026-08-15" }), false);
});

/* ============================================================
   #13 — duration hiển thị lịch sử
   ============================================================ */

test("durationDays: session đã kết thúc + đang làm (tính tới hôm nay) + dữ liệu thiếu", () => {
  assert.equal(durationDays("2026-06-01", "2026-07-20", "2026-08-16"), 49);
  assert.equal(durationDays("2026-08-05", null, "2026-08-16"), 11);
  assert.equal(durationDays(null, null, "2026-08-16"), null);
});
