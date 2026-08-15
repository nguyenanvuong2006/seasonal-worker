import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSession, hasPermission, writeAudit } from "@/lib/auth";
import { formatDate, todayStr } from "@/lib/helpers";
import { parseAnalyticsFilters } from "@/lib/analytics-core";
import { getAnalyticsDetailRows, getDashboardAnalytics } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GREEN = "FF115830";
const LIGHT = "FFEFF6F0";

/**
 * GET /api/analytics/export?mode=summary|detailed&format=xlsx|csv&...(cùng bộ filter dashboard)
 *
 * - Cùng permission export hiện có (registrations.export) — không tạo permission mới.
 * - CÙNG filter + Data Scope với dashboard (đi qua getDashboardAnalytics/getAnalyticsDetailRows).
 * - Detailed: flat analytics dataset; CCCD chỉ xuất khi role có privacy.view_cccd.
 * - KHÔNG export password/hash/audit secrets — dataset chỉ gồm cột phân tích.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
  if (!(await hasPermission(session.role, "registrations.export"))) {
    return NextResponse.json({ error: "Tài khoản của bạn không có quyền Xuất dữ liệu." }, { status: 403 });
  }
  if (!(await hasPermission(session.role, "dashboard.view"))) {
    return NextResponse.json({ error: "Tài khoản của bạn không có quyền xem Dashboard." }, { status: 403 });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "detailed" ? "detailed" : "summary";
  const parsed = parseAnalyticsFilters(url.searchParams, todayStr());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const filters = parsed.filters;

  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Dalat Hasfarm Seasonal HR";
    wb.created = new Date();

    if (mode === "summary") {
      const a = await getDashboardAnalytics(session, filters);
      const ws = wb.addWorksheet("Analytics Summary");
      const title = ws.getCell("A1");
      ws.mergeCells("A1:D1");
      title.value = "DALAT HASFARM — WORKFORCE ANALYTICS SUMMARY";
      title.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
      title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
      ws.mergeCells("A2:D2");
      ws.getCell("A2").value = `Kỳ: ${formatDate(a.range.from)} – ${formatDate(a.range.to)} · So với: ${formatDate(a.range.previousFrom)} – ${formatDate(a.range.previousTo)}`;

      const add = (section: string, rows: (string | number | null)[][]) => {
        ws.addRow([]);
        const h = ws.addRow([section]);
        h.font = { bold: true, color: { argb: GREEN } };
        for (const r of rows) ws.addRow(r);
      };

      add("KPI", [
        ["Chỉ số", "Kỳ này", "Kỳ trước", "% thay đổi"],
        ["Đăng ký", a.kpis.applications.current, a.kpis.applications.previous, a.kpis.applications.changePct],
        ["Unique Workers", a.kpis.uniqueWorkers.current, a.kpis.uniqueWorkers.previous, a.kpis.uniqueWorkers.changePct],
        ["Người mới", a.kpis.newWorkers.current, a.kpis.newWorkers.previous, a.kpis.newWorkers.changePct],
        ["Người quay lại", a.kpis.returningWorkers.current, a.kpis.returningWorkers.previous, a.kpis.returningWorkers.changePct],
        ["Đã nhận việc", a.kpis.approved.current, a.kpis.approved.previous, a.kpis.approved.changePct],
        ["Bắt đầu làm", a.kpis.started.current, a.kpis.started.previous, a.kpis.started.changePct],
        ["Nhu cầu tuyển (Planning)", a.kpis.demand.current, null, null],
        ["Còn thiếu (Planning)", a.kpis.shortage.current, null, null],
      ]);

      add("Recruitment Funnel", [
        ["Bước", "Số lượng"],
        ...a.funnel.stages.map((s) => [s.label, s.count] as (string | number)[]),
        ["Tỷ lệ Đăng ký → Bắt đầu làm (%)", a.funnel.overallConversionPct],
      ]);

      add("Kênh giới thiệu", [
        ["Nguồn", "Đăng ký", "Đã nhận việc", "Bắt đầu làm", "Conversion (%)"],
        ...a.referralSources.map((r) => [r.source, r.applications, r.approved, r.started, r.conversionPct] as (string | number | null)[]),
      ]);

      if (a.planning) {
        add("Planning / Nhu cầu nhân lực", [
          ["Demand", a.planning.demand],
          ["Allocated", a.planning.allocated],
          ["Resigned", a.planning.resigned],
          ["Recruitment Needed", a.planning.recruitmentNeeded],
          ["Fill Rate (%)", a.planning.fillRatePct],
        ]);
        add("Thiếu hụt theo bộ phận", [
          ["Bộ phận", "Nhóm", "Demand", "Allocated", "Gap", "Fill Rate (%)"],
          ...a.planning.departments.map((d) => [d.deptName, d.groupName, d.demand, d.allocated, d.gap, d.fillRatePct] as (string | number)[]),
        ]);
      }

      add("Hiệu suất bộ phận", [
        ["Bộ phận", "Nhóm", "Đăng ký", "Đã nhận việc", "Bắt đầu làm", "Đang làm việc", "Còn thiếu"],
        ...a.departmentPerformance.map((d) => [d.deptName, d.groupName, d.registered, d.approved, d.started, d.currentWorkforce, d.shortage] as (string | number)[]),
      ]);

      add("Biến động nhân lực (đã hiệu lực trong kỳ)", [
        ["Nghỉ việc", a.movements.effective.resignations],
        ["Chuyển đến", a.movements.effective.transfersIn],
        ["Chuyển đi", a.movements.effective.transfersOut],
      ]);

      ws.columns.forEach((c) => (c.width = 26));
    } else {
      const canViewCccd = await hasPermission(session.role, "privacy.view_cccd");
      const rows = await getAnalyticsDetailRows(session, filters, { includeCccd: canViewCccd });
      const ws = wb.addWorksheet("Analytics Detail");
      const headers = rows.length > 0 ? Object.keys(rows[0]) : ["Không có dữ liệu trong kỳ"];
      const hr = ws.addRow(headers);
      hr.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
      });
      let i = 0;
      for (const r of rows) {
        const row = ws.addRow(headers.map((h) => r[h] ?? ""));
        if (i++ % 2 === 1) row.eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } }));
      }
      ws.columns.forEach((c) => (c.width = 20));
    }

    await writeAudit(session, "EXPORT_ANALYTICS", "analytics", { mode, from: filters.from, to: filters.to });

    const buffer = await wb.xlsx.writeBuffer();
    const fileName = `analytics_${mode}_${filters.from}_${filters.to}.xlsx`;
    return new NextResponse(Buffer.from(buffer as ArrayBuffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (error) {
    console.error("[analytics/export]", error);
    return NextResponse.json({ error: "Không thể xuất dữ liệu phân tích. Vui lòng thử lại." }, { status: 500 });
  }
}
