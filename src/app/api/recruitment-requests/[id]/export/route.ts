import { NextResponse } from "next/server";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { sanitizeFilenameSegment } from "@/lib/document-merge/filename";
import { addStyledSheet, createStyledWorkbook, workbookToBuffer, type StyledSheetColumn } from "@/lib/excel-workbook-style";
import { todayStr } from "@/lib/helpers";
import { getRecruitmentRequest } from "@/lib/recruitment-request";
import { getRequestDetail, type RequestDetail } from "@/lib/workforce-request";
import { resolveDefaultAsOf } from "@/lib/workforce-request-kpi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/recruitment-requests/:id/export — CANONICAL Request Detail export
 * (Phase 2B mục 6). Kéo dữ liệu 100% từ getRequestDetail() — KHÔNG tính KPI
 * lần thứ hai ở đây. Dùng CHUNG cho cả 2 mặt UI (/admin/recruitment-requests
 * VÀ /admin/workforce-requests) — không tạo export riêng cho
 * workforce-requests, trỏ về endpoint này nếu cần.
 *
 * Permission/Data Scope/asOf mặc định GIỐNG HỆT canonical detail route
 * ([id]/detail/route.ts) — cùng 1 request phải cho cùng 1 kết quả dù xem
 * trên màn hình hay xuất Excel.
 *
 * Sheet layout: Summary/KPI, Recruited (Pipeline theo giai đoạn), Resigned,
 * Transferred Out, Current/Closing Workforce (nhãn phụ thuộc live/historical),
 * Allocation History. Mỗi sheet dùng addStyledSheet() (style dùng chung với
 * Daily Operations, không phải implementation ExcelJS thứ hai).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_DIRECTOR", "HR_RECRUITER", "DEPT_MANAGER"], "planning.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const url = new URL(req.url);
  const asOfParam = url.searchParams.get("asOf");

  const row = await getRecruitmentRequest(id);
  if (!row) return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });

  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, row.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy yêu cầu trong Data Scope được cấp." }, { status: 404 });
  }

  const today = todayStr();
  const asOf = asOfParam || resolveDefaultAsOf(row, today);
  const detail = await getRequestDetail(id, asOf);
  if (!detail) return NextResponse.json({ error: "Không tìm thấy yêu cầu tuyển dụng." }, { status: 404 });

  const isLive = asOf === today;
  const buffer = await buildRequestDetailWorkbook(detail, isLive);

  await writeAudit(guard.session, "EXPORT_RECRUITMENT_REQUEST_DETAIL", "recruitment_requests", { requestId: id, asOf });

  const monthPart = (detail.request.month || (detail.request.requestedDate ?? detail.request.createdAt.toISOString().slice(0, 10)).slice(0, 7)).replace("/", "-");
  const filenameBase = [
    `RQ${sanitizeFilenameSegment(detail.request.requestCode, 40)}`,
    sanitizeFilenameSegment(detail.request.deptName ?? detail.request.department ?? "unassigned", 40),
    sanitizeFilenameSegment(monthPart, 10),
  ].join("_");
  const utf8Name = encodeURIComponent(`${filenameBase}.xlsx`);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filenameBase}.xlsx"; filename*=UTF-8''${utf8Name}`,
    },
  });
}

async function buildRequestDetailWorkbook(detail: RequestDetail, isLive: boolean): Promise<Buffer> {
  const wb = createStyledWorkbook();
  const currentLabel = isLive ? "Hiện tại" : "Cuối kỳ (Closing Workforce)";

  const summaryCol = <T,>(header: string, width: number, value: (row: T) => string | number): StyledSheetColumn<T> => ({ header, width, value });
  addStyledSheet(wb, {
    sheetName: "Summary",
    title: `Tổng quan — ${detail.request.requestCode}`,
    columns: [
      summaryCol<[string, string | number]>("Chỉ tiêu", 32, (r) => r[0]),
      summaryCol<[string, string | number]>("Giá trị", 20, (r) => r[1]),
    ],
    rows: [
      ["Request Code", detail.request.requestCode],
      ["Requester", detail.request.requester],
      ["Department", detail.request.deptName ?? detail.request.department ?? ""],
      ["Status", detail.request.status],
      ["Requested Date", detail.request.requestedDate ?? ""],
      ["Expected Date", detail.request.expectedDate ?? ""],
      ["Male Request", detail.kpi.maleRequest],
      ["Female Request", detail.kpi.femaleRequest],
      ["Total Request", detail.kpi.totalRequest],
      [`Male Current (${currentLabel})`, detail.kpi.maleCurrent],
      [`Female Current (${currentLabel})`, detail.kpi.femaleCurrent],
      [`Total Current (${currentLabel})`, detail.kpi.totalCurrent],
      ["Male Recruited", detail.kpi.maleRecruited],
      ["Female Recruited", detail.kpi.femaleRecruited],
      ["Total Recruited", detail.kpi.totalRecruited],
      ["Male Quit", detail.kpi.maleQuit],
      ["Female Quit", detail.kpi.femaleQuit],
      ["Total Quit", detail.kpi.totalQuit],
      ["Male Transfer Out", detail.kpi.maleTransferOut],
      ["Female Transfer Out", detail.kpi.femaleTransferOut],
      ["Total Transfer Out", detail.kpi.totalTransferOut],
      ["Male Balance", detail.kpi.maleBalance],
      ["Female Balance", detail.kpi.femaleBalance],
      ["Total Balance", detail.kpi.totalBalance],
      ["Fill Rate (%)", detail.kpi.fillRatePercent],
    ],
    emptyMessage: undefined,
  });

  addStyledSheet(wb, {
    sheetName: "Recruited",
    title: "Recruited theo giai đoạn (Pipeline)",
    columns: [
      { header: "Giai đoạn", width: 24, value: (r: RequestDetail["pipeline"][number]) => r.status },
      { header: "Nam", width: 12, value: (r) => r.male },
      { header: "Nữ", width: 12, value: (r) => r.female },
      { header: "Tổng", width: 12, value: (r) => r.total },
    ],
    rows: detail.pipeline,
    emptyMessage: "(Chưa có ứng viên nào ở pipeline)",
  });

  addStyledSheet(wb, {
    sheetName: "Resigned",
    title: "Nghỉ việc trong kỳ (Quit)",
    columns: [
      { header: "Họ tên", width: 26, value: (r: RequestDetail["resignedWorkers"][number]) => r.workerName ?? "" },
      { header: "Giới tính", width: 12, value: (r) => r.gender ?? "" },
      { header: "Ngày hiệu lực", width: 16, value: (r) => r.effectiveDate },
      { header: "Lý do", width: 30, value: (r) => r.reason ?? "" },
    ],
    rows: detail.resignedWorkers,
    emptyMessage: "(Không có ai nghỉ việc trong kỳ này)",
  });

  addStyledSheet(wb, {
    sheetName: "Transferred Out",
    title: "Chuyển đi trong kỳ (Transfer Out)",
    columns: [
      { header: "Họ tên", width: 26, value: (r: RequestDetail["transferredWorkers"][number]) => r.workerName ?? "" },
      { header: "Giới tính", width: 12, value: (r) => r.gender ?? "" },
      { header: "Ngày hiệu lực", width: 16, value: (r) => r.effectiveDate },
      { header: "Từ bộ phận", width: 22, value: (r) => r.fromDeptName ?? "" },
      { header: "Đến bộ phận", width: 22, value: (r) => r.toDeptName ?? "" },
      { header: "Request đích", width: 20, value: (r) => r.destinationRequestCode ?? "" },
    ],
    rows: detail.transferredWorkers,
    emptyMessage: "(Không có ai chuyển đi trong kỳ này)",
  });

  addStyledSheet(wb, {
    sheetName: "Current Workforce",
    title: `${currentLabel} — Current Workforce`,
    columns: [
      { header: "Họ tên", width: 26, value: (r: RequestDetail["currentWorkers"][number]) => r.workerName ?? "" },
      { header: "Giới tính", width: 12, value: (r) => r.gender ?? "" },
      { header: "Bộ phận", width: 22, value: (r) => r.deptName ?? "" },
      { header: "Ngày phân bổ", width: 18, value: (r) => r.allocatedAt.toISOString().slice(0, 10) },
      { header: "Phân bổ bởi", width: 16, value: (r) => r.allocatedBy },
    ],
    rows: detail.currentWorkers,
    emptyMessage: "(Không có lao động nào)",
  });

  addStyledSheet(wb, {
    sheetName: "Allocation History",
    title: "Lịch sử phân bổ (Allocation History)",
    columns: [
      { header: "Hành động", width: 14, value: (r: RequestDetail["history"][number]) => r.action },
      { header: "Họ tên", width: 26, value: (r) => r.workerName ?? "" },
      { header: "Từ Request", width: 16, value: (r) => r.fromRequestId ?? "" },
      { header: "Đến Request", width: 16, value: (r) => r.toRequestId ?? "" },
      { header: "Lý do", width: 26, value: (r) => r.reason ?? "" },
      { header: "Thực hiện bởi", width: 16, value: (r) => r.changedBy },
      { header: "Thời điểm", width: 20, value: (r) => r.changedAt.toISOString() },
    ],
    rows: detail.history,
    emptyMessage: "(Chưa có lịch sử phân bổ)",
  });

  return workbookToBuffer(wb);
}
