import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import { getUserScope, hasPermission, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { normalizePersonName } from "@/lib/person-name";
import { todayStr } from "@/lib/helpers";
import { maskCccd } from "@/lib/daily-intake-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ADMINISTRATION — "Nhập mã công nhật" (mục VI).
 * Hàng chờ = lao động ĐÃ được Recruiter đưa vào DW Data (dw_imported_at IS NOT
 * NULL) trong ngày đang chọn. Mã số công nhật = dw_data.code (giữ nguyên
 * semantics đã audit — cột này đã được dùng làm mã định danh DW từ trước).
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "ADMINISTRATION"], "administration.daily_code.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayStr();

  const scope = await getUserScope(guard.session);
  const conditions = [
    eq(dailyApplications.regDate, date),
    isNull(dailyApplications.deletedAt),
    isNotNull(dailyApplications.dwImportedAt),
  ];
  if (scope !== null) {
    if (scope.length === 0) return NextResponse.json({ rows: [], date });
    conditions.push(inArray(dailyApplications.deptId, scope));
  }

  const rows = await db
    .select({
      dailyApplicationId: dailyApplications.id,
      cccd: dailyApplications.cccd,
      fullName: dailyApplications.fullName,
      deptId: dailyApplications.deptId,
      deptName: departments.deptName,
      groupName: departments.groupName,
      startingDate: dailyApplications.startingDate,
      dwImportedAt: dailyApplications.dwImportedAt,
      dwDataId: dwData.id,
      code: dwData.code,
      dailyCodeUpdatedAt: dwData.dailyCodeUpdatedAt,
      dailyCodeUpdatedBy: dwData.dailyCodeUpdatedBy,
    })
    .from(dailyApplications)
    .innerJoin(dwData, eq(dailyApplications.dwId, dwData.id))
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .where(and(...conditions))
    .orderBy(desc(dailyApplications.dwImportedAt));

  // BLOCKER #3 — ADMINISTRATION không có privacy.view_cccd theo baseline: KHÔNG
  // được trả CCCD đầy đủ mặc định, phải áp dụng đúng permission hiện có
  // (không tự phát minh cơ chế masking mới) — mục IX, X.
  const canViewCccd = await hasPermission(guard.session.role, "privacy.view_cccd");
  const mapped = rows.map((r) => ({
    ...r,
    fullName: normalizePersonName(r.fullName),
    cccd: maskCccd(r.cccd, canViewCccd) ?? r.cccd,
  }));

  return NextResponse.json({ rows: mapped, date });
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
