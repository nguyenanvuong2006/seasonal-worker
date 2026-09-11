import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { workforceMovements } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { movementScopeVisibility } from "@/lib/data-scope";
import { applyMovementAction } from "@/lib/workforce-movements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BATCH_SIZE = 100;

type BulkOutcome = "APPROVED" | "ALREADY_APPROVED" | "NO_LONGER_ELIGIBLE" | "OUT_OF_SCOPE" | "FAILED";

/**
 * Xác nhận thuyên chuyển đã đến bộ phận đích HÀNG LOẠT (final-project-hardening —
 * PR #187 deferred this until the effective-date lifecycle behavior was proven safe
 * in Production, which has since happened: migrated, reconciled, tested, verified).
 * Same skeleton as bulk-approve-resignation/route.ts — same permission, same
 * MAX_BATCH_SIZE, same sequential per-id loop, same idempotency (re-derived from
 * applyMovementAction()'s own row lock + isActionAllowed() re-check), same partial-
 * success result shape. NO new lifecycle engine — every id still goes through the
 * exact same applyMovementAction(..., "CONFIRM_ARRIVED") the single-item route uses
 * (finalizeTransferEffect(): moves employment_sessions.deptId, mirrors
 * daily_applications.deptId, closes the old request's allocation, auto-allocates
 * Planning for the destination department).
 *
 * Two differences from bulk resignation, both mechanical, not new product decisions:
 *   1. Eligibility accepts movementType="transfer" with status PENDING_HR OR
 *      TRANSFER_RESCHEDULED (mirrors ALLOWED_ACTIONS in workforce-movements.ts —
 *      RESCHEDULE can put a transfer back into a still-CONFIRM_ARRIVED-eligible
 *      state), terminal/already-done state is TRANSFER_COMPLETED (resignation's
 *      is INACTIVE).
 *   2. Data Scope accepts FULL or REDACTED_INCOMING visibility (a manager scoped
 *      only to the DESTINATION department can confirm arrival there — the exact
 *      same rule PATCH /api/workforce-movements/[id] already applies for
 *      CONFIRM_ARRIVED) — resignation's bulk route only ever needed FULL because
 *      resignation has no "destination-only" visibility case.
 *
 * The destination department is already fixed on the movement record (toDeptId,
 * set when the transfer was created) — bulk approval never picks/decides one.
 */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "workforce_movements.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let body: { requestIds?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Thiếu danh sách yêu cầu." }, { status: 400 });
  }
  const rawIds = Array.isArray(body.requestIds)
    ? body.requestIds.filter((v): v is string => typeof v === "string" && v.length > 0)
    : null;
  if (!rawIds || rawIds.length === 0) {
    return NextResponse.json({ error: "Chưa chọn yêu cầu nào để xác nhận." }, { status: 400 });
  }
  const ids = [...new Set(rawIds)];
  if (ids.length > MAX_BATCH_SIZE) {
    return NextResponse.json({ error: `Chỉ được xác nhận tối đa ${MAX_BATCH_SIZE} yêu cầu trong 1 lần.` }, { status: 400 });
  }

  const scope = await getUserScope(guard.session);
  const bulkOperationId = randomUUID();

  const rows = await db
    .select({
      id: workforceMovements.id,
      movementType: workforceMovements.movementType,
      status: workforceMovements.status,
      fromDeptId: workforceMovements.fromDeptId,
      toDeptId: workforceMovements.toDeptId,
    })
    .from(workforceMovements)
    .where(inArray(workforceMovements.id, ids));
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const results: { id: string; outcome: BulkOutcome; reason?: string }[] = [];

  // Tuần tự — mỗi applyMovementAction() tự mở transaction + row lock riêng.
  for (const id of ids) {
    const row = rowById.get(id);
    if (!row || row.movementType !== "transfer") {
      results.push({ id, outcome: "NO_LONGER_ELIGIBLE" });
      continue;
    }
    const visibility = movementScopeVisibility(scope, row.movementType, row.fromDeptId, row.toDeptId);
    if (visibility !== "FULL" && visibility !== "REDACTED_INCOMING") {
      results.push({ id, outcome: "OUT_OF_SCOPE" });
      continue;
    }
    if (row.status === "TRANSFER_COMPLETED") {
      results.push({ id, outcome: "ALREADY_APPROVED" });
      continue;
    }
    if (row.status !== "PENDING_HR" && row.status !== "TRANSFER_RESCHEDULED") {
      results.push({ id, outcome: "NO_LONGER_ELIGIBLE" });
      continue;
    }

    try {
      const { spawnedResignationId } = await applyMovementAction(guard.session, id, "CONFIRM_ARRIVED", {});
      await writeAudit(guard.session, "WORKFORCE_MOVEMENT_CONFIRM_ARRIVED", "workforce_movements", {
        id,
        spawnedResignationId,
        bulkOperationId,
      });
      results.push({ id, outcome: "APPROVED" });
    } catch (error) {
      results.push({ id, outcome: "FAILED", reason: (error as Error).message });
    }
  }

  return NextResponse.json({
    bulkOperationId,
    requested: ids.length,
    approved: results.filter((r) => r.outcome === "APPROVED").length,
    alreadyApproved: results.filter((r) => r.outcome === "ALREADY_APPROVED").length,
    outOfScope: results.filter((r) => r.outcome === "OUT_OF_SCOPE").length,
    noLongerEligible: results.filter((r) => r.outcome === "NO_LONGER_ELIGIBLE").length,
    failed: results.filter((r) => r.outcome === "FAILED").length,
    results,
  });
}
