import { NextResponse } from "next/server";
import { getSession, getUserScope, hasPermission, writeAudit } from "@/lib/auth";
import { addStyledSheet, createStyledWorkbook, workbookToBuffer } from "@/lib/excel-workbook-style";
import { todayStr } from "@/lib/helpers";
import { listRecruitmentRequests, type RecruitmentRequest } from "@/lib/recruitment-request";
import { batchComputeRequestKpis } from "@/lib/workforce-request";
import { resolveDefaultAsOf, type RequestKpi } from "@/lib/workforce-request-kpi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RowWithKpi = RecruitmentRequest & { kpi: RequestKpi };

/**
 * Xuất Excel danh sách yêu cầu tuyển dụng theo bộ lọc hiện tại.
 *
 * Phase 2B mục 6 — refactor: Recruited/Quit/Transfer Out/Balance đọc từ
 * `.kpi.*` (batchComputeRequestKpis, ĐÚNG 1 engine dùng chung với
 * /api/recruitment-requests GET và canonical Request Detail export), KHÔNG
 * còn đọc trực tiếp cột tĩnh male_recruited/male_quit/... trên row (có thể
 * lệch với KPI live khi allocation/movement đổi sau khi các cột đó được
 * ghi). Styling dùng chung addStyledSheet() — không còn ExcelJS hand-rolled
 * thứ hai riêng cho route này.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
  if (!(await hasPermission(session.role, "planning.view"))) {
    return NextResponse.json({ error: "Tài khoản của bạn không có quyền xem Planning." }, { status: 403 });
  }

  const url = new URL(req.url);
  const scope = await getUserScope(session);

  const { rows } = await listRecruitmentRequests(
    {
      month: url.searchParams.get("month") || undefined,
      location: url.searchParams.get("location") || undefined,
      division: url.searchParams.get("division") || undefined,
      department: url.searchParams.get("department") || undefined,
      section: url.searchParams.get("section") || undefined,
      group: url.searchParams.get("group") || undefined,
      status: url.searchParams.get("status") || undefined,
      requester: url.searchParams.get("requester") || undefined,
      searchQuery: url.searchParams.get("q") || undefined,
      scope,
    },
    2000,
  );

  const today = todayStr();
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const kpis = await batchComputeRequestKpis(rows, (r) => resolveDefaultAsOf(rowsById.get(r.id)!, today));
  const rowsWithKpi: RowWithKpi[] = rows.map((r) => ({ ...r, kpi: kpis.get(r.id)! }));

  const buffer = await buildFlatListWorkbook(rowsWithKpi, session);

  await writeAudit(session, "EXPORT_RECRUITMENT_REQUESTS", "recruitment_requests", { rows: rows.length });

  const dateStr = new Date().toISOString().slice(0, 10);
  const ascii = "RecruitmentRequests";
  const utf8 = encodeURIComponent(`DalatHasfarm-RecruitmentRequests-${dateStr}.xlsx`);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${ascii}-${dateStr}.xlsx"; filename*=UTF-8''${utf8}`,
    },
  });
}

function dateDiff(a?: string | null, b?: string | null): string {
  if (!a || !b) return "";
  const da = new Date(a + "T00:00:00");
  const db = new Date(b + "T00:00:00");
  const diff = Math.round((da.getTime() - db.getTime()) / 86400000);
  return isNaN(diff) ? "" : String(diff);
}

async function buildFlatListWorkbook(rows: RowWithKpi[], session: { fullName: string; username: string }): Promise<Buffer> {
  const wb = createStyledWorkbook();
  const col = (header: string, width: number, value: (r: RowWithKpi, i: number) => string | number) => ({ header, width, value });

  addStyledSheet(wb, {
    sheetName: "Recruitment Requests",
    title: `DALAT HASFARM — WORKFORCE RECRUITMENT REQUEST PLANNING • Xuất bởi ${session.fullName} (${session.username}) • Tổng: ${rows.length} yêu cầu`,
    columns: [
      col("Request Code", 20, (r) => r.requestCode),
      col("Requester", 18, (r) => r.requester),
      col("Position", 16, (r) => r.position ?? ""),
      col("Job title", 18, (r) => r.jobTitle ?? ""),
      col("Location", 16, (r) => r.location ?? ""),
      col("Section", 16, (r) => r.section ?? ""),
      col("Group", 16, (r) => r.groupName ?? ""),
      col("Division", 16, (r) => r.division ?? ""),
      col("Department", 16, (r) => r.department ?? r.departmentText ?? ""),
      col("Reason", 16, (r) => r.reason ?? ""),
      col("Note for reason", 16, (r) => r.noteForReason ?? ""),
      col("Special Requirements", 16, (r) => r.specialRequirements ?? ""),
      col("Male Rq", 10, (r) => r.maleRq),
      col("Female Rq", 10, (r) => r.femaleRq),
      col("Male Application", 12, (r) => r.maleApplication),
      col("Female Application", 12, (r) => r.femaleApplication),
      col("Male Interviewed", 12, (r) => r.maleInterviewed),
      col("Female Interviewed", 12, (r) => r.femaleInterviewed),
      col("Male Recruited", 12, (r) => r.kpi.maleRecruited),
      col("Female Recruited", 12, (r) => r.kpi.femaleRecruited),
      col("Male Quit", 10, (r) => r.kpi.maleQuit),
      col("Female Quit", 10, (r) => r.kpi.femaleQuit),
      col("Male Transfer Out", 12, (r) => r.kpi.maleTransferOut),
      col("Female Transfer Out", 12, (r) => r.kpi.femaleTransferOut),
      col("Male Balance", 10, (r) => r.kpi.maleBalance),
      col("Female Balance", 10, (r) => r.kpi.femaleBalance),
      col("Total Balance", 10, (r) => r.kpi.totalBalance),
      col("Status", 14, (r) => r.status),
      col("Requested Date", 14, (r) => r.requestedDate ?? ""),
      col("Expected Date", 14, (r) => r.expectedDate ?? ""),
      col("Offered Date", 14, (r) => r.offeredDate ?? ""),
      col("Completed Date", 14, (r) => r.completedDate ?? ""),
      col("Offered Date vs Requested Date", 14, (r) => dateDiff(r.offeredDate, r.requestedDate)),
      col("Completed Date vs Requested Date", 14, (r) => dateDiff(r.completedDate, r.requestedDate)),
      col("Month", 10, (r) => r.month ?? ""),
      col("Cost", 12, (r) => r.cost ?? 0),
      col("Remarks", 16, (r) => r.remarks ?? ""),
      col("To", 14, (r) => r.to ?? ""),
      col("Rq Status", 14, (r) => r.rqStatus ?? ""),
      col("Month_Rc", 10, (r) => r.monthRc ?? ""),
      col("Total Request", 12, (r) => r.totalRequest),
      col("Recruited vs Expected", 14, (r) => r.recruitedVsExpected),
      col("Screened", 10, (r) => r.screened),
      col("Interview", 10, (r) => r.interview),
      col("Recruit", 10, (r) => r.recruit),
      col("Month_Report", 12, (r) => r.monthReport ?? ""),
      col("Created By", 14, (r) => r.createdBy),
      col("Created At", 18, (r) => (r.createdAt ? new Date(r.createdAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "")),
    ],
    rows,
    emptyMessage: "(Không có yêu cầu tuyển dụng nào khớp bộ lọc hiện tại)",
  });

  return workbookToBuffer(wb);
}
