import { NextResponse } from "next/server";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, employmentSessions, workerProfiles } from "@/db/schema";
import { getUserScope, hasPermission, requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { getWorkflowStages } from "@/lib/workflow";
import { autoAllocateInternship } from "@/lib/planning";
import { normalizePersonName } from "@/lib/person-name";
import { todayStr } from "@/lib/helpers";
import { CCCD_ERROR_MESSAGE, isValidCccd, normalizeCccd } from "@/lib/validators";
import { assertNoOtherActiveSession, confirmResignationAndAssign, EmploymentRuleError } from "@/lib/employment";
import { validateStartingDateInput } from "@/lib/employment-lifecycle";
import { resolveDisplayName } from "@/lib/display-name";
import { resolveAssignmentActor } from "@/lib/assignment-actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EDITABLE = [
  "cccd",
  "fullName",
  "gender",
  "dob",
  "phone",
  "ethnicity",
  "permanentAddress",
  "residentialAddress",
  "deptId",
  "status",
  "startingDate",
  "appointmentList",
  "noteWorker",
  "vaccine",
  "workDuration",
  "referralChannel",
  "declaredType",
] as const;
// WORKFLOW TIẾP NHẬN — TÁCH VAI TRÒ (mục VIII): IT CODE KHÔNG còn nhập được qua
// PATCH này (Recruiter). Nguồn thao tác chính chuyển sang FINGERPRINT_STAFF tại
// "IT Code / Vân tay" (POST /api/fingerprint/it-code), source of truth dw_data.it_code.

// P1-4 (Production Hardening Audit) — field định danh cần đồng bộ sang worker_profiles (nguồn
// "hồ sơ điện tử duy nhất/người" — xem schema.ts) khi HR sửa trên daily_applications. `ethnicity`
// không có ở worker_profiles nên không đồng bộ.
const IDENTITY_SYNC_FIELDS = ["cccd", "fullName", "gender", "dob", "phone", "permanentAddress", "residentialAddress"] as const;

/** CCCD mới trùng 1 worker_profiles KHÁC đang hoạt động — cần thao tác gộp hồ sơ thủ công, không tự merge. */
class CccdConflictError extends Error {}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "registrations.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason : null;

    const [existing] = await db.select().from(dailyApplications).where(eq(dailyApplications.id, id));
    if (!existing) return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });
    const scope = await getUserScope(guard.session);
    if (!scopeAllowsDepartment(scope, existing.deptId)) {
      return NextResponse.json({ error: "Không tìm thấy hồ sơ trong phạm vi dữ liệu được cấp." }, { status: 404 });
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of EDITABLE) {
      if (key in body) {
        const v = body[key];
        patch[key] = v === "" || v === "ALL" ? null : v;
      }
    }
    // Chuẩn hoá họ tên trước khi lưu (mọi điểm ghi mới đều lưu giá trị chuẩn hoá).
    if (typeof patch.fullName === "string") patch.fullName = normalizePersonName(patch.fullName);
    if (Object.keys(patch).length === 1) {
      return NextResponse.json({ error: "Không có dữ liệu cập nhật." }, { status: 400 });
    }
    if ("deptId" in patch && !scopeAllowsDepartment(scope, patch.deptId as string | null)) {
      return NextResponse.json({ error: "Bộ phận đích nằm ngoài Data Scope được cấp." }, { status: 403 });
    }
    // Production Recovery audit — TRƯỚC ĐÂY không kiểm tra bộ phận đích còn active hay không
    // (khác /api/workforce-movements đã check eq(departments.isActive, true) khi thuyên chuyển).
    // 1 user còn giữ user_department_scopes trỏ tới bộ phận đã deactivate (departments không bao
    // giờ bị hard-delete) vẫn có thể gán/duyệt lao động vào bộ phận đó — worker "sống" ở 1 bộ
    // phận không còn hoạt động, không ai để ý cho tới khi báo cáo lệch.
    if (typeof patch.deptId === "string") {
      const [targetDept] = await db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.id, patch.deptId), eq(departments.isActive, true), isNull(departments.deletedAt)));
      if (!targetDept) {
        return NextResponse.json({ error: "Bộ phận đích không tồn tại hoặc đã ngừng hoạt động." }, { status: 400 });
      }
    }
    if ("cccd" in patch) {
      if (!isValidCccd(patch.cccd)) {
        return NextResponse.json({ error: CCCD_ERROR_MESSAGE }, { status: 400 });
      }
      patch.cccd = normalizeCccd(patch.cccd);
    }

    // P1-3 (Production Hardening Audit) — TRƯỚC ĐÂY `status` là 1 trong các field EDITABLE tự
    // do, PATCH generic này chấp nhận BẤT KỲ chuỗi nào (kể cả không tồn tại trong Workflow
    // Engine) — bỏ qua hoàn toàn `workflow_stages`. Nay bắt buộc `status` mới phải là 1 stageKey
    // đang Active thật của Workflow Engine (đúng nguồn sự thật đã cấu hình ở /admin/workflow) —
    // không chặn các field khác (inline-edit thông thường không đổi).
    if (typeof patch.status === "string") {
      const stages = await getWorkflowStages("daily_application");
      const validKeys = new Set(stages.filter((s) => s.isActive).map((s) => s.stageKey));
      if (!validKeys.has(patch.status)) {
        return NextResponse.json({ error: `Trạng thái "${patch.status}" không hợp lệ hoặc đã ngừng dùng.` }, { status: 400 });
      }
    }

    // ============ EMPLOYMENT LIFECYCLE ============
    const today = todayStr();
    const isAssigning = patch.status === "APPROVED" && existing.status !== "APPROVED";

    // ASSIGNMENT ACTOR (freeze) — chỉ khi xếp việc THẬT (non-APPROVED → APPROVED). Các save
    // không liên quan (sửa note/CCCD/...) KHÔNG ghi đè 3 trường này.
    const assignmentActor = resolveAssignmentActor({
      previousStatus: existing.status,
      nextStatus: typeof patch.status === "string" ? patch.status : null,
      username: guard.session.username,
      fullName: guard.session.fullName,
    });

    // RULE #11 — KHÔNG backdate tuỳ ý: sửa startingDate về quá khứ phải qua
    // START_DATE_CORRECTION_REQUEST (POST /api/employment/start-date-corrections) để Admin duyệt.
    if (typeof patch.startingDate === "string" && patch.startingDate !== existing.startingDate) {
      const dateError = validateStartingDateInput(patch.startingDate, today);
      if (dateError) return NextResponse.json({ error: dateError, code: "BACKDATE_FORBIDDEN" }, { status: 400 });
    }

    // RULE #10 — DEFAULT START DATE = ngày Recruiter thao tác (Asia/Ho_Chi_Minh),
    // KHÔNG phải ngày đăng ký (application_date ≠ employment_start_date).
    if (isAssigning && !("startingDate" in patch) && !existing.startingDate) {
      patch.startingDate = today;
    }

    // RULE #8-C — "Xác nhận nghỉ & xếp việc mới": client gửi kèm confirmPreviousResignation +
    // actualResignationDate. Chỉ role có employment.resignation.confirm được đi đường này —
    // toàn bộ (đóng session A + movement + mở session B) chạy 1 transaction trong lib/employment.ts.
    const confirmPreviousResignation = body.confirmPreviousResignation === true;
    const actualResignationDate = typeof body.actualResignationDate === "string" ? body.actualResignationDate : null;

    if (isAssigning) {
      const [linkedForGuard] = await db
        .select({ id: employmentSessions.id, workerId: employmentSessions.workerId })
        .from(employmentSessions)
        .where(eq(employmentSessions.dailyApplicationId, id));
      if (linkedForGuard) {
        if (confirmPreviousResignation) {
          const canConfirm = await hasPermission(guard.session.role, "employment.resignation.confirm");
          if (!canConfirm) {
            return NextResponse.json(
              { error: "Bạn không có quyền “Xác nhận nghỉ & xếp việc mới”. Hãy dùng “Yêu cầu xác nhận nghỉ”.", code: "CONFIRMATION_REQUIRES_PERMISSION" },
              { status: 403 },
            );
          }
          if (!actualResignationDate) {
            return NextResponse.json(
              { error: "Cần nhập Ngày nghỉ thực tế (Actual Resignation Date).", code: "CONFIRMATION_REQUIRES_DATE" },
              { status: 400 },
            );
          }
          const newDeptId = (patch.deptId as string | null) ?? existing.deptId;
          if (!newDeptId) {
            return NextResponse.json({ error: "Cần chọn Bộ phận mới trước khi xác nhận nghỉ & xếp việc." }, { status: 400 });
          }
          try {
            const result = await confirmResignationAndAssign({
              workerId: linkedForGuard.workerId,
              newSessionId: linkedForGuard.id,
              newDeptId,
              actualResignationDate,
              startingDate: (patch.startingDate as string | null) ?? today,
              reason: reason ?? "Xác nhận nghỉ bộ phận cũ khi xếp việc mới",
              confirmedBy: guard.session.username,
              assignedByDisplayName: resolveDisplayName({ fullName: guard.session.fullName, username: guard.session.username }),
            });
            await writeAudit(guard.session, "CONFIRM_RESIGNATION_AND_ASSIGN", "employment_sessions", {
              dailyApplicationId: id,
              endedSessionId: result.endedSessionId,
              movementId: result.movementId,
              newSessionId: result.newSessionId,
              actualResignationDate,
              newDeptId,
              reason,
            });
            const [row] = await db.select().from(dailyApplications).where(eq(dailyApplications.id, id));
            return NextResponse.json({ success: true, row, employment: result });
          } catch (e) {
            if (e instanceof EmploymentRuleError) {
              return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
            }
            throw e;
          }
        }
        // RULE #3/#8 — server-side reject: không xếp việc âm thầm khi còn ACTIVE session khác.
        try {
          await assertNoOtherActiveSession(db, linkedForGuard.workerId, linkedForGuard.id);
        } catch (e) {
          if (e instanceof EmploymentRuleError) {
            return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
          }
          throw e;
        }
      }
    }

    // P1-4 (Production Hardening Audit) — TRƯỚC ĐÂY chỉ status/deptId/startingDate được đồng bộ
    // sang employment_sessions; sửa CCCD/họ tên/SĐT/DOB/địa chỉ trên daily_applications KHÔNG hề
    // cập nhật worker_profiles liên kết — hồ sơ điện tử "duy nhất/người" (nguồn sự thật danh
    // tính, xem schema.ts) im lặng lệch dữ liệu so với daily_applications. Nay đồng bộ trong
    // CÙNG 1 transaction với update chính: nếu đổi CCCD trùng 1 worker_profiles KHÁC đang hoạt
    // động → từ chối rõ ràng (không tự gộp âm thầm, chưa có flow merge riêng); nếu không xung
    // đột → UPDATE đúng worker_profiles đã liên kết (không insert mới — không tạo hồ sơ trùng),
    // employment_sessions vẫn liên kết đúng workerId như cũ.
    const updated = await db.transaction(async (tx) => {
      const [linkedSession] = await tx
        .select({ id: employmentSessions.id, workerId: employmentSessions.workerId })
        .from(employmentSessions)
        .where(eq(employmentSessions.dailyApplicationId, id));

      if (linkedSession && typeof patch.cccd === "string" && patch.cccd !== existing.cccd) {
        const [conflict] = await tx
          .select({ id: workerProfiles.id })
          .from(workerProfiles)
          .where(and(eq(workerProfiles.cccd, patch.cccd), isNull(workerProfiles.deletedAt), ne(workerProfiles.id, linkedSession.workerId)));
        if (conflict) {
          throw new CccdConflictError(
            `CCCD "${patch.cccd}" đã thuộc về 1 hồ sơ lao động khác trong hệ thống — không thể tự động gộp. Liên hệ Admin để xử lý gộp hồ sơ thủ công.`,
          );
        }
      }

      const dailyPatch: Record<string, unknown> = { ...patch };
      // ASSIGNMENT ACTOR freeze — chỉ khi xếp việc THẬT (non-APPROVED → APPROVED).
      if (assignmentActor) Object.assign(dailyPatch, assignmentActor);
      const [updatedRow] = await tx.update(dailyApplications).set(dailyPatch).where(eq(dailyApplications.id, id)).returning();
      if (!updatedRow) throw new Error("Không tìm thấy hồ sơ.");

      // DIGITAL WORKER FILE (#10) — đồng bộ trạng thái/bộ phận/ngày bắt đầu sang employment_sessions
      // tương ứng, để hồ sơ điện tử của người lao động luôn phản ánh đúng đợt làm việc hiện tại.
      // Tự động phân bổ vào Kế hoạch Tập nghề (Planning) khi APPROVED có deptId — tính TRƯỚC
      // sessionPatch để dùng chung finalDeptId cho invariant check bên dưới.
      const finalStatus = (patch.status as string) ?? existing.status;
      const finalDeptId = (patch.deptId as string) ?? existing.deptId;
      const finalStartingDate = (patch.startingDate as string) ?? existing.startingDate;

      const sessionPatch: Record<string, unknown> = {};
      if ("status" in patch) sessionPatch.status = patch.status;
      if ("deptId" in patch) sessionPatch.deptId = patch.deptId;
      if ("startingDate" in patch) sessionPatch.startingDate = patch.startingDate;
      if (assignmentActor) {
        sessionPatch.assignedBy = assignmentActor.assignedBy;
        sessionPatch.assignedByDisplayName = assignmentActor.assignedByDisplayName;
        sessionPatch.assignedAt = assignmentActor.assignedAt;
      }
      if (linkedSession && Object.keys(sessionPatch).length > 0) {
        // EMPLOYMENT LIFECYCLE — kiểm tra invariant "1 ACTIVE/worker" LẦN NỮA bên trong
        // transaction (guard phía trên chạy ngoài transaction — 2 request đồng thời có thể
        // cùng vượt qua). Partial unique index là lưới chốt cuối.
        if (patch.status === "APPROVED") {
          await assertNoOtherActiveSession(tx, linkedSession.workerId, linkedSession.id);
          // Invariant "ACTIVE ⇒ có bộ phận thật" — không cho phép session thành APPROVED
          // (end_date IS NULL) mà dept_id vẫn NULL. Trước đây chỉ được auditEmploymentIntegrity()
          // phát hiện SAU KHI xảy ra (activeWithoutDept) — nay chặn ngay tại nguồn ghi.
          if (!finalDeptId) {
            throw new EmploymentRuleError(
              "Không thể duyệt (APPROVED) khi chưa có Bộ phận — chọn Bộ phận trước khi duyệt.",
              "APPROVED_WITHOUT_DEPT",
            );
          }
          sessionPatch.startDateSource = "ASSIGNMENT";
        }
        await tx.update(employmentSessions).set(sessionPatch).where(eq(employmentSessions.id, linkedSession.id));
      }

      if (linkedSession && finalStatus === "APPROVED" && finalDeptId) {
        await autoAllocateInternship(linkedSession.id, finalDeptId, finalStartingDate, guard.session.username, tx);
      }

      if (linkedSession) {
        const profilePatch: Record<string, unknown> = {};
        for (const f of IDENTITY_SYNC_FIELDS) {
          if (f in patch) profilePatch[f] = patch[f];
        }
        if (Object.keys(profilePatch).length > 0) {
          profilePatch.updatedAt = new Date();
          await tx.update(workerProfiles).set(profilePatch).where(eq(workerProfiles.id, linkedSession.workerId));
        }
      }

      return updatedRow;
    });

    // VERSIONING: lưu snapshot trước/sau (chỉ các trường có thay đổi) để xem lịch sử & khôi phục.
    const beforeSnapshot = Object.fromEntries(
      Object.keys(patch)
        .filter((k) => k !== "updatedAt")
        .map((k) => [k, (existing as Record<string, unknown>)[k]]),
    );
    await writeAudit(guard.session, "INLINE_EDIT", "daily_applications", {
      id,
      before: beforeSnapshot,
      after: patch,
      reason,
    });
    return NextResponse.json({ success: true, row: updated });
  } catch (error) {
    if (error instanceof CccdConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof EmploymentRuleError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    // Lưới cuối cấp DB: unique index "1 ACTIVE/worker" — dịch 23505 thành lỗi nghiệp vụ rõ ràng.
    if ((error as { code?: string; constraint?: string }).code === "23505" &&
        (error as { constraint?: string }).constraint === "employment_session_one_active_uq") {
      return NextResponse.json(
        { error: "Người lao động đã có một đợt làm việc ACTIVE khác (thao tác trùng lặp). Tải lại trang để xem trạng thái mới nhất.", code: "DUPLICATE_ACTIVE_EMPLOYMENT" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Lỗi hệ thống: " + (error as Error).message },
      { status: 500 },
    );
  }
}

/** Xoá mềm — hồ sơ ẩn khỏi Daily Application nhưng vẫn còn trong database, khôi phục tại /admin/recycle-bin. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "registrations.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { id } = await ctx.params;
  const [existing] = await db.select({ deptId: dailyApplications.deptId }).from(dailyApplications).where(eq(dailyApplications.id, id));
  if (!existing) return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });
  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, existing.deptId)) {
    return NextResponse.json({ error: "Không tìm thấy hồ sơ trong phạm vi dữ liệu được cấp." }, { status: 404 });
  }
  await db
    .update(dailyApplications)
    .set({ deletedAt: new Date(), deletedBy: guard.session.username })
    .where(and(eq(dailyApplications.id, id), isNull(dailyApplications.deletedAt)));
  await writeAudit(guard.session, "SOFT_DELETE_APPLICATION", "daily_applications", { id });
  return NextResponse.json({ success: true });
}
