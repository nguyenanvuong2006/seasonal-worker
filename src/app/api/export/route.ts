import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, formQuestions, workflowStages } from "@/db/schema";
import { getSession, getUserScope, hasPermission, writeAudit } from "@/lib/auth";
import { formatDate, STATUS_META, todayStr } from "@/lib/helpers";
import { exportColumns, getFieldDefinitions } from "@/lib/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GREEN = "FF115830";
const GOLD = "FFD9A327";
const LIGHT = "FFEFF6F0";

// Cột nào nên căn giữa khi hiển thị (chỉ là gợi ý trình bày, không ảnh hưởng dữ liệu).
const CENTERED_KEYS = new Set([
  "da_timestamp",
  "da_cccd",
  "da_gender",
  "da_dob",
  "da_age",
  "da_phone",
  "da_declared_type",
  "da_dw_match",
  "da_dw_code",
  "da_status",
]);

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
  if (!(await hasPermission(session.role, "registrations.export"))) {
    return NextResponse.json({ error: "Tài khoản của bạn không có quyền Xuất Excel." }, { status: 403 });
  }

  // PRIVACY (#17) — CCCD/SĐT/Địa chỉ chỉ hiện nếu Role có quyền tương ứng (mặc định CÓ quyền
  // khi admin chưa cấu hình gì ở /admin/permissions, để không tự khoá hệ thống của mình).
  const canViewCccd = await hasPermission(session.role, "privacy.view_cccd");
  const canViewPhone = await hasPermission(session.role, "privacy.view_phone");
  const canViewAddress = await hasPermission(session.role, "privacy.view_address");
  const mask = (v: string, visible: boolean) => (visible ? v : v ? "•••• (ẩn theo quyền)" : "");

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || url.searchParams.get("date") || todayStr();
  const to = url.searchParams.get("to") || from;
  const deptParam = url.searchParams.get("deptId");

  const filters = [gte(dailyApplications.regDate, from), lte(dailyApplications.regDate, to)];
  let deptLabel = "Tất cả bộ phận";
  let managerScope: string[] | null = null;

  if (session.role === "DEPT_MANAGER") {
    managerScope = await getUserScope(session);
    if (!managerScope || managerScope.length === 0) {
      return NextResponse.json({ error: "Chưa gán bộ phận." }, { status: 400 });
    }
    if (deptParam && deptParam !== "ALL" && managerScope.includes(deptParam)) {
      filters.push(eq(dailyApplications.deptId, deptParam));
    } else {
      filters.push(inArray(dailyApplications.deptId, managerScope));
    }
    filters.push(eq(dailyApplications.status, "APPROVED"));
  } else if (deptParam && deptParam !== "ALL") {
    filters.push(eq(dailyApplications.deptId, deptParam));
  }

  const rows = await db
    .select({
      cccd: dailyApplications.cccd,
      fullName: dailyApplications.fullName,
      gender: dailyApplications.gender,
      dob: dailyApplications.dob,
      age: dailyApplications.age,
      phone: dailyApplications.phone,
      ethnicity: dailyApplications.ethnicity,
      permanentAddress: dailyApplications.permanentAddress,
      residentialAddress: dailyApplications.residentialAddress,
      regDate: dailyApplications.regDate,
      status: dailyApplications.status,
      declaredType: dailyApplications.declaredType,
      dwMatch: dailyApplications.dwMatch,
      dwCode: dailyApplications.dwCode,
      workDuration: dailyApplications.workDuration,
      referralChannel: dailyApplications.referralChannel,
      deptName: departments.deptName,
      groupName: departments.groupName,
      vnName: departments.vnName,
      supervisor: departments.supervisor,
      startingDate: dailyApplications.startingDate,
      appointmentList: dailyApplications.appointmentList,
      noteWorker: dailyApplications.noteWorker,
      vaccine: dailyApplications.vaccine,
      codeCheck: dailyApplications.codeCheck,
      customAnswers: dailyApplications.customAnswers,
    })
    .from(dailyApplications)
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .where(and(...filters))
    .orderBy(asc(departments.deptName), asc(dailyApplications.fullName));

  const targetDeptId =
    session.role === "DEPT_MANAGER" && deptParam && managerScope?.includes(deptParam) ? deptParam : null;
  if (targetDeptId) {
    const [d] = await db.select().from(departments).where(eq(departments.id, targetDeptId));
    if (d) deptLabel = `${d.deptName}${d.groupName ? " — " + d.groupName : ""}`;
  } else if (session.role === "DEPT_MANAGER" && managerScope) {
    deptLabel = managerScope.length === 1 ? deptLabel : `${managerScope.length} bộ phận được phân công`;
    if (managerScope.length === 1) {
      const [d] = await db.select().from(departments).where(eq(departments.id, managerScope[0]));
      if (d) deptLabel = `${d.deptName}${d.groupName ? " — " + d.groupName : ""}`;
    }
  } else if (deptParam && deptParam !== "ALL") {
    const [d] = await db.select().from(departments).where(eq(departments.id, deptParam));
    if (d) deptLabel = `${d.deptName}${d.groupName ? " — " + d.groupName : ""}`;
  }

  /* ============================================================
     METADATA ENGINE — cột export lấy từ field_definitions (group =
     daily_application, exportable=true), sắp theo sortOrder. Các câu
     hỏi động (form_questions, đang Active) được nối thêm vào cuối,
     đọc dữ liệu từ customAnswers. Thêm/bớt/đổi tên câu hỏi hoặc trường
     KHÔNG cần sửa file này — chỉ cần cấu hình ở /admin/field-definitions
     hoặc /admin/form-builder.
     ============================================================ */
  const defs = await getFieldDefinitions("daily_application");
  const coreCols = exportColumns(defs);
  const questions = await db
    .select()
    .from(formQuestions)
    .where(eq(formQuestions.isActive, true))
    .orderBy(asc(formQuestions.sortOrder));

  // WORKFLOW ENGINE (#5) — nhãn trạng thái đọc từ workflow_stages, dự phòng STATUS_META nếu trống.
  const stageRows = await db.select().from(workflowStages).where(eq(workflowStages.entityType, "daily_application"));
  const stageLabel = (key: string) => stageRows.find((s) => s.stageKey === key)?.label ?? STATUS_META[key]?.label ?? key;

  type Row = (typeof rows)[number];
  const resolvers: Record<string, (r: Row) => string> = {
    da_timestamp: (r) => formatDate(r.regDate),
    da_cccd: (r) => mask(r.cccd, canViewCccd),
    da_full_name: (r) => r.fullName,
    da_gender: (r) => r.gender ?? "",
    da_dob: (r) => r.dob ?? "",
    da_age: (r) => (r.age ?? "") + "",
    da_phone: (r) => mask(r.phone, canViewPhone),
    da_ethnicity: (r) => r.ethnicity ?? "",
    da_address: (r) => mask(r.residentialAddress ?? r.permanentAddress ?? "", canViewAddress),
    da_permanent_address: (r) => mask(r.permanentAddress ?? "", canViewAddress),
    da_declared_type: (r) => (r.declaredType === "OLD" ? "CŨ (tự khai)" : "MỚI (tự khai)"),
    da_dw_match: (r) => (r.dwMatch === "MATCHED" ? "CŨ (có DW)" : "MỚI"),
    da_dw_code: (r) => r.dwCode ?? "",
    da_work_duration: (r) => r.workDuration ?? "",
    da_referral: (r) => r.referralChannel ?? "",
    da_dept: (r) => r.deptName ?? "Chưa xếp",
    da_group: (r) => r.groupName ?? "",
    da_status: (r) => stageLabel(r.status),
    da_starting_date: (r) => formatDate(r.startingDate),
    da_appointment_list: (r) => r.appointmentList ?? "",
    da_note: (r) => r.noteWorker ?? "",
    da_vaccine: (r) => r.vaccine ?? "",
    da_code_check: (r) => r.codeCheck ?? "",
  };

  const headers = [...coreCols.map((c) => c.header), ...questions.map((q) => q.exportColumnName || q.questionText)];
  const totalCols = headers.length;
  const LAST_COL_LETTER = (n: number) => {
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const LAST = LAST_COL_LETTER(totalCols);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Dalat Hasfarm Seasonal HR";
  wb.created = new Date();
  const ws = wb.addWorksheet("Daily Application", {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });

  ws.mergeCells(`A1:${LAST}1`);
  const t = ws.getCell("A1");
  t.value = "🌸 DALAT HASFARM — CỔNG THÔNG TIN QUẢN LÝ TẬP NGHỀ THỜI VỤ";
  t.font = { name: "Arial", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
  t.alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(1).height = 34;

  ws.mergeCells(`A2:${LAST}2`);
  const s = ws.getCell("A2");
  const rangeLabel = from === to ? `NGÀY ${formatDate(from)}` : `TỪ ${formatDate(from)} ĐẾN ${formatDate(to)}`;
  s.value = `DANH SÁCH TIẾP NHẬN TẬP NGHỀ — ${deptLabel.toUpperCase()} — ${rangeLabel}`;
  s.font = { name: "Arial", size: 12, bold: true, color: { argb: GREEN } };
  s.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAEDCD" } };
  s.alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(2).height = 24;

  ws.mergeCells(`A3:${LAST}3`);
  const m = ws.getCell("A3");
  m.value = `Xuất bởi: ${session.fullName} (${session.username}) • ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} • Tổng: ${rows.length} người tập nghề`;
  m.font = { name: "Arial", size: 9, italic: true, color: { argb: "FF6B7F72" } };
  m.alignment = { horizontal: "center" };

  const hr = ws.addRow(["STT", ...headers]);
  hr.height = 26;
  hr.eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: GOLD } },
      bottom: { style: "medium", color: { argb: GOLD } },
      left: { style: "thin", color: { argb: "FFFFFFFF" } },
      right: { style: "thin", color: { argb: "FFFFFFFF" } },
    };
  });
  ws.getColumn(1).width = 6;
  coreCols.forEach((c, i) => {
    ws.getColumn(i + 2).width = c.def.fieldType === "NUMBER" ? 8 : 22;
  });
  questions.forEach((_, i) => {
    ws.getColumn(coreCols.length + i + 2).width = 22;
  });

  const centeredColIdx = new Set<number>([1, 2]); // STT, Ngày ĐK luôn căn giữa
  coreCols.forEach((c, i) => {
    if (CENTERED_KEYS.has(c.def.fieldKey)) centeredColIdx.add(i + 2);
  });

  rows.forEach((r, i) => {
    const rowValues = [
      i + 1,
      ...coreCols.map((c) => resolvers[c.def.fieldKey]?.(r) ?? ""),
      ...questions.map((q) => (r.customAnswers ?? {})[q.fieldKey] ?? ""),
    ];
    const row = ws.addRow(rowValues);
    row.height = 20;
    row.eachCell((cell, col) => {
      cell.font = { name: "Arial", size: 10 };
      cell.alignment = {
        vertical: "middle",
        horizontal: centeredColIdx.has(col) ? "center" : "left",
        wrapText: col === 1 + 1 + coreCols.findIndex((c) => c.def.fieldKey === "da_address"),
      };
      cell.border = {
        bottom: { style: "hair", color: { argb: "FFD6E5DA" } },
        left: { style: "hair", color: { argb: "FFD6E5DA" } },
        right: { style: "hair", color: { argb: "FFD6E5DA" } },
      };
      if (i % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
    });
    const dwMatchColIdx = coreCols.findIndex((c) => c.def.fieldKey === "da_dw_match");
    if (dwMatchColIdx >= 0) {
      row.getCell(dwMatchColIdx + 2).font = {
        name: "Arial",
        size: 10,
        bold: true,
        color: { argb: r.dwMatch === "MATCHED" ? "FF15803D" : "FFB45309" },
      };
    }
    const statusColIdx = coreCols.findIndex((c) => c.def.fieldKey === "da_status");
    if (statusColIdx >= 0) {
      row.getCell(statusColIdx + 2).font = {
        name: "Arial",
        size: 10,
        bold: true,
        color: {
          argb: r.status === "APPROVED" ? "FF15803D" : r.status === "REJECTED" ? "FFB91C1C" : "FFB45309",
        },
      };
    }
  });

  const fr = ws.addRow([]);
  ws.mergeCells(`A${fr.number + 1}:${LAST}${fr.number + 1}`);
  const f = ws.getCell(`A${fr.number + 1}`);
  f.value = "Dalat Hasfarm — EST. 1994 • Tài liệu nội bộ • In hoặc gửi Zalo cho Phụ trách tiếp nhận Tập nghề bộ phận";
  f.font = { name: "Arial", size: 8, italic: true, color: { argb: "FF9CA3AF" } };
  f.alignment = { horizontal: "center" };

  ws.views = [{ state: "frozen", ySplit: 4 }];
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: totalCols + 1 } };

  const buffer = await wb.xlsx.writeBuffer();
  await writeAudit(session, "EXPORT_EXCEL", "daily_applications", { from, to, deptId: deptParam ?? "ALL", rows: rows.length });
  const ascii = deptLabel
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .replace(/\s+/g, "-");
  const utf8 = encodeURIComponent(`DalatHasfarm-${deptLabel}-${from}_${to}.xlsx`);

  return new NextResponse(Buffer.from(buffer as ArrayBuffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="DalatHasfarm-${ascii}-${from}_${to}.xlsx"; filename*=UTF-8''${utf8}`,
    },
  });
}
