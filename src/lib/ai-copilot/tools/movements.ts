import "server-only";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { workerProfiles, workforceMovements } from "@/db/schema";
import { getUserScope } from "@/lib/auth";
import { movementScopeVisibility } from "@/lib/data-scope";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { capLimit } from "../scope-helpers.ts";

/**
 * Domain 5: Workforce movements (Nghỉ việc / Thuyên chuyển). No dedicated
 * read/list lib function exists (confirmed audit gap) — this reuses the
 * EXACT scope filter + movementScopeVisibility() redaction from
 * src/app/api/workforce-movements/route.ts's GET handler, never a new
 * visibility rule. CCCD is never selected at all (stricter than the route,
 * which redacts it per-row) — the AI surface has no legitimate need for it.
 */

const MAX_ROWS = 15;

type MovementDto = { movementType: string; status: string; effectiveDate: string; workerName: string | null };
type Result = {
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  preview: MovementDto[];
};

const MOVEMENT_STATUSES_HINT = "PENDING_HR | INACTIVE | REJECTED | TRANSFER_COMPLETED | TRANSFER_RESCHEDULED | WAITING_DECISION | CANCELLED (giá trị thực tế phụ thuộc workflow_stages đã cấu hình)";

const get_workforce_movements: ToolDefinition<{ status?: string; movementType?: string; limit?: number }, Result> = {
  name: "get_workforce_movements",
  description: `Lấy tổng hợp Nghỉ việc/Thuyên chuyển (workforce movements) theo trạng thái/loại, trong phạm vi Data Scope — trả về số lượng theo trạng thái/loại kèm một số dòng xem trước (không có CCCD). Trạng thái tham khảo: ${MOVEMENT_STATUSES_HINT}`,
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", description: "Lọc theo trạng thái cụ thể (tuỳ chọn)." },
      movementType: { type: "string", description: "RESIGNATION hoặc TRANSFER (tuỳ chọn)." },
      limit: { type: "number", description: "Số dòng xem trước tối đa (mặc định 15, tối đa 15)." },
    },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return {
      status: typeof body.status === "string" ? body.status.trim().slice(0, 40) : undefined,
      movementType: typeof body.movementType === "string" ? body.movementType.trim().slice(0, 24) : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<Result>> => {
    const scope = await getUserScope(ctx.session);
    const filters = [];
    if (args.status) filters.push(eq(workforceMovements.status, args.status));
    if (args.movementType) filters.push(eq(workforceMovements.movementType, args.movementType));
    if (scope !== null) {
      if (scope.length === 0) return { data: { byStatus: {}, byType: {}, preview: [] }, source: { domains: ["workforce_movements"], asOf: todayStr() } };
      filters.push(or(inArray(workforceMovements.fromDeptId, scope), inArray(workforceMovements.toDeptId, scope))!);
    }
    const rows = await db
      .select({
        movementType: workforceMovements.movementType,
        status: workforceMovements.status,
        effectiveDate: workforceMovements.effectiveDate,
        fromDeptId: workforceMovements.fromDeptId,
        toDeptId: workforceMovements.toDeptId,
        workerName: workerProfiles.fullName,
      })
      .from(workforceMovements)
      .leftJoin(workerProfiles, eq(workforceMovements.workerId, workerProfiles.id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(workforceMovements.createdAt))
      .limit(500);

    const visible = rows
      .map((row) => {
        const visibility = movementScopeVisibility(scope, row.movementType, row.fromDeptId, row.toDeptId);
        return { ...row, visibility };
      })
      .filter((row) => row.visibility !== "NONE");

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const row of visible) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      byType[row.movementType] = (byType[row.movementType] ?? 0) + 1;
    }

    const limit = capLimit(args.limit, MAX_ROWS, MAX_ROWS);
    const preview: MovementDto[] = visible.slice(0, limit).map((row) => ({
      movementType: row.movementType,
      status: row.status,
      effectiveDate: row.effectiveDate,
      workerName: row.visibility === "FULL" ? normalizePersonName(row.workerName ?? "") || null : null,
    }));

    return {
      data: { byStatus, byType, preview },
      source: { domains: ["workforce_movements"], asOf: todayStr() },
      truncated: visible.length > limit,
      totalCount: visible.length,
    };
  },
};

export const movementTools = [get_workforce_movements];
