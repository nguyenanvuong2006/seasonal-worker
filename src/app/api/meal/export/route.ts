import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { requirePermission, getUserScope, hasPermission, writeAudit } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { getMealEligibleWorkers } from "@/lib/meal-list";
import { maskCccd } from "@/lib/daily-intake-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GREEN = "FF115830";
const LIGHT = "FFEFF6F0";

/**
 * MEAL_STAFF — "Xuất danh sách báo cơm" (mục IX). Server enforce điều kiện
 * (DW imported AND Mã số công nhật not null) — KHÔNG export toàn bộ Daily
 * Application rồi để người dùng tự lọc. Audit mỗi lần export.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "MEAL_STAFF"], "meal.export");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayStr();
  const scope = await getUserScope(guard.session);
  const canViewCccd = await hasPermission(guard.session.role, "privacy.view_cccd");

  const rows = await getMealEligibleWorkers(date, scope);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Dalat Hasfarm Seasonal HR";
  wb.created = new Date();
  const ws = wb.addWorksheet("Báo cơm", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 } });

  ws.mergeCells("A1:F1");
  ws.getCell("A1").value = `Danh sách báo cơm — ngày ${date}`;
  ws.getCell("A1").font = { bold: true, size: 14, color: { argb: GREEN } };

  const headers = ["STT", "Mã số công nhật", "Họ và tên", "CCCD", "Bộ phận", "Ngày nhận việc"];
  const headerRow = ws.getRow(3);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  headerRow.commit();

  rows.forEach((r, idx) => {
    const row = ws.getRow(idx + 4);
    row.values = [
      idx + 1,
      r.code ?? "",
      normalizePersonName(r.fullName),
      maskCccd(r.cccd, canViewCccd) ?? r.cccd,
      [r.deptName, r.groupName].filter(Boolean).join(" — "),
      r.startingDate ?? "",
    ];
    if (idx % 2 === 1) {
      for (let c = 1; c <= headers.length; c++) {
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
      }
    }
    row.commit();
  });

  ws.columns = [{ width: 6 }, { width: 18 }, { width: 28 }, { width: 16 }, { width: 26 }, { width: 16 }];
  ws.views = [{ state: "frozen", ySplit: 3 }];
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: headers.length } };

  const buffer = await wb.xlsx.writeBuffer();

  await writeAudit(guard.session, "EXPORT_MEAL_LIST", "daily_applications", {
    date,
    rows: rows.length,
    departmentScope: scope,
  }, "EXPORT");

  const ascii = "MealList";
  const utf8 = encodeURIComponent(`DalatHasfarm-BaoCom-${date}.xlsx`);

  return new NextResponse(Buffer.from(buffer as ArrayBuffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${ascii}-${date}.xlsx"; filename*=UTF-8''${utf8}`,
    },
  });
}
