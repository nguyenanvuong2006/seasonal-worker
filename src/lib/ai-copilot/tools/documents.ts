import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { candidateDocuments, dailyApplications, mergeJobs, workerProfiles } from "@/db/schema";
import { getUserScope } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import {
  getElectronicConfirmationHistory,
  getExpiredUnconfirmedDocuments,
  getExpiringConfirmations,
  getPendingConfirmations,
  type ActionableConfirmationEntry,
  type ConfirmationHistoryEntry,
} from "@/lib/candidate-consent/confirmation-queries";
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

/* ============================================================
   ELECTRONIC CONFIRMATION — DEADLINE + HISTORY (2026-09-10 mission)
   ------------------------------------------------------------
   Four named, purpose-built tools — never a generic query tool — each a
   thin Data-Scope-enforcing wrapper around confirmation-queries.ts. Every
   tool re-resolves getUserScope(session) itself; a requested departmentId
   is only ever a NARROWING within that scope (intersectDepartmentFilter),
   never a way to widen it. Minimal PII: applicantFullName only — never
   CCCD/phone — matching get_document_confirmation_summary's own rule above.
   ============================================================ */

const MAX_CONFIRMATION_ROWS = 20;

const get_electronic_confirmation_history: ToolDefinition<{ workerId: string }, ConfirmationHistoryEntry[]> = {
  name: "get_electronic_confirmation_history",
  description:
    'Lấy TOÀN BỘ lịch sử Xác nhận điện tử của MỘT lao động theo workerId (định danh vận hành — dùng find_current_workers hoặc công cụ tra cứu lao động khác để lấy workerId trước, KHÔNG dùng CCCD), xuyên suốt mọi lần bắt đầu công việc (mỗi lần là một hồ sơ độc lập, không ghi đè). Trả về mới nhất trước. Không trả CCCD/SĐT trong kết quả.',
  parameters: {
    type: "object",
    properties: { workerId: { type: "string", description: "UUID của lao động (workerId) cần tra lịch sử." } },
    required: ["workerId"],
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
    if (!workerId) throw new ToolExecutionError("INVALID_ARGS", "Cần cung cấp workerId.");
    return { workerId };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<ConfirmationHistoryEntry[]>> => {
    const scope = await getUserScope(ctx.session);
    const [worker] = await db.select({ id: workerProfiles.id }).from(workerProfiles).where(eq(workerProfiles.id, args.workerId)).limit(1);
    if (!worker) return { data: [], source: { domains: ["document_confirmation"], asOf: todayStr() } };

    const history = await getElectronicConfirmationHistory(worker.id);
    if (history.length === 0 || scope === null) {
      return { data: history, source: { domains: ["document_confirmation"], asOf: todayStr() } };
    }
    if (scope.length === 0) {
      return { data: [], source: { domains: ["document_confirmation"], asOf: todayStr() } };
    }
    // Data Scope: keep only engagements whose application's department is in the caller's scope.
    const appIds = [...new Set(history.map((h) => h.applicationId))];
    const apps = await db.select({ id: dailyApplications.id, deptId: dailyApplications.deptId }).from(dailyApplications).where(inArray(dailyApplications.id, appIds));
    const deptByApp = new Map(apps.map((a) => [a.id, a.deptId]));
    const inScope = history.filter((h) => {
      const deptId = deptByApp.get(h.applicationId);
      return deptId !== undefined && deptId !== null && scope.includes(deptId);
    });
    return { data: inScope, source: { domains: ["document_confirmation"], asOf: todayStr() } };
  },
};

type ActionableArgs = { departmentId?: string; limit?: number };

function parseActionableArgs(raw: unknown): ActionableArgs {
  const body = (raw ?? {}) as Record<string, unknown>;
  return {
    departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined,
    limit: typeof body.limit === "number" ? body.limit : undefined,
  };
}

/** Same name-formatting convention every other worker-facing tool uses (movements.ts/workers.ts) — never a raw pass-through. */
function withNormalizedNames(rows: ActionableConfirmationEntry[]): ActionableConfirmationEntry[] {
  return rows.map((r) => ({ ...r, applicantFullName: normalizePersonName(r.applicantFullName) || r.applicantFullName }));
}

const get_pending_confirmations: ToolDefinition<ActionableArgs, ActionableConfirmationEntry[]> = {
  name: "get_pending_confirmations",
  description: "Danh sách hồ sơ Xác nhận điện tử đang ở trạng thái ĐÃ PHÁT HÀNH/ĐÃ XEM và VẪN CÒN TRONG HẠN xác nhận, trong phạm vi Data Scope. Sắp xếp theo hạn gần nhất trước.",
  parameters: {
    type: "object",
    properties: {
      departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." },
      limit: { type: "number", description: `Số dòng tối đa (mặc định ${MAX_CONFIRMATION_ROWS}).` },
    },
    additionalProperties: false,
  },
  parseArgs: parseActionableArgs,
  execute: async (ctx: ToolContext, args): Promise<ToolResult<ActionableConfirmationEntry[]>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const limit = capLimit(args.limit, MAX_CONFIRMATION_ROWS, MAX_CONFIRMATION_ROWS);
    const rows = withNormalizedNames(await getPendingConfirmations(filter.departmentIds, limit));
    return { data: rows, source: { domains: ["document_confirmation"], asOf: todayStr() } };
  },
};

type ExpiringArgs = ActionableArgs & { withinHours?: number };
const DEFAULT_EXPIRING_WINDOW_HOURS = 48;
const MAX_EXPIRING_WINDOW_HOURS = 14 * 24;

const get_expiring_confirmations: ToolDefinition<ExpiringArgs, ActionableConfirmationEntry[]> = {
  name: "get_expiring_confirmations",
  description: `Danh sách hồ sơ Xác nhận điện tử SẮP HẾT HẠN (còn trong hạn nhưng hạn xác nhận rơi vào N giờ tới, mặc định ${DEFAULT_EXPIRING_WINDOW_HOURS} giờ), trong phạm vi Data Scope. Sắp xếp theo hạn gần nhất trước — để nhân sự nhắc lao động xác nhận kịp thời.`,
  parameters: {
    type: "object",
    properties: {
      departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." },
      withinHours: { type: "number", description: `Cửa sổ thời gian tính bằng giờ (mặc định ${DEFAULT_EXPIRING_WINDOW_HOURS}, tối đa ${MAX_EXPIRING_WINDOW_HOURS}).` },
      limit: { type: "number", description: `Số dòng tối đa (mặc định ${MAX_CONFIRMATION_ROWS}).` },
    },
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const base = parseActionableArgs(raw);
    const body = (raw ?? {}) as Record<string, unknown>;
    return { ...base, withinHours: typeof body.withinHours === "number" ? body.withinHours : undefined };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<ActionableConfirmationEntry[]>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const limit = capLimit(args.limit, MAX_CONFIRMATION_ROWS, MAX_CONFIRMATION_ROWS);
    const withinHours = capLimit(args.withinHours, MAX_EXPIRING_WINDOW_HOURS, DEFAULT_EXPIRING_WINDOW_HOURS);
    const rows = withNormalizedNames(await getExpiringConfirmations(filter.departmentIds, withinHours, limit));
    return { data: rows, source: { domains: ["document_confirmation"], asOf: todayStr() } };
  },
};

const get_expired_unconfirmed_documents: ToolDefinition<ActionableArgs, ActionableConfirmationEntry[]> = {
  name: "get_expired_unconfirmed_documents",
  description: "Danh sách hồ sơ Xác nhận điện tử ĐÃ HẾT HẠN mà lao động chưa xác nhận (cần nhân sự liên hệ hoặc cấp lại hồ sơ mới), trong phạm vi Data Scope.",
  parameters: {
    type: "object",
    properties: {
      departmentId: { type: "string", description: "UUID bộ phận cần lọc (tuỳ chọn)." },
      limit: { type: "number", description: `Số dòng tối đa (mặc định ${MAX_CONFIRMATION_ROWS}).` },
    },
    additionalProperties: false,
  },
  parseArgs: parseActionableArgs,
  execute: async (ctx: ToolContext, args): Promise<ToolResult<ActionableConfirmationEntry[]>> => {
    const scope = await getUserScope(ctx.session);
    const filter = intersectDepartmentFilter(scope, args.departmentId);
    if (!filter.ok) throw new ToolExecutionError("FORBIDDEN", "Bộ phận yêu cầu nằm ngoài Data Scope của bạn.");
    const limit = capLimit(args.limit, MAX_CONFIRMATION_ROWS, MAX_CONFIRMATION_ROWS);
    const rows = withNormalizedNames(await getExpiredUnconfirmedDocuments(filter.departmentIds, limit));
    return { data: rows, source: { domains: ["document_confirmation"], asOf: todayStr() } };
  },
};

export const documentTools = [
  get_document_confirmation_summary,
  get_document_merge_job_status,
  get_electronic_confirmation_history,
  get_pending_confirmations,
  get_expiring_confirmations,
  get_expired_unconfirmed_documents,
];
