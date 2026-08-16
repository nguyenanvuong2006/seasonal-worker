import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSession, getUserScope, hasPermission, writeAudit } from "@/lib/auth";
import { listRecruitmentRequests } from "@/lib/recruitment-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GREEN = "FF115830";
const GOLD = "FFD9A327";
const LIGHT = "FFEFF6F0";

/** Xuất Excel danh sách yêu cầu tuyển dụng theo bộ lọc hiện tại. */
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

  const wb = new ExcelJS.Workbook();
  wb.creator = "Dalat Hasfarm Seasonal HR";
  wb.created = new Date();
  const ws = wb.addWorksheet("Recruitment Requests", {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });

  const headers = [
    "Request Code", "Requester", "Position", "Job title", "Location", "Section", "Group",
    "Division", "Department", "Reason", "Note for reason", "Special Requirements",
    "Male Rq", "Female Rq", "Male Application", "Female Application",
    "Male Interviewed", "Female Interviewed", "Male Recruited", "Female Recruited",
    "Male Quit", "Female Quit", "Male Balance", "Female Balance", "Total Balance",
    "Status", "Requested Date", "Expected Date", "Offered Date", "Completed Date",
    "Offered Date vs Requested Date", "Completed Date vs Requested Date",
    "Month", "Cost", "Remarks", "To", "Rq Status", "Month_Rc",
    "Total Request", "Recruited vs Expected", "Screened", "Interview", "Recruit",
    "Month_Report", "Created By", "Created At",
  ];

  const LAST_COL_LETTER = (n: number) => {
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const LAST = LAST_COL_LETTER(headers.length + 1);

  ws.mergeCells(`A1:${LAST}1`);
  const t = ws.getCell("A1");
  t.value = "🌸 DALAT HASFARM — WORKFORCE RECRUITMENT REQUEST PLANNING";
  t.font = { name: "Arial", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
  t.alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(1).height = 34;

  ws.mergeCells(`A2:${LAST}2`);
  const s = ws.getCell("A2");
  s.value = `DANH SÁCH YÊU CẦU TUYỂN DỤNG — ${new Date().toLocaleDateString("vi-VN")}`;
  s.font = { name: "Arial", size: 12, bold: true, color: { argb: GREEN } };
  s.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAEDCD" } };
  s.alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(2).height = 24;

  ws.mergeCells(`A3:${LAST}3`);
  const m = ws.getCell("A3");
  m.value = `Xuất bởi: ${session.fullName} (${session.username}) • ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} • Tổng: ${rows.length} yêu cầu`;
  m.font = { name: "Arial", size: 9, italic: true, color: { argb: "FF6B7F72" } };
  m.alignment = { horizontal: "center" };

  const hr = ws.addRow(["STT", ...headers]);
  hr.height = 26;
  hr.eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  ws.getColumn(1).width = 6;
  headers.forEach((_, i) => {
    ws.getColumn(i + 2).width = i < 12 ? 20 : 14;
  });

  const dateDiff = (a?: string | null, b?: string | null) => {
    if (!a || !b) return "";
    const da = new Date(a + "T00:00:00");
    const db = new Date(b + "T00:00:00");
    const diff = Math.round((da.getTime() - db.getTime()) / 86400000);
    return isNaN(diff) ? "" : String(diff);
  };

  rows.forEach((r, i) => {
    const rowValues = [
      i + 1,
      r.requestCode,
      r.requester,
      r.position ?? "",
      r.jobTitle ?? "",
      r.location ?? "",
      r.section ?? "",
      r.groupName ?? "",
      r.division ?? "",
      r.department ?? r.departmentText ?? "",
      r.reason ?? "",
      r.noteForReason ?? "",
      r.specialRequirements ?? "",
      r.maleRq,
      r.femaleRq,
      r.maleApplication,
      r.femaleApplication,
      r.maleInterviewed,
      r.femaleInterviewed,
      r.maleRecruited,
      r.femaleRecruited,
      r.maleQuit,
      r.femaleQuit,
      r.maleBalance,
      r.femaleBalance,
      r.totalBalance,
      r.status,
      r.requestedDate ?? "",
      r.expectedDate ?? "",
      r.offeredDate ?? "",
      r.completedDate ?? "",
      dateDiff(r.offeredDate, r.requestedDate),
      dateDiff(r.completedDate, r.requestedDate),
      r.month ?? "",
      r.cost ?? 0,
      r.remarks ?? "",
      r.to ?? "",
      r.rqStatus ?? "",
      r.monthRc ?? "",
      r.totalRequest,
      r.recruitedVsExpected,
      r.screened,
      r.interview,
      r.recruit,
      r.monthReport ?? "",
      r.createdBy,
      r.createdAt ? new Date(r.createdAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "",
    ];
    const row = ws.addRow(rowValues);
    row.height = 20;
    row.eachCell((cell, col) => {
      cell.font = { name: "Arial", size: 10 };
      cell.alignment = {
        vertical: "middle",
        horizontal: col === 1 || col === 2 ? "center" : "left",
      };
      if (i % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
    });
  });

  const fr = ws.addRow([]);
  ws.mergeCells(`A${fr.number + 1}:${LAST}${fr.number + 1}`);
  const f = ws.getCell(`A${fr.number + 1}`);
  f.value = "Dalat Hasfarm — EST. 1994 • Tài liệu nội bộ";
  f.font = { name: "Arial", size: 8, italic: true, color: { argb: "FF9CA3AF" } };
  f.alignment = { horizontal: "center" };

  ws.views = [{ state: "frozen", ySplit: 4 }];
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length + 1 } };

  const buffer = await wb.xlsx.writeBuffer();
  await writeAudit(session, "EXPORT_RECRUITMENT_REQUESTS", "recruitment_requests", { rows: rows.length });

  const ascii = "RecruitmentRequests";
  const utf8 = encodeURIComponent(`DalatHasfarm-RecruitmentRequests-${new Date().toISOString().slice(0, 10)}.xlsx`);

  return new NextResponse(Buffer.from(buffer as ArrayBuffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${ascii}-${new Date().toISOString().slice(0, 10)}.xlsx"; filename*=UTF-8''${utf8}`,
    },
  });
}
