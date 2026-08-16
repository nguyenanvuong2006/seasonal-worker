import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions, recruitmentRequests, requestAllocations, workerProfiles } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { getRecruitmentRequest, batchUpdateStatus, softDeleteRecruitmentRequests } from "@/lib/recruitment-request";
import { listOpenAllocationsForRequest } from "@/lib/planning-reallocation";
import {
  REQUEST_STATUSES,
  computeBalance,
  computeDateDeltas,
  computeRecruitedVsExpected,
  computeTotalRequest,
  stripSystemOwnedFields,
} from "@/lib/planning-recruitment-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/recruitment-requests/:id
 * Trả yêu cầu kèm CHUỖI LỊCH SỬ (Yêu cầu #4): yêu cầu này nối tiếp/thay thế
 * cái nào, và những yêu cầu nào nối tiếp/thay thế nó. Chỉ đọc, không sửa gì.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // DEPT_MANAGER được phép XEM trong Data Scope (Yêu cầu #3).
  const guard = await requirePermission(["ADMIN", "HR_DIRECTOR", "HR_RECRUITER", "DEPT_MANAGER"], "planning.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const row = await getRecruitmentRequest(id);
  if (!row) return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });

  // Data Scope server-side (Yêu cầu #15) — ngoài phạm vi trả 404, không phải 403,
  // để không tiết lộ sự tồn tại của bản ghi.
  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, row.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy yêu cầu trong Data Scope được cấp." }, { status: 404 });
  }

  const lineageSelect = {
    id: recruitmentRequests.id,
    requestCode: recruitmentRequests.requestCode,
    status: recruitmentRequests.status,
    expectedDate: recruitmentRequests.expectedDate,
    endDate: recruitmentRequests.endDate,
    totalRequest: recruitmentRequests.totalRequest,
    createdAt: recruitmentRequests.createdAt,
  };

  const ancestorIds = [row.previousRequestId, row.supersedesRequestId].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );

  const [ancestors, successors] = await Promise.all([
    ancestorIds.length > 0
      ? db.select(lineageSelect).from(recruitmentRequests).where(inArray(recruitmentRequests.id, ancestorIds))
      : Promise.resolve([]),
    db
      .select(lineageSelect)
      .from(recruitmentRequests)
      .where(
        and(
          or(
            eq(recruitmentRequests.previousRequestId, id),
            eq(recruitmentRequests.supersedesRequestId, id),
          ),
          isNull(recruitmentRequests.deletedAt),
        ),
      )
      .orderBy(recruitmentRequests.createdAt),
  ]);

  // Phân bổ đang mở của yêu cầu này — cần cho panel chuyển phân bổ.
  const allocations = await listOpenAllocationsForRequest(id);

  return NextResponse.json({
    row,
    lineage: {
      previousRequestId: row.previousRequestId,
      supersedesRequestId: row.supersedesRequestId,
      ancestors,
      successors,
    },
    openAllocations: allocations,
    canEdit: guard.session.role === "ADMIN" || guard.session.role === "HR_RECRUITER",
  });
}

/**
 * PATCH /api/recruitment-requests/:id
 * action: "update" (sửa chi tiết) | "status" (đổi trạng thái)
 * DELETE: xoá mềm draft
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const existing = await getRecruitmentRequest(id);
  if (!existing) return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });

  // DATA SCOPE (Yêu cầu #15) — so khớp theo KHOÁ NGOẠI department_id.
  // Trước đây so `existing.department` (chuỗi tên phòng ban tự do) với scope
  // (mảng UUID) nên điều kiện luôn sai; thêm nữa `!existing.department` khiến
  // yêu cầu KHÔNG có phòng ban lọt qua mọi scope. Nay dùng đúng FK.
  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, existing.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy yêu cầu trong Data Scope được cấp." }, { status: 404 });
  }

  const body = (await req.json()) as { action?: string; status?: string; fields?: Record<string, unknown> };

  if (body.action === "status" && body.status) {
    const status = body.status.toUpperCase();
    if (!(REQUEST_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: `Status phải là một trong: ${REQUEST_STATUSES.join(", ")}` }, { status: 400 });
    }
    await batchUpdateStatus([id], status, guard.session.username);
    await writeAudit(guard.session, "UPDATE_RECRUITMENT_REQUEST_STATUS", "recruitment_requests", {
      id,
      requestCode: existing.requestCode,
      from: existing.status,
      to: status,
    });
    return NextResponse.json({ success: true, status });
  }

  if (body.action === "update" && body.fields) {
    // Yêu cầu #10 — KPI do hệ thống sở hữu (Application/Interviewed/Recruited/
    // Quit/Balance/Total Request/…) không nhận giá trị do người dùng gửi lên.
    // Loại bỏ TRƯỚC khi map, và báo lại danh sách bị từ chối để UI hiển thị.
    const { safe: fields, rejected } = stripSystemOwnedFields(body.fields);

    const patch: Record<string, unknown> = {};
    const stringKeys = ["requester", "position", "jobTitle", "location", "section", "groupName", "division", "department", "reason", "noteForReason", "specialRequirements", "month", "remarks", "to", "rqStatus", "monthRc", "departmentText", "monthReport"] as const;
    // CHỈ còn các số do người dùng thực sự nhập; mọi KPI phái sinh đã bị strip ở trên.
    const numberKeys = ["maleRq", "femaleRq", "cost"] as const;
    // Yêu cầu #6 — sáu loại ngày tách bạch, không dùng chung một trường.
    const dateKeys = ["requestedDate", "expectedDate", "startingDate", "endDate", "offeredDate", "completedDate"] as const;

    for (const k of stringKeys) {
      if (fields[k] !== undefined) patch[k] = fields[k] ? String(fields[k]) : null;
    }
    for (const k of numberKeys) {
      if (fields[k] !== undefined) patch[k] = Math.max(0, Number(fields[k]) || 0);
    }
    for (const k of dateKeys) {
      if (fields[k] !== undefined) patch[k] = fields[k] ? String(fields[k]) : null;
    }
    if (fields.status) {
      const status = String(fields.status).toUpperCase();
      if (!(REQUEST_STATUSES as readonly string[]).includes(status)) {
        return NextResponse.json({ error: `Status phải là một trong: ${REQUEST_STATUSES.join(", ")}` }, { status: 400 });
      }
      patch.status = status;
    }

    // Tính lại toàn bộ KPI phái sinh từ giá trị sau khi cập nhật (Yêu cầu #10).
    const num = (key: string, fallback: number | null) =>
      patch[key] !== undefined ? Number(patch[key]) : Number(fallback ?? 0);
    const maleRq = num("maleRq", existing.maleRq);
    const femaleRq = num("femaleRq", existing.femaleRq);
    // PHASE 6 v2: Balance = max(0, Rq - Current Workforce). Current Workforce
    // phải đếm TRỰC TIẾP từ source-of-truth (request_allocations ∩
    // employment_sessions ACTIVE), KHÔNG dùng male_recruited/female_recruited/
    // male_quit/female_quit. Các cột này là historical KPI, không phải Current.
    const currentRows = await db
      .select({
        gender: workerProfiles.gender,
      })
      .from(requestAllocations)
      .innerJoin(employmentSessions, eq(requestAllocations.employmentSessionId, employmentSessions.id))
      .innerJoin(workerProfiles, eq(requestAllocations.workerId, workerProfiles.id))
      .where(
        and(
          eq(requestAllocations.requestId, id),
          eq(requestAllocations.status, "ACTIVE"),
          eq(employmentSessions.status, "APPROVED"),
          isNull(employmentSessions.endDate),
          isNull(workerProfiles.deletedAt),
        ),
      );
    const lc = (s: string | null) => (s ?? "").trim().toLowerCase();
    const isMale = (g: string | null) => {
      const s = lc(g);
      return s === "nam" || s === "male" || s === "m";
    };
    const isFemale = (g: string | null) => {
      const s = lc(g);
      return s === "nữ" || s === "nu" || s === "female" || s === "f";
    };
    const maleCurrent = currentRows.filter((r) => isMale(r.gender)).length;
    const femaleCurrent = currentRows.filter((r) => isFemale(r.gender)).length;
    const balance = computeBalance({ maleRq, femaleRq, maleCurrent, femaleCurrent });
    const totalRequest = computeTotalRequest(maleRq, femaleRq);
    patch.maleBalance = balance.maleBalance;
    patch.femaleBalance = balance.femaleBalance;
    patch.totalBalance = balance.totalBalance;
    patch.totalRequest = totalRequest;
    patch.recruitedVsExpected = computeRecruitedVsExpected(
      Number(existing.maleRecruited ?? 0),
      Number(existing.femaleRecruited ?? 0),
      totalRequest,
    );
    const str = (key: string, fallback: string | null) =>
      patch[key] !== undefined ? (patch[key] as string | null) : fallback;
    Object.assign(
      patch,
      computeDateDeltas({
        requestedDate: str("requestedDate", existing.requestedDate),
        offeredDate: str("offeredDate", existing.offeredDate),
        completedDate: str("completedDate", existing.completedDate),
      }),
    );

    const [updated] = await db
      .update(recruitmentRequests)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(recruitmentRequests.id, id))
      .returning();

    await writeAudit(guard.session, "UPDATE_RECRUITMENT_REQUEST", "recruitment_requests", {
      id,
      requestCode: updated.requestCode,
      changedFields: Object.keys(patch),
      rejectedSystemOwnedFields: rejected,
    });
    return NextResponse.json({ success: true, row: updated, rejectedFields: rejected });
  }

  return NextResponse.json({ error: "Thiếu action hợp lệ." }, { status: 400 });
}

/** Xoá mềm yêu cầu tuyển dụng. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const existing = await getRecruitmentRequest(id);
  if (!existing) return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });

  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, existing.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy yêu cầu trong Data Scope được cấp." }, { status: 404 });
  }

  await softDeleteRecruitmentRequests([id], guard.session.username);
  await writeAudit(guard.session, "DELETE_RECRUITMENT_REQUEST", "recruitment_requests", { id, requestCode: existing.requestCode });
  return NextResponse.json({ success: true });
}
