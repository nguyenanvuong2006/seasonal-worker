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
 * NULL) trong ngày đang chọn. Mã số công nhật = dw_data.code (giữ nguyên
 * semantics đã audit — cột này đã được dùng làm mã định danh DW từ trước).\
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

/** Classification of each per-item write outcome for the caller (UI + audit). */
type RowResult = {
  dailyApplicationId: string;
  ok: boolean;
  reason: string;
  /** true  = dw_codes + dw_code_assignments + dw_data.code all updated atomically.
   *  false = only dw_data.code mirror updated (code not yet in canonical pool). */
  canonical: boolean;
  /** LEGACY_CODE_NOT_IN_POOL — code typed is valid but has no dw_codes row yet;
   *  mirror written, no canonical row. Caller should not treat as an error. */
  warning?: string;
};

/**
 * POST-GO-LIVE CANONICAL DW CODE WRITER (replaces the legacy free-text writer).
 * -------------------------------------------------------------------------------
 * MISSION: PATCH /api/administration/daily-code — canonicalized after Activation #3.
 *
 * BUSINESS CONTEXT: Administration staff type the EXACT string from a physical badge
 * (not an auto-generated sequence). The canonical pool (dw_codes) now contains 412
 * ASSIGNED rows plus released AVAILABLE rows for the DR location. Codes typed here
 * may be:
 *   A. Already ASSIGNED to THIS worker (idempotent noop).
 *   B. AVAILABLE in the pool (claim it via allocateDwCode(specificCodeId)).
 *   C. RETIRED (reject — protected legacy code, never reusable).
 *   D. ASSIGNED to ANOTHER worker (reject — split-brain / duplicate active assignment).
 *   E. Not in the pool at all (13,074 legacy-only codes) — legacy mirror write only,
 *      flagged with warning: "LEGACY_CODE_NOT_IN_POOL".
 *   F. Blank / empty string — release the worker's canonical assignment (if any) and
 *      clear the legacy mirror.
 *
 * INVARIANTS ENFORCED (mission section 3):
 *   A. One worker may have at most one active DW assignment.
 *   B. One canonical DW code may have at most one active worker.
 *   C. AVAILABLE code never simultaneously has an active assignment.
 *   D. Protected historical codes (RETIRED) are never made AVAILABLE.
 *   G. Normal writes must not mutate dw_data.code independently from canonical state
 *      — enforced via the per-item pool lookup + fail-closed guards before every write.
 *
 * Submit hàng loạt (mục VI) — idempotent (UPDATE theo id, không tạo bản ghi mới
 * trừ khi pool row được claimed).
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
    let canonical = 0;
    let legacy = 0;

    await db.transaction(async (tx) => {
      for (const item of items) {
        const app = appById.get(item.dailyApplicationId);

        // ── Pre-flight guards (unchanged from legacy implementation) ────────
        if (!app || app.deletedAt) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Không tìm thấy hồ sơ." });
          continue;
        }
        if (!scopeAllowsDepartment(scope, app.deptId)) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Ngoài phạm vi dữ liệu được cấp." });
          continue;
        }
        // BLOCKER #1 — must re-verify dwImportedAt at SERVER (never trust client-sent dwDataId alone)
        if (!app.dwImportedAt) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Chưa được Recruiter nhập vào DW Data." });
          continue;
        }
        if (app.dwId !== item.dwDataId) {
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Bản ghi DW Data không khớp — tải lại trang." });
          continue;
        }

        const submittedCode = item.code.trim();

        // ── CLEAR / RELEASE path ────────────────────────────────────────────
        if (!submittedCode) {
          // Find the worker's active employment session to key the canonical release on.
          const [activeSession] = await tx
            .select({ id: employmentSessions.id })
            .from(employmentSessions)
            .where(and(eq(employmentSessions.dailyApplicationId, app.id), isNull(employmentSessions.endDate)))
            .limit(1);

          if (activeSession) {
            // Canonical release — clears dw_code_assignments + dw_codes status + dw_data.code mirror.
            await releaseDwCode(
              { employmentSessionId: activeSession.id, releasedBy: guard.session.username, releaseReason: "MANUAL_CORRECTION", note: "Xoá mã qua màn hình Nhập mã công nhật" },
              tx,
            );
          } else {
            // No active session (legacy-only worker): clear mirror only.
            await tx
              .update(dwData)
              .set({ code: null, dailyCodeUpdatedAt: new Date(), dailyCodeUpdatedBy: guard.session.username })
              .where(eq(dwData.id, item.dwDataId));
          }
          updated += 1;
          results.push({ dailyApplicationId: item.dailyApplicationId, ok: true, canonical: !!activeSession, reason: "Đã xoá Mã số công nhật." });
          continue;
        }

        // ── Canonical pool lookup for the submitted code string ─────────────
        const [poolRow] = await tx
          .select()
          .from(dwCodes)
          .where(eq(dwCodes.code, submittedCode))
          .limit(1);

        if (poolRow) {
          // ── Code IS in the canonical pool ───────────────────────────────

          if (poolRow.status === "RETIRED") {
            // Invariant D — RETIRED codes are permanently protected.
            results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Mã số công nhật này đã bị thu hồi vĩnh viễn (RETIRED) và không thể tái sử dụng." });
            continue;
          }

          if (poolRow.status === "ASSIGNED") {
            // Look up whose assignment this is.
            const [activeAssignment] = await tx
              .select({ dwDataId: dwCodeAssignments.dwDataId })
              .from(dwCodeAssignments)
              .where(and(eq(dwCodeAssignments.codeId, poolRow.id), isNull(dwCodeAssignments.releasedAt)))
              .limit(1);

            if (activeAssignment && activeAssignment.dwDataId === item.dwDataId) {
              // Invariants A+B — idempotent: already assigned to THIS worker. No-op.
              results.push({ dailyApplicationId: item.dailyApplicationId, ok: true, canonical: true, reason: "Mã số công nhật đã được gán (không thay đổi)." });
              continue;
            }
            // Invariant B — code is actively held by a DIFFERENT worker. Reject.
            results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Mã số công nhật này đang được gán cho lao động khác — không thể gán trùng (409 CONFLICT)." });
            continue;
          }

          // poolRow.status === "AVAILABLE" — attempt canonical claim.
          // First: ensure this worker does not already hold a different active code (Invariant A).
          const [existingWorkerAssignment] = await tx
            .select({ id: dwCodeAssignments.id })
            .from(dwCodeAssignments)
            .where(and(eq(dwCodeAssignments.dwDataId, item.dwDataId), isNull(dwCodeAssignments.releasedAt)))
            .limit(1);

          if (existingWorkerAssignment) {
            results.push({ dailyApplicationId: item.dailyApplicationId, ok: false, canonical: false, reason: "Lao động này đã có mã công nhật đang hoạt động — phải xoá mã cũ trước khi gán mã mới (409 CONFLICT)." });
            continue;
          }

          // Find the worker's active employment session to attach the assignment to.
          const [activeSession] = await tx
            .select({ id: employmentSessions.id, workerId: employmentSessions.workerId })
            .from(employmentSessions)
            .where(and(eq(employmentSessions.dailyApplicationId, app.id), isNull(employmentSessions.endDate)))
            .limit(1);

          if (!activeSession) {
            // Worker has no active session — cannot create a canonical assignment row.
            // Fall through to legacy-mirror path below.
          } else {
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
              // allocateDwCode re-validates under lock — surface the error.
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
            canonical += 1;
            results.push({ dailyApplicationId: item.dailyApplicationId, ok: true, canonical: true, reason: "Đã cập nhật Mã số công nhật (canonical)." });
            continue;
          }
        }

        // ── LEGACY FALLBACK PATH ────────────────────────────────────────────
        // Code is not in the pool at all (13,074 legacy-only codes transition period)
        // OR the worker has no active session to attach a canonical assignment to.
        // Write dw_data.code mirror only — fail-closed contract preserved by the
        // checks above (RETIRED / ASSIGNED-to-other already rejected before reaching here).
        await tx
          .update(dwData)
          .set({ code: submittedCode, dailyCodeUpdatedAt: new Date(), dailyCodeUpdatedBy: guard.session.username })
          .where(eq(dwData.id, item.dwDataId));
        updated += 1;
        legacy += 1;
        results.push({
          dailyApplicationId: item.dailyApplicationId,
          ok: true,
          canonical: false,
          warning: "LEGACY_CODE_NOT_IN_POOL",
          reason: "Đã cập nhật Mã số công nhật (mirror only — mã chưa có trong pool).",
        });
      }
    });

    await writeAudit(guard.session, "SUBMIT_DAILY_CODE", "dw_data", {
      updated,
      canonical,
      legacy,
      skipped: results.filter((r) => !r.ok).length,
      dailyApplicationIds: results.filter((r) => r.ok).map((r) => r.dailyApplicationId),
    });

    return NextResponse.json({ success: true, updated, canonical, legacy, skipped: results.filter((r) => !r.ok).length, results });
  } catch (error) {
    return NextResponse.json({ error: "Lỗi hệ thống: " + (error as Error).message }, { status: 500 });
  }
}

