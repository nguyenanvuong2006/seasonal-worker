import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, dwData } from "@/db/schema";
import { getUserScope, hasPermission, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { normalizePersonName } from "@/lib/person-name";
import { maskCccd } from "@/lib/daily-intake-workflow";
import { getDailyCodeRows, type DailyCodeStatusFilter } from "@/lib/daily-code-list";
import { parseOperationalDateRange } from "@/lib/date-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ADMINISTRATION — "Nhập mã công nhật" (mục VI).
 * Hàng chờ = lao động ĐÃ được Recruiter đưa vào DW Data (dw_imported_at IS NOT
 * NULL) trong ngày đang chọn. Mã số công nhật = dw_data.code (giữ nguyên
 * semantics đã audit — cột này đã được dùng làm mã định danh DW từ trước).
 * Hỗ trợ from/to (range) + deptId + q + status — CÙNG bộ filter với GET
 * /api/administration/daily-code/export để danh sách hiển thị và file xuất
 * luôn khớp nhau (theo đúng mẫu lib/meal-list.ts). Legacy `date=` vẫn được
 * hỗ trợ (from=to=date) — GLOBAL DATE RANGE STANDARDIZATION.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "ADMINISTRATION"], "administration.daily_code.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const rangeResult = parseOperationalDateRange(url.searchParams);
  if (!rangeResult.ok) return NextResponse.json({ error: rangeResult.error.code, message: rangeResult.error.message }, { status: 400 });
  const { range } = rangeResult;
  const deptId = url.searchParams.get("deptId") || null;
  const q = url.searchParams.get("q") || null;
  const status = (url.searchParams.get("status") as DailyCodeStatusFilter | null) || "ALL";

  const scope = await getUserScope(guard.session);
  if (deptId && !scopeAllowsDepartment(scope, deptId)) {
    return NextResponse.json({ error: "Ngoài phạm vi dữ liệu được cấp." }, { status: 403 });
  }

  const rows = await getDailyCodeRows(range, scope, { deptId, q, status });

  // BLOCKER #3 — ADMINISTRATION không có privacy.view_cccd theo baseline: KHÔNG
  // được trả CCCD đầy đủ mặc định, phải áp dụng đúng permission hiện có
  // (không tự phát minh cơ chế masking mới) — mục IX, X.
  const canViewCccd = await hasPermission(guard.session.role, "privacy.view_cccd");
  const mapped = rows.map((r) => ({
    ...r,
    fullName: normalizePersonName(r.fullName),
    cccd: maskCccd(r.cccd, canViewCccd) ?? r.cccd,
  }));

  return NextResponse.json({ rows: mapped, from: range.from, to: range.to });
}

type SubmitItem = { dailyApplicationId: string; dwDataId: string; code: string };
type RowResult = { dailyApplicationId: string; ok: boolean; reason: string };

/** Submit hàng loạt (mục VI) — idempotent (UPDATE theo id, không tạo bản ghi mới). */
export async function PATCH(req: Request) {
  const guard = await requirePermission(["ADMIN", "ADMINISTRATION"], "administration.daily_code.submit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const { items } = (await req.json()) as { items: SubmitItem[] };
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "Danh sách rỗng." }, { status: 400 });
    }
    if (items.length > 500) {
      return NextResponse.json({ error: "Vượt quá giới hạn! Mỗi lần chỉ được submit tối đa 500 dòng." }, { status: 429 });
    }

    const scope = await getUserScope(guard.session);
    const appIds = items.map((i) => i.dailyApplicationId);
    const apps = await db.select().from(dailyApplications).where(inArray(dailyApplications.id, appIds));
    const appById = new Map(apps.map((a) => [a.id, a]));

    const results: RowResult[] = [];
    let updated = 0;

    await db.transaction(async (tx) => {
      for (const item of items) {
        const app = appById.get(item.dailyApplicationId);
        if (!app || app.deletedAt) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, reason: "Không tìm thấy hồ sơ." });
          continue;
        }
        if (!scopeAllowsDepartment(scope, app.deptId)) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, reason: "Ngoài phạm vi dữ liệu được cấp." });
          continue;
        }
        // BLOCKER #1 — KHÔNG được tin theo dwDataId do client gửi lên (hoặc theo
        // việc GET đã lọc sẵn): PATCH phải tự kiểm tra lại "đã Nhập vào DW Data"
        // ở SERVER, vì dwId có thể đã tồn tại từ lúc đăng ký (người DW cũ khớp
        // CCCD) MÀ CHƯA từng qua hành động "Nhập vào DW Data" tường minh
        // (dwImportedAt vẫn NULL) — mục IV, VI.
        if (!app.dwImportedAt) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, reason: "Chưa được Recruiter nhập vào DW Data." });
          continue;
        }
        if (app.dwId !== item.dwDataId) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, reason: "Bản ghi DW Data không khớp — tải lại trang." });
          continue;
        }
        const code = item.code.trim() || null;
        await tx
          .update(dwData)
          .set({ code, dailyCodeUpdatedAt: new Date(), dailyCodeUpdatedBy: guard.session.username })
          .where(eq(dwData.id, item.dwDataId));
        updated += 1;
        results.push({ dailyApplicationId: item.dailyApplicationId, ok: true, reason: "Đã cập nhật Mã số công nhật." });
      }
    });

    await writeAudit(guard.session, "SUBMIT_DAILY_CODE", "dw_data", {
      updated,
      skipped: results.filter((r) => !r.ok).length,
      dailyApplicationIds: results.filter((r) => r.ok).map((r) => r.dailyApplicationId),
    });

    return NextResponse.json({ success: true, updated, skipped: results.filter((r) => !r.ok).length, results });
  } catch (error) {
    return NextResponse.json({ error: "Lỗi hệ thống: " + (error as Error).message }, { status: 500 });
  }
}
