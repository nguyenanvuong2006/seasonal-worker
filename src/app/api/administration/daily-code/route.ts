import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, dwCodeAssignments, dwCodes, dwData, employmentSessions } from "@/db/schema";
import { getUserScope, hasPermission, requirePermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { normalizePersonName } from "@/lib/person-name";
import { maskCccd } from "@/lib/daily-intake-workflow";
import { getDailyCodeRows, type DailyCodeStatusFilter } from "@/lib/daily-code-list";
import { parseOperationalDateRange } from "@/lib/date-range";
import { allocateDwCode, releaseDwCode } from "@/lib/dw-code-pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ADMINISTRATION — "Nhập mã công nhật" (mục VI).
 * Hàng chờ = lao động ĐÃ được Recruiter đưa vào DW Data (dw_imported_at IS NOT
 * NULL) trong ngày đang chọn. Mã số công nhật = dw_data.code (cột mirror được
 * giữ đồng bộ hoàn toàn với canonical pool sau Activation #3).
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

/** Per-item write outcome returned to the caller (UI + audit log). */
type RowResult = {
  dailyApplicationId: string;
  ok: boolean;
  reason: string;
  /** true = dw_codes + dw_code_assignments + dw_data.code all updated atomically. */
  canonical: boolean;
};

/**
 * POST-GO-LIVE CANONICAL DW CODE WRITER — Activation #3 complete.
 * -----------------------------------------------------------------------
 * BUSINESS CONTRACT (all paths enforced after canonical pool activation):
 *
 *   A. Unknown code (not in dw_codes)           → reject, zero writes
 *   B. RETIRED code                             → reject, zero writes
 *   C. ASSIGNED to THIS worker (same dwDataId)  → idempotent ok
 *   D. ASSIGNED to ANOTHER worker               → reject, zero writes
 *   E. AVAILABLE + valid active session         → canonical allocate
 *   F. AVAILABLE + no valid active session      → reject, zero writes
 *   G. Clear + active canonical assignment      → release via canonical
 *                                                 assignment's employmentSessionId
 *   H. Clear + no active canonical assignment   → mirror-clear only if
 *                                                 dw_data.code is already null
 *                                                 or confirmed non-canonical;
 *                                                 otherwise fail closed
 *
 * INVARIANTS ENFORCED:
 *   A. One worker ≤ one active DW assignment.
 *   B. One canonical code ≤ one active worker.
 *   C. AVAILABLE code has no active assignment.
 *   D. RETIRED codes never made AVAILABLE.
 *   I. No normal successful path may write dw_data.code independently
 *      from canonical state.
 *
 * Submit hàng loạt — idempotent per-item (never creates duplicate assignments).
 */
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

        // ── Pre-flight guards ──────────────────────────────────────────────
        if (!app || app.deletedAt) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Không tìm thấy hồ sơ." });
          continue;
        }
        if (!scopeAllowsDepartment(scope, app.deptId)) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Ngoài phạm vi dữ liệu được cấp." });
          continue;
        }
        // BLOCKER #1 — re-verify dwImportedAt at SERVER (never trust client-sent dwDataId alone)
        if (!app.dwImportedAt) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Chưa được Recruiter nhập vào DW Data." });
          continue;
        }
        if (app.dwId !== item.dwDataId) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Bản ghi DW Data không khớp — tải lại trang." });
          continue;
        }

        const submittedCode = item.code.trim();

        // ── CONTRACT G+H: CLEAR / RELEASE path ────────────────────────────
        if (!submittedCode) {
          // Source of truth: look up the active canonical assignment for THIS
          // dw_data row, not the employment session by dailyApplicationId.
          // This is safe even if the worker moved departments or the session
          // was created under a different dailyApplication linkage.
          const [activeAssignment] = await tx
            .select({ employmentSessionId: dwCodeAssignments.employmentSessionId })
            .from(dwCodeAssignments)
            .where(and(eq(dwCodeAssignments.dwDataId, item.dwDataId), isNull(dwCodeAssignments.releasedAt)))
            .limit(1);

          if (activeAssignment) {
            // Contract G — canonical release via the assignment's own session.
            await releaseDwCode(
              {
                employmentSessionId: activeAssignment.employmentSessionId,
                releasedBy: guard.session.username,
                releaseReason: "MANUAL_CORRECTION",
                note: "Xoá mã qua màn hình Nhập mã công nhật",
              },
              tx,
            );
            updated += 1;
            results.push({ dailyApplicationId: item.dailyApplicationId, ok: true, canonical: true, reason: "Đã xoá Mã số công nhật (canonical release)." });
            continue;
          }

          // Contract H — no active canonical assignment. Only permit mirror-clear
          // if the mirror is already null (safe noop) or confirmed non-canonical
          // (RETIRED/AVAILABLE in pool, or not in pool at all). Fail closed if
          // the mirror's code is currently ASSIGNED to a different worker.
          const [currentMirror] = await tx
            .select({ code: dwData.code })
            .from(dwData)
            .where(eq(dwData.id, item.dwDataId))
            .limit(1);

          if (!currentMirror || currentMirror.code === null) {
            // Already null — safe idempotent noop.
            results.push({ dailyApplicationId: item.dailyApplicationId, ok: true, canonical: true, reason: "Mã số công nhật đã trống (không thay đổi)." });
            continue;
          }

          // Mirror has a value. Verify it is not actively ASSIGNED to another worker.
          const [mirrorPoolRow] = await tx
            .select({ id: dwCodes.id, status: dwCodes.status })
            .from(dwCodes)
            .where(eq(dwCodes.code, currentMirror.code))
            .limit(1);

          if (mirrorPoolRow && mirrorPoolRow.status === "ASSIGNED") {
            // The code in the mirror is ASSIGNED in the pool but we found no
            // active assignment for THIS dwDataId — canonical ownership conflict.
            results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Mã trong hồ sơ đang thuộc lao động khác trong pool — không thể xoá (trạng thái không nhất quán, liên hệ Admin)." });
            continue;
          }

          // Mirror code is RETIRED, AVAILABLE, or not in pool — safe to clear
          // without affecting canonical ownership of any other worker.
          await tx
            .update(dwData)
            .set({ code: null, dailyCodeUpdatedAt: new Date(), dailyCodeUpdatedBy: guard.session.username })
            .where(eq(dwData.id, item.dwDataId));
          updated += 1;
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: true, canonical: true, reason: "Đã xoá Mã số công nhật." });
          continue;
        }

        // ── Canonical pool lookup for the submitted code string ────────────
        const [poolRow] = await tx
          .select()
          .from(dwCodes)
          .where(eq(dwCodes.code, submittedCode))
          .limit(1);

        // CONTRACT A — unknown code (not in pool) → fail closed.
        // After Activation #3 the canonical pool is the authoritative registry.
        // Any code not present in dw_codes is invalid and must never enter
        // dw_data.code independently.
        if (!poolRow) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Mã số công nhật không có trong hệ thống — kiểm tra lại mã badge." });
          continue;
        }

        // CONTRACT B — RETIRED codes are permanently protected.
        if (poolRow.status === "RETIRED") {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Mã số công nhật này đã bị thu hồi vĩnh viễn (RETIRED) và không thể tái sử dụng." });
          continue;
        }

        if (poolRow.status === "ASSIGNED") {
          // Look up whose active assignment this code belongs to.
          const [activeAssignment] = await tx
            .select({ dwDataId: dwCodeAssignments.dwDataId })
            .from(dwCodeAssignments)
            .where(and(eq(dwCodeAssignments.codeId, poolRow.id), isNull(dwCodeAssignments.releasedAt)))
            .limit(1);

          if (activeAssignment && activeAssignment.dwDataId === item.dwDataId) {
            // CONTRACT C — idempotent: already assigned to THIS worker. No-op.
            results.push({ dailyApplicationId: item.dailyApplicationId, ok: true, canonical: true, reason: "Mã số công nhật đã được gán (không thay đổi)." });
            continue;
          }
          // CONTRACT D — code is actively held by a DIFFERENT worker. Reject.
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Mã số công nhật này đang được gán cho lao động khác — không thể gán trùng." });
          continue;
        }

        // poolRow.status === "AVAILABLE" — attempt canonical claim.
        // First: ensure this worker does not already hold a different active code.
        const [existingWorkerAssignment] = await tx
          .select({ id: dwCodeAssignments.id })
          .from(dwCodeAssignments)
          .where(and(eq(dwCodeAssignments.dwDataId, item.dwDataId), isNull(dwCodeAssignments.releasedAt)))
          .limit(1);

        if (existingWorkerAssignment) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Lao động này đã có mã công nhật đang hoạt động — phải xoá mã cũ trước khi gán mã mới." });
          continue;
        }

        // Find the worker's active employment session to attach the assignment to.
        const [activeSession] = await tx
          .select({ id: employmentSessions.id, workerId: employmentSessions.workerId })
          .from(employmentSessions)
          .where(and(eq(employmentSessions.dailyApplicationId, app.id), isNull(employmentSessions.endDate)))
          .limit(1);

        // CONTRACT F — AVAILABLE code but no valid active session → reject.
        // Writing the mirror without a canonical assignment would recreate split-brain.
        if (!activeSession) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Lao động này chưa có phiên làm việc đang hoạt động — không thể gán mã canonical." });
          continue;
        }

        // CONTRACT E — canonical claim via allocateDwCode(specificCodeId).
        const allocResult = await allocateDwCode(
          {
            locationId: poolRow.locationId,
            workerId: activeSession.workerId,
            employmentSessionId: activeSession.id,
            dwDataId: item.dwDataId,
            assignedBy: guard.session.username,
            specificCodeId: poolRow.id,
          },
          tx,
        );

        if (!allocResult.ok) {
          // allocateDwCode re-validates under lock — surface the error clearly.
          const errorMsg: Record<string, string> = {
            WORKER_ALREADY_HAS_ACTIVE_CODE: "Lao động đã có mã khác đang hoạt động (phát hiện bởi canonical lock) — tải lại trang.",
            CODE_NOT_AVAILABLE: "Mã số công nhật vừa bị gán cho lao động khác (race condition) — tải lại trang.",
            CODE_NOT_FOUND: "Mã số công nhật không tồn tại trong pool — tải lại trang.",
            CODE_WRONG_LOCATION: "Mã số công nhật không thuộc địa điểm này — tải lại trang.",
            LOCATION_NOT_FOUND: "Cấu hình địa điểm không tìm thấy — liên hệ Admin.",
            LOCATION_INACTIVE: "Địa điểm này đang tạm ngưng cấp mã — liên hệ Admin.",
          };
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: errorMsg[allocResult.error] ?? `Lỗi canonical: ${allocResult.error}` });
          continue;
        }

        updated += 1;
        results.push({ dailyApplicationId: item.dailyApplicationId, ok: true, canonical: true, reason: "Đã cập nhật Mã số công nhật (canonical)." });
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
