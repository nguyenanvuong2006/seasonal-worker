import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { candidateDocuments, dailyApplications, mergeJobs } from "@/db/schema";
import { getUserScope } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";
import { capLimit, intersectDepartmentFilter } from "../scope-helpers.ts";

/**
 * Domain 13/14: Candidate electronic-confirmation documents + Document Merge
 * jobs. Neither has a reusable, scope-aware summary lib function today
 * (confirmed audit gaps: the existing candidate-documents summary is
 * embedded inline in a route with NO Data Scope filtering at all; merge_jobs
 * has no department concept whatsoever). This adds the missing Data Scope
 * join for candidate_documents (via applicationId -> daily_applications.deptId,
 * exactly as the audit flags) and leaves merge_jobs unscoped (it genuinely
 * has no department field — a merge job can span arbitrary selected
 * records). Status vocabulary follows candidate-consent/lifecycle.ts exactly
 * — never invented here: GENERATING | READY | ISSUED | VIEWED | CONFIRMED |
 * REVOKED | SUPERSEDED | EXPIRED | FAILED.
 */

type ConfirmationSummaryResult = { total: number; byStatus: Record<string, number> };

const get_document_confirmation_summary: ToolDefinition<{ departmentId?: string }, ConfirmationSummaryResult> = {
  name: "get_document_confirmation_summary",
  description: "Tổng hợp trạng thái Xác nhận điện tử hồ sơ ứng viên (candidate documents: GENERATING/READY/ISSUED/VIEWED/CONFIRMED/REVOKED/SUPERSEDED/EXPIRED/FAILED), trong phạm vi Data Scope. KHÔNG trả về CCCD/SĐT/nội dung hồ sơ.",
  parameters: {
    type: "object",
    properties: { departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." } },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return { departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<ConfirmationSummaryResult>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    if (filter.departmentIds !== null && filter.departmentIds.length === 0) {
      return { data: { total: 0, byStatus: {} }, source: { domains: ["document_confirmation"], asOf: todayStr() } };
    }
    const conditions = [];
    if (filter.departmentIds !== null) conditions.push(inArray(dailyApplications.deptId, filter.departmentIds));
    const rows = await db
      .select({ status: candidateDocuments.status, count: sql<number>`count(*)` })
      .from(candidateDocuments)
      .innerJoin(dailyApplications, eq(candidateDocuments.applicationId, dailyApplications.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .groupBy(candidateDocuments.status);
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byStatus[r.status] = r.count;
      total += r.count;
    }
    return { data: { total, byStatus }, source: { domains: ["document_confirmation"], asOf: todayStr() } };
  },
};

type MergeJobDto = { status: string; engine: string; recordCount: number; completedCount: number; failedCount: number; progressPercent: number; createdAt: string };
type MergeJobResult = { byStatus: Record<string, number>; recentJobs: MergeJobDto[] };

const MAX_JOBS = 10;

const get_document_merge_job_status: ToolDefinition<{ limit?: number }, MergeJobResult> = {
  name: "get_document_merge_job_status",
  description: "Tổng hợp trạng thái các job Trộn tài liệu (Document Merge) gần đây theo trạng thái, kèm danh sách job gần nhất. Không có khái niệm bộ phận nên không lọc theo Data Scope.",
  parameters: {
    type: "object",
    properties: { limit: { type: "number", description: "Số job gần nhất cần xem (mặc định 10, tối đa 10)." } },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    return { limit: typeof body.limit === "number" ? body.limit : undefined };
  },
  execute: async (_ctx: ToolContext, args): Promise<ToolResult<MergeJobResult>> => {
    const limit = capLimit(args.limit, MAX_JOBS, MAX_JOBS);
    const rows = await db
      .select({
        status: mergeJobs.status,
        engine: mergeJobs.engine,
        recordCount: mergeJobs.recordCount,
        completedCount: mergeJobs.completedCount,
        failedCount: mergeJobs.failedCount,
        progressPercent: mergeJobs.progressPercent,
        createdAt: mergeJobs.createdAt,
      })
      .from(mergeJobs)
      .orderBy(desc(mergeJobs.createdAt))
      .limit(100);
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const recentJobs: MergeJobDto[] = rows.slice(0, limit).map((r) => ({
      status: r.status,
      engine: r.engine,
      recordCount: r.recordCount,
      completedCount: r.completedCount,
      failedCount: r.failedCount,
      progressPercent: r.progressPercent,
      createdAt: r.createdAt.toISOString(),
    }));
    return { data: { byStatus, recentJobs }, source: { domains: ["document_merge"], asOf: todayStr() }, truncated: rows.length > limit, totalCount: rows.length };
  },
};

export const documentTools = [get_document_confirmation_summary, get_document_merge_job_status];
