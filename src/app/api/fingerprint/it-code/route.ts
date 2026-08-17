import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData, workerProfiles } from "@/db/schema";
import { getUserScope, hasPermission, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { normalizePersonName } from "@/lib/person-name";
import { todayStr } from "@/lib/helpers";
import { hasDailyCode, isEligibleForFingerprintQueue, maskCccd } from "@/lib/daily-intake-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FINGERPRINT_STAFF — "IT Code / Vân tay" (mục VIII).
 * Hàng chờ = lao động đã nhập DW Data VÀ đã có Mã số công nhật (dw_data.code).
 * IT CODE KHÔNG phải điều kiện của Meal/Merge/Employment — chỉ là ĐẦU RA của
 * chính màn này (mục IX, XV).
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "FINGERPRINT_STAFF"], "fingerprint.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayStr();
  const filter = url.searchParams.get("filter"); // ALL | MISSING | DONE

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
      dwImportedAt: dailyApplications.dwImportedAt,
      dwDataId: dwData.id,
      code: dwData.code,
      itCode: dwData.itCode,
      itCodeUpdatedAt: dwData.itCodeUpdatedAt,
      itCodeUpdatedBy: dwData.itCodeUpdatedBy,
    })
    .from(dailyApplications)
    .innerJoin(dwData, eq(dailyApplications.dwId, dwData.id))
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .where(and(...conditions))
    .orderBy(desc(dailyApplications.dwImportedAt));

  // BLOCKER #3 — FINGERPRINT_STAFF không có privacy.view_cccd theo baseline:
  // KHÔNG được trả CCCD đầy đủ mặc định — mục IX, X.
  const canViewCccd = await hasPermission(guard.session.role, "privacy.view_cccd");
  const eligible = rows
    .filter((r) => isEligibleForFingerprintQueue({ status: "APPROVED", dwImportedAt: r.dwImportedAt }, { code: r.code }))
    .map((r) => ({ ...r, fullName: normalizePersonName(r.fullName), cccd: maskCccd(r.cccd, canViewCccd) ?? r.cccd }));

  const finalRows =
    filter === "MISSING"
      ? eligible.filter((r) => !r.itCode)
      : filter === "DONE"
        ? eligible.filter((r) => !!r.itCode)
        : eligible;

  return NextResponse.json({ rows: finalRows, date });
}

type SubmitItem = { dailyApplicationId: string; dwDataId: string; itCode: string };
type RowResult = { dailyApplicationId: string; ok: boolean; reason: string };

/**
 * Submit hàng loạt IT CODE (mục VIII). Source of truth: dw_data.it_code.
 * Mirror sang worker_profiles.fingerprint_code (hồ sơ điện tử nhất quán) và
 * daily_applications.it_code (backward compatibility — chỉ mirror, không còn editable).
 */
export async function PATCH(req: Request) {
  const guard = await requirePermission(["ADMIN", "FINGERPRINT_STAFF"], "fingerprint.submit");
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
    const dwRows = await db.select().from(dwData).where(inArray(dwData.id, items.map((i) => i.dwDataId)));
    const dwById = new Map(dwRows.map((d) => [d.id, d]));

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
        // BLOCKER #2 — dwId có thể đã tồn tại từ lúc đăng ký (khớp CCCD) MÀ CHƯA
        // từng qua hành động "Nhập vào DW Data" tường minh (dwImportedAt vẫn
        // NULL). PATCH phải tự kiểm tra lại ở SERVER, không tin theo GET đã lọc
        // sẵn hay theo việc client gửi đúng dwDataId — mục IV, VIII.
        if (!app.dwImportedAt) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, reason: "Chưa được Recruiter nhập vào DW Data." });
          continue;
        }
        if (app.dwId !== item.dwDataId) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, reason: "Bản ghi DW Data không khớp — tải lại trang." });
          continue;
        }
        const dw = dwById.get(item.dwDataId);
        if (!dw || !hasDailyCode(dw)) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, reason: "Chưa có Mã số công nhật — không thể nhập IT CODE." });
          continue;
        }
        const itCode = item.itCode.trim() || null;

        await tx
          .update(dwData)
          .set({ itCode, itCodeUpdatedAt: new Date(), itCodeUpdatedBy: guard.session.username })
          .where(eq(dwData.id, item.dwDataId));
        await tx
          .update(workerProfiles)
          .set({ fingerprintCode: itCode, fingerprintStatus: itCode ? "DA_CAP" : "CHUA_CAP", updatedAt: new Date() })
          .where(and(eq(workerProfiles.cccd, app.cccd), isNull(workerProfiles.deletedAt)));
        // Mirror sang daily_applications.it_code — backward compatibility (chỉ mirror,
        // không còn là nguồn ghi — mục VIII).
        await tx.update(dailyApplications).set({ itCode, updatedAt: new Date() }).where(eq(dailyApplications.id, app.id));

        updated += 1;
        results.push({ dailyApplicationId: item.dailyApplicationId, ok: true, reason: "Đã cập nhật IT CODE." });
      }
    });

    await writeAudit(guard.session, "SUBMIT_IT_CODE", "dw_data", {
      updated,
      skipped: results.filter((r) => !r.ok).length,
      dailyApplicationIds: results.filter((r) => r.ok).map((r) => r.dailyApplicationId),
    });

    return NextResponse.json({ success: true, updated, skipped: results.filter((r) => !r.ok).length, results });
  } catch (error) {
    return NextResponse.json({ error: "Lỗi hệ thống: " + (error as Error).message }, { status: 500 });
  }
}
