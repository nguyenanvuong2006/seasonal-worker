import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions, workerProfiles } from "@/db/schema";
import { getUserScope } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";
import { intersectDepartmentFilter } from "../scope-helpers.ts";

/**
 * Domain 7: Fingerprint / IT Code compliance. No standalone "workers missing
 * fingerprint code, independent of a single day's queue" query exists
 * (confirmed audit gap) — queries worker_profiles.fingerprintCode directly,
 * scoped to workers with an ACTIVE employment_sessions row (current
 * workforce), per the audit's own recommendation.
 */

type ComplianceResult = { totalActiveWorkers: number; withFingerprintCode: number; missingFingerprintCode: number; missingRate: number };

const get_fingerprint_compliance: ToolDefinition<{ departmentId?: string }, ComplianceResult> = {
  name: "get_fingerprint_compliance",
  description: "Đếm số lao động ĐANG LÀM VIỆC (ACTIVE) đã có mã vân tay (IT Code) và số còn thiếu, trong phạm vi Data Scope hoặc theo một bộ phận cụ thể. Dùng cho câu hỏi về tuân thủ vân tay.",
  parameters: {
    type: "object",
    properties: { departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." } },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return { departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<ComplianceResult>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    if (filter.departmentIds !== null && filter.departmentIds.length === 0) {
      return { data: { totalActiveWorkers: 0, withFingerprintCode: 0, missingFingerprintCode: 0, missingRate: 0 }, source: { domains: ["fingerprint"], asOf: todayStr() } };
    }
    const conditions = [eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate), isNull(workerProfiles.deletedAt)];
    if (filter.departmentIds !== null) conditions.push(inArray(employmentSessions.deptId, filter.departmentIds));
    const rows = await db
      .select({ hasCode: sql<boolean>`(${workerProfiles.fingerprintCode} is not null and ${workerProfiles.fingerprintCode} <> '')` })
      .from(employmentSessions)
      .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
      .where(and(...conditions));
    const withCode = rows.filter((r) => r.hasCode).length;
    const total = rows.length;
    return {
      data: { totalActiveWorkers: total, withFingerprintCode: withCode, missingFingerprintCode: total - withCode, missingRate: total > 0 ? Math.round(((total - withCode) / total) * 1000) / 10 : 0 },
      source: { domains: ["fingerprint"], asOf: todayStr() },
    };
  },
};

export const fingerprintTools = [get_fingerprint_compliance];
