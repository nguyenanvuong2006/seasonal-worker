import { NextResponse } from "next/server";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, dwData, employmentSessions, workerProfiles } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { getWorkflowStages } from "@/lib/workflow";
import { autoAllocateInternship } from "@/lib/planning";
import { normalizePersonName } from "@/lib/person-name";
import { CCCD_ERROR_MESSAGE, isValidCccd, normalizeCccd } from "@/lib/validators";

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
  "itCode",
] as const;

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

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of EDITABLE) {
      if (key in body) {
        const v = body[key];
        patch[key] = v === "" || v === "ALL" ? null : v;
      }
    }
    // Chuẩn hoá họ tên & IT CODE trước khi lưu (mọi điểm ghi mới đều lưu giá trị chuẩn hoá).
    if (typeof patch.fullName === "string") patch.fullName = normalizePersonName(patch.fullName);
    if (typeof patch.itCode === "string") patch.itCode = patch.itCode.trim() || null;
    if (Object.keys(patch).length === 1) {
      return NextResponse.json({ error: "Không có dữ liệu cập nhật." }, { status: 400 });
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

      const [updatedRow] = await tx.update(dailyApplications).set(patch).where(eq(dailyApplications.id, id)).returning();
      if (!updatedRow) throw new Error("Không tìm thấy hồ sơ.");

      // DIGITAL WORKER FILE (#10) — đồng bộ trạng thái/bộ phận/ngày bắt đầu sang employment_sessions
      // tương ứng, để hồ sơ điện tử của người lao động luôn phản ánh đúng đợt làm việc hiện tại.
      const sessionPatch: Record<string, unknown> = {};
      if ("status" in patch) sessionPatch.status = patch.status;
      if ("deptId" in patch) sessionPatch.deptId = patch.deptId;
      if ("startingDate" in patch) sessionPatch.startingDate = patch.startingDate;
      if (linkedSession && Object.keys(sessionPatch).length > 0) {
        await tx.update(employmentSessions).set(sessionPatch).where(eq(employmentSessions.id, linkedSession.id));
      }

      // Tự động phân bổ vào Kế hoạch Tập nghề (Planning) khi APPROVED có deptId
      const finalStatus = (patch.status as string) ?? existing.status;
      const finalDeptId = (patch.deptId as string) ?? existing.deptId;
      const finalStartingDate = (patch.startingDate as string) ?? existing.startingDate;

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

      // IT CODE / Mã vân tay (#18) — sửa IT CODE tại Daily Application đồng bộ 3 nơi:
      //   daily_applications.it_code (đã cập nhật ở trên),
      //   worker_profiles.fingerprint_code (theo workerId liên kết, fallback theo CCCD),
      //   dw_data.it_code (chỉ khi lao động ĐÃ có hồ sơ DW — theo dwId hoặc khớp CCCD).
      if ("itCode" in patch) {
        const itCode = (patch.itCode as string | null) ?? null;
        if (linkedSession) {
          await tx
            .update(workerProfiles)
            .set({ fingerprintCode: itCode, fingerprintStatus: itCode ? "DA_CAP" : "CHUA_CAP", updatedAt: new Date() })
            .where(eq(workerProfiles.id, linkedSession.workerId));
        } else {
          await tx
            .update(workerProfiles)
            .set({ fingerprintCode: itCode, fingerprintStatus: itCode ? "DA_CAP" : "CHUA_CAP", updatedAt: new Date() })
            .where(and(eq(workerProfiles.cccd, existing.cccd), isNull(workerProfiles.deletedAt)));
        }
        if (existing.dwId) {
          await tx.update(dwData).set({ itCode }).where(eq(dwData.id, existing.dwId));
        } else {
          await tx
            .update(dwData)
            .set({ itCode })
            .where(and(eq(dwData.cccd, existing.cccd), isNull(dwData.deletedAt)));
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
  await db
    .update(dailyApplications)
    .set({ deletedAt: new Date(), deletedBy: guard.session.username })
    .where(and(eq(dailyApplications.id, id), isNull(dailyApplications.deletedAt)));
  await writeAudit(guard.session, "SOFT_DELETE_APPLICATION", "daily_applications", { id });
  return NextResponse.json({ success: true });
}
