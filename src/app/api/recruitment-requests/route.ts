import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recruitmentRequests } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { listRecruitmentRequests, type RecruitmentRequestFilter } from "@/lib/recruitment-request";

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
    searchQuery: url.searchParams.get("q") || undefined,
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
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], "planning.request");
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
    maleApplication?: number;
    femaleApplication?: number;
    maleInterviewed?: number;
    femaleInterviewed?: number;
    maleRecruited?: number;
    femaleRecruited?: number;
    maleQuit?: number;
    femaleQuit?: number;
    status?: string;
    requestedDate?: string;
    expectedDate?: string;
    offeredDate?: string;
    completedDate?: string;
    month?: string;
    cost?: number;
    remarks?: string;
    to?: string;
    rqStatus?: string;
    monthRc?: string;
    totalRequest?: number;
    recruitedVsExpected?: number;
    screened?: number;
    interview?: number;
    recruit?: number;
    departmentText?: string;
    monthReport?: string;
    planningPeriodId?: string | null;
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

  const maleRq = Math.max(0, Number(body.maleRq) || 0);
  const femaleRq = Math.max(0, Number(body.femaleRq) || 0);
  const maleRecruited = Math.max(0, Number(body.maleRecruited) || 0);
  const femaleRecruited = Math.max(0, Number(body.femaleRecruited) || 0);
  const maleQuit = Math.max(0, Number(body.maleQuit) || 0);
  const femaleQuit = Math.max(0, Number(body.femaleQuit) || 0);

  // CÔNG THỨC Balance: Male Balance = Male Rq - Male Allocated/Recruited + Male Quit
  const maleBalance = Math.max(0, maleRq - maleRecruited + maleQuit);
  const femaleBalance = Math.max(0, femaleRq - femaleRecruited + femaleQuit);
  const totalBalance = maleBalance + femaleBalance;

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
        maleApplication: Math.max(0, Number(body.maleApplication) || 0),
        femaleApplication: Math.max(0, Number(body.femaleApplication) || 0),
        maleInterviewed: Math.max(0, Number(body.maleInterviewed) || 0),
        femaleInterviewed: Math.max(0, Number(body.femaleInterviewed) || 0),
        maleRecruited,
        femaleRecruited,
        maleQuit,
        femaleQuit,
        maleBalance,
        femaleBalance,
        totalBalance,
        status: normalizeStatus(body.status),
        requestedDate: body.requestedDate || null,
        expectedDate: body.expectedDate || null,
        offeredDate: body.offeredDate || null,
        completedDate: body.completedDate || null,
        month: body.month || null,
        cost: Math.max(0, Number(body.cost) || 0),
        remarks: body.remarks ?? null,
        to: body.to ?? null,
        rqStatus: body.rqStatus ?? null,
        monthRc: body.monthRc ?? null,
        totalRequest: Math.max(0, Number(body.totalRequest) || 0),
        recruitedVsExpected: Math.max(0, Number(body.recruitedVsExpected) || 0),
        screened: Math.max(0, Number(body.screened) || 0),
        interview: Math.max(0, Number(body.interview) || 0),
        recruit: Math.max(0, Number(body.recruit) || 0),
        departmentText: body.departmentText ?? body.department ?? null,
        monthReport: body.monthReport ?? null,
        planningPeriodId: body.planningPeriodId ?? null,
        createdBy: guard.session.username,
      })
      .returning();

    await writeAudit(guard.session, "CREATE_RECRUITMENT_REQUEST", "recruitment_requests", {
      id: row.id,
      requestCode: row.requestCode,
      status: row.status,
      maleRq,
      femaleRq,
    });

    return NextResponse.json({ success: true, row });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

function normalizeStatus(s?: string): string {
  const upper = (s ?? "PENDING").trim().toUpperCase();
  const valid = ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED"];
  if (valid.includes(upper)) return upper;
  if (upper.includes("PEND")) return "PENDING";
  if (upper.includes("PROCESS") || upper.includes("PROGRESS")) return "PROCESSING";
  if (upper.includes("COMPLETE") || upper.includes("DONE")) return "COMPLETED";
  if (upper.includes("CANCEL")) return "CANCELLED";
  return "PENDING";
}
