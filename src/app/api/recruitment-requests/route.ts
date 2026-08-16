import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recruitmentRequests } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { listRecruitmentRequests, matchHierarchy, type RecruitmentRequestFilter } from "@/lib/recruitment-request";
import {
  REQUEST_STATUSES,
  computeBalance,
  computeDateDeltas,
  computeTotalRequest,
  stripSystemOwnedFields,
} from "@/lib/planning-recruitment-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Danh sách yêu cầu tuyển dụng — lọc theo Data Scope, Month, Location, Division, Department, Section, Group, Status, Requester, search Request Code. */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "planning.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const filter: RecruitmentRequestFilter = {
    month: url.searchParams.get("month") || undefined,
    location: url.searchParams.get("location") || undefined,
    division: url.searchParams.get("division") || undefined,
    department: url.searchParams.get("department") || undefined,
    section: url.searchParams.get("section") || undefined,
    group: url.searchParams.get("group") || undefined,
    status: url.searchParams.get("status") || undefined,
    requester: url.searchParams.get("requester") || undefined,
    reason: url.searchParams.get("reason") || undefined,
    searchQuery: url.searchParams.get("q") || undefined,
    // Yêu cầu #12 — lọc theo khoảng Ngày yêu cầu / Ngày cần nhân lực.
    requestedFrom: url.searchParams.get("requestedFrom") || undefined,
    requestedTo: url.searchParams.get("requestedTo") || undefined,
    expectedFrom: url.searchParams.get("expectedFrom") || undefined,
    expectedTo: url.searchParams.get("expectedTo") || undefined,
    fulfillment: (url.searchParams.get("fulfillment") as RecruitmentRequestFilter["fulfillment"]) || undefined,
    // Yêu cầu #5 — bỏ trống = sắp xếp mặc định theo Ngày cần nhân lực
    // (quá hạn chưa xong lên đầu), KHÔNG theo ngày kết thúc mùa vụ.
    sortBy: (url.searchParams.get("sortBy") as RecruitmentRequestFilter["sortBy"]) || undefined,
    sortDir: url.searchParams.get("sortDir") === "desc" ? "desc" : url.searchParams.get("sortDir") === "asc" ? "asc" : undefined,
  };

  const scope = await getUserScope(guard.session);
  filter.scope = scope;

  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 500));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  const { rows, total } = await listRecruitmentRequests(filter, limit, offset);
  return NextResponse.json({ rows, total });
}

/** Tạo yêu cầu tuyển dụng mới. */
export async function POST(req: Request) {
  // DEPT_MANAGER CHỈ ĐỌC trong Data Scope (Yêu cầu #3): không được tạo yêu cầu.
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.request");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    requestCode?: string;
    requester?: string;
    position?: string;
    jobTitle?: string;
    location?: string;
    section?: string;
    groupName?: string;
    division?: string;
    department?: string;
    reason?: string;
    noteForReason?: string;
    specialRequirements?: string;
    maleRq?: number;
    femaleRq?: number;
    status?: string;
    // Yêu cầu #6 — sáu loại ngày tách bạch.
    requestedDate?: string;
    expectedDate?: string;
    startingDate?: string;
    endDate?: string;
    offeredDate?: string;
    completedDate?: string;
    month?: string;
    cost?: number;
    remarks?: string;
    to?: string;
    rqStatus?: string;
    monthRc?: string;
    departmentText?: string;
    monthReport?: string;
    planningPeriodId?: string | null;
    // Yêu cầu #4 — chuỗi lịch sử: yêu cầu mới NỐI vào yêu cầu cũ thay vì sửa đè.
    previousRequestId?: string | null;
    supersedesRequestId?: string | null;
  };

  const requestCode = body.requestCode?.trim();
  if (!requestCode) {
    return NextResponse.json({ error: "Request Code là bắt buộc." }, { status: 400 });
  }

  // Kiểm tra trùng Request Code (idempotent)
  const existing = await db
    .select({ id: recruitmentRequests.id })
    .from(recruitmentRequests)
    .where(and(eq(recruitmentRequests.requestCode, requestCode), isNull(recruitmentRequests.deletedAt)))
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: `Request Code "${requestCode}" đã tồn tại. Dùng Import để cập nhật hoặc đổi mã khác.` }, { status: 409 });
  }

  // Yêu cầu #10 — chỉ Male/Female Rq là số do người dùng nhập. Mọi KPI khác
  // (Application/Interviewed/Recruited/Quit/Screened/Interview/Recruit) do hệ
  // thống dẫn xuất từ Daily Application / phân bổ / Workforce Movement, nên
  // yêu cầu MỚI luôn bắt đầu từ 0 và không nhận giá trị từ payload.
  const { safe: safeBody, rejected } = stripSystemOwnedFields(body as Record<string, unknown>);
  const maleRq = Math.max(0, Number(safeBody.maleRq) || 0);
  const femaleRq = Math.max(0, Number(safeBody.femaleRq) || 0);

  // Balance = Rq - Recruited + Quit; yêu cầu mới chưa tuyển ai nên = Rq.
  const balance = computeBalance({ maleRq, femaleRq, maleRecruited: 0, femaleRecruited: 0, maleQuit: 0, femaleQuit: 0 });
  const totalRequest = computeTotalRequest(maleRq, femaleRq);

  // Khớp cây tổ chức để có department_id — Data Scope lọc theo FK này (Yêu cầu #15).
  const { deptId: departmentId } = await matchHierarchy(
    body.location,
    body.division,
    body.department,
    body.section,
    body.groupName,
  );
  // Người dùng bị giới hạn Data Scope không được tạo yêu cầu ngoài phạm vi.
  if (!scopeAllowsDepartment(await getUserScope(guard.session), departmentId)) {
    return NextResponse.json(
      { error: "Phòng ban của yêu cầu nằm ngoài Data Scope được cấp cho tài khoản này." },
      { status: 403 },
    );
  }

  // Yêu cầu #4 — Planning là lịch sử chỉ-thêm. Một yêu cầu mới có thể khai báo
  // nó nối tiếp (previous_request_id) hoặc thay thế (supersedes_request_id) một
  // yêu cầu cũ. Cả hai chỉ là liên kết truy vết: bản ghi cũ KHÔNG bị sửa nội
  // dung, KHÔNG bị xoá, và các phân bổ đang mở của nó vẫn nguyên vẹn.
  const linkIds = [body.previousRequestId, body.supersedesRequestId].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (linkIds.length > 0) {
    const linked = await db
      .select({ id: recruitmentRequests.id, departmentId: recruitmentRequests.departmentId })
      .from(recruitmentRequests)
      .where(and(inArray(recruitmentRequests.id, linkIds), isNull(recruitmentRequests.deletedAt)));
    const found = new Set(linked.map((r) => r.id));
    const missing = linkIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Không tìm thấy yêu cầu được tham chiếu: ${missing.join(", ")}` },
        { status: 400 },
      );
    }
    // Data Scope áp cả cho yêu cầu được tham chiếu (Yêu cầu #15).
    const scope = await getUserScope(guard.session);
    if (linked.some((r) => !scopeAllowsDepartment(scope, r.departmentId))) {
      return NextResponse.json(
        { error: "Yêu cầu được tham chiếu nằm ngoài Data Scope của tài khoản này." },
        { status: 404 },
      );
    }
  }

  try {
    const [row] = await db
      .insert(recruitmentRequests)
      .values({
        requestCode,
        requester: body.requester?.trim() ?? guard.session.username,
        position: body.position ?? null,
        jobTitle: body.jobTitle ?? null,
        location: body.location ?? null,
        section: body.section ?? null,
        groupName: body.groupName ?? null,
        division: body.division ?? null,
        department: body.department ?? null,
        reason: body.reason ?? null,
        noteForReason: body.noteForReason ?? null,
        specialRequirements: body.specialRequirements ?? null,
        maleRq,
        femaleRq,
        maleBalance: balance.maleBalance,
        femaleBalance: balance.femaleBalance,
        totalBalance: balance.totalBalance,
        status: normalizeStatus(body.status),
        requestedDate: body.requestedDate || null,
        expectedDate: body.expectedDate || null,
        startingDate: body.startingDate || null,
        endDate: body.endDate || null,
        offeredDate: body.offeredDate || null,
        completedDate: body.completedDate || null,
        ...computeDateDeltas({
          requestedDate: body.requestedDate || null,
          offeredDate: body.offeredDate || null,
          completedDate: body.completedDate || null,
        }),
        departmentId,
        month: body.month || null,
        cost: Math.max(0, Number(body.cost) || 0),
        remarks: body.remarks ?? null,
        to: body.to ?? null,
        rqStatus: body.rqStatus ?? null,
        monthRc: body.monthRc ?? null,
        totalRequest,
        recruitedVsExpected: 0,
        departmentText: body.departmentText ?? body.department ?? null,
        monthReport: body.monthReport ?? null,
        planningPeriodId: body.planningPeriodId ?? null,
        previousRequestId: body.previousRequestId || null,
        supersedesRequestId: body.supersedesRequestId || null,
        createdBy: guard.session.username,
      })
      .returning();

    await writeAudit(guard.session, "CREATE_RECRUITMENT_REQUEST", "recruitment_requests", {
      id: row.id,
      requestCode: row.requestCode,
      status: row.status,
      maleRq,
      femaleRq,
      previousRequestId: row.previousRequestId,
      supersedesRequestId: row.supersedesRequestId,
      rejectedSystemOwnedFields: rejected,
    });

    return NextResponse.json({ success: true, row, rejectedFields: rejected });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

function normalizeStatus(s?: string): string {
  const upper = (s ?? "PENDING").trim().toUpperCase();
  // EXPIRED nằm trong tập trạng thái hợp lệ (Yêu cầu #13) — hết hạn KHÁC huỷ.
  if ((REQUEST_STATUSES as readonly string[]).includes(upper)) return upper;
  if (upper.includes("EXPIR") || upper.includes("HET HAN")) return "EXPIRED";
  if (upper.includes("PEND")) return "PENDING";
  if (upper.includes("PROCESS") || upper.includes("PROGRESS")) return "PROCESSING";
  if (upper.includes("COMPLETE") || upper.includes("DONE")) return "COMPLETED";
  if (upper.includes("CANCEL")) return "CANCELLED";
  return "PENDING";
}
