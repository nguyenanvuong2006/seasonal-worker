import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, dwData, workerProfiles } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { normalizePersonName } from "@/lib/person-name";
import { decideDwImportAction } from "@/lib/daily-intake-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const MAX_BULK = 500;

type RowResult = { id: string; cccd: string | null; fullName: string | null; ok: boolean; reason: string };

/**
 * BƯỚC B — "Nhập vào DW Data" (mục IV trong đề bài): hành động RIÊNG BIỆT,
 * rõ ràng, tách khỏi "xếp việc" (POST /api/bulk-import). Chỉ xử lý hồ sơ đã
 * APPROVED (đã xếp việc xong). Idempotent theo daily_applications.dw_imported_at
 * (nguồn sự thật rõ nghĩa — KHÔNG suy diễn từ status/is_imported):
 *   - đã nhập rồi                -> bỏ qua, không tạo trùng
 *   - đã có dwId (người DW cũ)   -> chỉ LINK, không insert dòng dw_data mới
 *   - chưa có dwId (người mới)  -> INSERT 1 dòng dw_data mới
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "dw.import_from_registration");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const { ids } = (await req.json()) as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "Danh sách hồ sơ rỗng." }, { status: 400 });
    }
    if (ids.length > MAX_BULK) {
      return NextResponse.json({ error: `Vượt quá giới hạn! Mỗi lần chỉ được nhập tối đa ${MAX_BULK} lao động.` }, { status: 429 });
    }
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!ids.every((id) => typeof id === "string" && uuidRe.test(id))) {
      return NextResponse.json({ error: "Mã hồ sơ không hợp lệ." }, { status: 400 });
    }

    const scope = await getUserScope(guard.session);

    const result = await db.transaction(async (tx) => {
      const selected = await tx.select().from(dailyApplications).where(inArray(dailyApplications.id, ids));
      const allowed = scope === null ? selected : selected.filter((r) => scopeAllowsDepartment(scope, r.deptId));
      const foundIds = new Set(allowed.map((r) => r.id));

      const results: RowResult[] = [];
      for (const id of ids) {
        if (!foundIds.has(id)) {
          results.push({ id, cccd: null, fullName: null, ok: false, reason: "Không tìm thấy hồ sơ trong phạm vi dữ liệu được cấp." });
        }
      }

      let insertedCount = 0;
      let linkedCount = 0;
      const processedIds: string[] = [];

      for (const app of allowed) {
        const decision = decideDwImportAction({ status: app.status, dwImportedAt: app.dwImportedAt, dwId: app.dwId });

        if (decision.action === "SKIP_NOT_APPROVED") {
          results.push({ id: app.id, cccd: app.cccd, fullName: normalizePersonName(app.fullName), ok: false, reason: decision.reason });
          continue;
        }
        if (decision.action === "SKIP_ALREADY_IMPORTED") {
          results.push({ id: app.id, cccd: app.cccd, fullName: normalizePersonName(app.fullName), ok: false, reason: decision.reason });
          continue;
        }

        let dwId: string;
        if (decision.action === "INSERT_NEW") {
          // onConflictDoUpdate trên cccd: nếu 1 request đồng thời/retry đã tạo dòng dw_data cho
          // đúng CCCD này giữa lúc query & insert, trả về DÒNG ĐÃ CÓ thay vì tạo bản ghi thứ hai
          // (mục IV — "người DW cũ không bị duplicate, người mới mới được insert").
          const [row] = await tx
            .insert(dwData)
            .values({
              fullName: normalizePersonName(app.fullName),
              gender: app.gender,
              bod: app.dob,
              cccd: app.cccd,
              phone: app.phone,
              permanentAddress: app.permanentAddress,
              residentialAddress: app.residentialAddress,
              source: "Đăng ký thời vụ (Portal)",
              profile: "Tự đăng ký online",
            })
            .onConflictDoUpdate({
              target: dwData.cccd,
              targetWhere: sql`deleted_at is null`,
              set: { fullName: sql`excluded.full_name` },
            })
            .returning({ id: dwData.id });
          dwId = row.id;
          insertedCount += 1;
          await tx.update(workerProfiles).set({ dwId }).where(and(eq(workerProfiles.cccd, app.cccd), isNull(workerProfiles.deletedAt)));
        } else {
          dwId = decision.dwId;
          linkedCount += 1;
        }

        await tx
          .update(dailyApplications)
          .set({
            dwId,
            dwMatch: "MATCHED",
            dwImportedAt: new Date(),
            dwImportedBy: guard.session.username,
            updatedAt: new Date(),
          })
          .where(eq(dailyApplications.id, app.id));

        processedIds.push(app.id);
        results.push({
          id: app.id,
          cccd: app.cccd,
          fullName: normalizePersonName(app.fullName),
          ok: true,
          reason: decision.action === "INSERT_NEW" ? "Đã thêm mới vào DW Data" : "Đã liên kết với hồ sơ DW Data đã có",
        });
      }

      return { inserted: insertedCount, linked: linkedCount, results, processedIds };
    });

    await writeAudit(guard.session, "IMPORT_TO_DW_DATA", "dw_data", {
      inserted: result.inserted,
      linked: result.linked,
      skipped: result.results.filter((r) => !r.ok).length,
      processedIds: result.processedIds,
    });

    return NextResponse.json({
      success: true,
      inserted: result.inserted,
      linked: result.linked,
      skipped: result.results.filter((r) => !r.ok).length,
      results: result.results,
    });
  } catch (error) {
    return NextResponse.json({ error: "Lỗi hệ thống: " + (error as Error).message }, { status: 500 });
  }
}
