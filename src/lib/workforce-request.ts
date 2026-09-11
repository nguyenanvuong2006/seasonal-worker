import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  dailyApplications,
  departments,
  employmentSessions,
  planningAllocations,
  planningPeriods,
  recruitmentRequests,
  requestAllocationHistory,
  requestAllocationOverrides,
  requestAllocations,
  requestComments,
  requestKpiCache,
  workerProfiles,
  workforceMovements,
  type RecruitmentRequest,
} from "@/db/schema";
import { getUserScope, hasPermission, writeAudit, type Session } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { isFemale, isMale, todayStr, toVNDateStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import {
  aggregateRequestKpis,
  classifyGender,
  computeRequestKpi,
  computeWarnings,
  isActiveEmploymentSession,
  planAllocation,
  resolveTotalRequest,
  type ActiveAllocationRef,
  type RequestKpi,
  type WarningDetail,
} from "@/lib/workforce-request-kpi";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/* ============================================================
   WORKFORCE REQUEST — SOURCE OF TRUTH SERVICE
   ------------------------------------------------------------
   Mọi KPI ở đây được TÍNH LẠI từ source data (query), không lưu
   số tổng hợp thủ công (mục 9):
     - Current Workforce = ACTIVE Employment Session + ACTIVE
       request allocation.
     - Quit            = RESIGNATION có hiệu lực THỰC SỰ (status=INACTIVE
       VÀ lifecycleAppliedAt IS NOT NULL — cùng invariant Transfer-Out,
       xem fetchQuitRows()) trong khoảng thời gian request, của worker
       TỪNG có allocation vào request.
     - Recruited       = pipeline Daily Application + Workflow
       (stage kết thúc "Đã nhận việc" — APPROVED).
     - Balance         = max(0, Request - Current + Quit) — công
       thức nằm trong workforce-request-kpi.ts (module thuần).
   request_kpi_cache CHỈ là cache có timestamp cho dashboard —
   KHÔNG bao giờ dùng để ra quyết định allocation (mục 9).
   ============================================================ */

/** Session đang thực sự ACTIVE tại thời điểm hiện tại (nguồn sự thật Employment). */
export function isSessionActiveNow(s: { status: string | null; endDate: string | null }): boolean {
  return isActiveEmploymentSession(s.status, s.endDate);
}

/**
 * MOVEMENT ATTRIBUTION WINDOW (follow-up correctness fix — post-PR#203 report):
 * [requestedDate|createdAt, endDate|null] — decides which Quit/Transfer-Out movements
 * belong to this request's HISTORY. This is deliberately NOT the same concept as
 * `expectedDate` ("Ngày cần nhân lực" — the staffing-need-by deadline used for sort/
 * planning/display; see recruitment-request-columns.ts and planning-recruitment-core.ts).
 * `expectedDate` is a TARGET, not a closing boundary — a movement that happens after
 * the staffing deadline but before the request actually closes is still this request's
 * history. `endDate` ("Ngày kết thúc yêu cầu") is the request's real closing date, the
 * SAME field resolveDefaultAsOf() already freezes historical KPI snapshots on, and the
 * same field the legacy resolveRequestQuitWindow() (recruitment-kpi.ts) already uses as
 * its window end. When endDate is null (request still open), movementInRequestWindow()
 * below caps purely by `asOf` instead — never invents a synthetic closing date here;
 * for historical (EXPIRED/COMPLETED/CANCELLED) requests missing endDate,
 * resolveDefaultAsOf() is what supplies that fallback asOf, not this function.
 */
export function requestWindow(r: {
  requestedDate: string | null;
  endDate: string | null;
  createdAt: Date;
}): { start: string; end: string | null } {
  const start = r.requestedDate ?? toVNDateStr(r.createdAt);
  return { start, end: r.endDate ?? null };
}

export function resolveTotalRequestOf(r: Pick<RecruitmentRequest, "maleRq" | "femaleRq" | "totalRequest">): number {
  return resolveTotalRequest(r.maleRq, r.femaleRq, r.totalRequest);
}

/** Ngày "hôm nay" (VN) — mọi so sánh as-of dùng chuỗi YYYY-MM-DD. */
export function todayDate(): string {
  return todayStr();
}

/* ============================================================
   DATA SCOPE (mục 11) — lọc theo department_id (FK); text fallback
   ============================================================ */
function requestScopeCondition(scope: string[] | null) {
  if (scope === null) return undefined;
  if (scope.length === 0) return sql`false`;
  const deptNamesSub = db
    .select({ deptName: departments.deptName })
    .from(departments)
    .where(inArray(departments.id, scope));
  return or(
    inArray(recruitmentRequests.departmentId, scope),
    and(isNull(recruitmentRequests.departmentId), inArray(recruitmentRequests.department, deptNamesSub)),
  )!;
}

/* ============================================================
   KPI — CURRENT WORKFORCE (mục 3)
   ============================================================ */
/**
 * Điều kiện "ACTIVE ngay bây giờ" (Current Workforce sống — mục 3) — dùng chung
 * cho cả truy vấn đếm (KPI) lẫn truy vấn chi tiết (getRequestDetail) để tránh
 * 2 nguồn logic khác nhau.
 */
function liveAllocationCondition(requestIds: string[]) {
  return and(
    inArray(requestAllocations.requestId, requestIds),
    eq(requestAllocations.status, "ACTIVE"),
    eq(employmentSessions.status, "APPROVED"),
    isNull(employmentSessions.endDate),
    isNull(workerProfiles.deletedAt),
  );
}

/**
 * Điều kiện "ACTIVE tại đúng thời điểm asOf" (Current/Closing Workforce lịch sử —
 * approved design mục 4/mục III): allocation đã bắt đầu trước/đúng asOf, chưa kết
 * thúc trước asOf (hoặc chưa kết thúc), employment session cũng còn hiệu lực tại
 * asOf. Dùng chung cho KPI đếm lẫn chi tiết — RQ đã EXPIRED/COMPLETED/CANCELLED
 * xem lại KHÔNG bị số realtime hôm nay làm trôi.
 */
function historicalAllocationCondition(requestIds: string[], asOf: string) {
  return and(
    inArray(requestAllocations.requestId, requestIds),
    sql`${requestAllocations.startedAt} < (${asOf}::date + interval '1 day')`,
    or(isNull(requestAllocations.endedAt), sql`${requestAllocations.endedAt} >= ${asOf}::date`)!,
    or(isNull(employmentSessions.endDate), sql`${employmentSessions.endDate} >= ${asOf}::date`)!,
    or(isNull(employmentSessions.startingDate), sql`${employmentSessions.startingDate} <= ${asOf}::date`)!,
    isNull(workerProfiles.deletedAt),
  );
}

async function fetchLiveAllocationRows(ex: Executor, requestIds: string[]) {
  return ex
    .select({
      id: requestAllocations.id,
      requestId: requestAllocations.requestId,
      workerId: requestAllocations.workerId,
      sessionId: requestAllocations.employmentSessionId,
      gender: workerProfiles.gender,
    })
    .from(requestAllocations)
    .innerJoin(employmentSessions, eq(requestAllocations.employmentSessionId, employmentSessions.id))
    .innerJoin(workerProfiles, eq(requestAllocations.workerId, workerProfiles.id))
    .where(liveAllocationCondition(requestIds));
}

async function fetchHistoricalAllocationRows(ex: Executor, requestIds: string[], asOf: string) {
  return ex
    .select({
      id: requestAllocations.id,
      requestId: requestAllocations.requestId,
      workerId: requestAllocations.workerId,
      sessionId: requestAllocations.employmentSessionId,
      gender: workerProfiles.gender,
    })
    .from(requestAllocations)
    .innerJoin(employmentSessions, eq(requestAllocations.employmentSessionId, employmentSessions.id))
    .innerJoin(workerProfiles, eq(requestAllocations.workerId, workerProfiles.id))
    .where(historicalAllocationCondition(requestIds, asOf));
}

/* ============================================================
   KPI — QUIT (mục 3): RESIGNATION INACTIVE của worker từng
   allocation vào request, trong khoảng thời gian request.
   ============================================================ */
export type QuitRow = {
  requestId: string;
  movementId: string;
  workerId: string;
  gender: string | null;
  effectiveDate: string;
  allocatedAt: Date;
};

async function fetchQuitRows(ex: Executor, requestIds: string[]): Promise<QuitRow[]> {
  return ex
    .select({
      requestId: requestAllocations.requestId,
      movementId: workforceMovements.id,
      workerId: requestAllocations.workerId,
      gender: workerProfiles.gender,
      effectiveDate: workforceMovements.effectiveDate,
      allocatedAt: requestAllocations.startedAt,
    })
    .from(requestAllocations)
    .innerJoin(workerProfiles, eq(requestAllocations.workerId, workerProfiles.id))
    .innerJoin(
      workforceMovements,
      and(
        eq(workforceMovements.workerId, requestAllocations.workerId),
        eq(workforceMovements.movementType, "resignation"),
        eq(workforceMovements.status, "INACTIVE"),
        // Follow-up correctness fix (post-Phase 2B report): status="INACTIVE" is
        // written immediately at HR approval time (applyMovementAction), which can
        // be BEFORE the resignation's effectiveDate — lifecycleAppliedAt is the ONLY
        // field that reflects the workforce effect having actually happened (same
        // invariant fetchTransferOutRows already uses). Without this gate, an
        // HR-approved-but-not-yet-effective resignation was counted as Quit too early.
        isNotNull(workforceMovements.lifecycleAppliedAt),
      ),
    )
    .where(inArray(requestAllocations.requestId, requestIds));
}

/**
 * Dùng chung cho Quit VÀ Transfer-out (Phase 2B mục 3.2, hardened by the follow-up
 * correctness fix above): movement chỉ được tính thuộc về 1 request nếu xảy ra TRONG
 * cửa sổ thời gian của request VÀ SAU khi worker đã được phân bổ vào request đó
 * (allocatedAt <= effectiveDate). Upper bound LUÔN là min(window.end, asOf) — asOf
 * là chặn cứng bắt buộc (không tính movement sau thời điểm đang quan sát, giữ lịch sử
 * bất biến kể cả khi asOf được override sớm hơn endDate), và window.end (nếu có) siết
 * chặt thêm khi request đã thực sự đóng trước asOf. window.end KHÔNG BAO GIỜ là
 * expectedDate (xem requestWindow()) — chỉ requestedDate/createdAt (start) và endDate
 * (end) mới quyết định biên độ lịch sử này.
 */
function movementInRequestWindow(
  row: { effectiveDate: string; allocatedAt: Date },
  window: { start: string; end: string | null },
  asOf: string,
): boolean {
  if (row.effectiveDate < window.start) return false;
  if (row.effectiveDate > asOf) return false;
  if (window.end !== null && row.effectiveDate > window.end) return false;
  if (toVNDateStr(row.allocatedAt) > row.effectiveDate) return false;
  return true;
}

/**
 * Final pre-merge review finding (BLOCKER, fixed pre-merge): fetchQuitRows()/
 * fetchTransferOutRows() JOIN request_allocations (EVERY historical row, any status)
 * to workforce_movements ON workerId alone — a worker who was allocated to the SAME
 * request more than once over time (ALLOCATE -> END -> REALLOCATE -> END, a legitimate
 * append-only sequence, e.g. via "Chuyển phân bổ DW" out and later back) produces ONE
 * JOIN ROW PER (allocation row × matching movement row), i.e. the SAME movement
 * duplicated once per qualifying allocation row. Without this dedup, one real
 * resignation/transfer event could be counted 2+ times into Quit/Transfer-Out KPI and
 * listed 2+ times in getRequestDetail()'s resignedWorkers/transferredWorkers (and thus
 * the Request Detail UI + Excel export). A movement belongs to a request AT MOST ONCE
 * regardless of how many of the worker's own allocation rows happen to satisfy the
 * window/allocatedAt check — so after windowing, collapse to one row per movementId.
 */
function dedupeByMovementId<T extends { movementId: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.movementId)) continue;
    seen.add(r.movementId);
    out.push(r);
  }
  return out;
}

/* ============================================================
   KPI — TRANSFER-OUT (Phase 2B mục 3.2, approved design mục 3):
   worker từng có allocation ở request này, sau đó có 1 TRANSFER đã
   THỰC SỰ CÓ HIỆU LỰC (lifecycleAppliedAt IS NOT NULL — KHÔNG chỉ dựa
   vào status='TRANSFER_COMPLETED', vì trạng thái đó được ghi ngay khi
   HR xác nhận, có thể SỚM HƠN effectiveDate thật — xem comment
   EFFECTIVE-DATE LIFECYCLE ở workforce-movements.ts).
   ============================================================ */
export type TransferOutRow = {
  requestId: string;
  movementId: string;
  workerId: string;
  gender: string | null;
  effectiveDate: string;
  allocatedAt: Date;
  fromDeptId: string | null;
  toDeptId: string | null;
};

async function fetchTransferOutRows(ex: Executor, requestIds: string[]): Promise<TransferOutRow[]> {
  return ex
    .select({
      requestId: requestAllocations.requestId,
      movementId: workforceMovements.id,
      workerId: requestAllocations.workerId,
      gender: workerProfiles.gender,
      effectiveDate: workforceMovements.effectiveDate,
      allocatedAt: requestAllocations.startedAt,
      fromDeptId: workforceMovements.fromDeptId,
      toDeptId: workforceMovements.toDeptId,
    })
    .from(requestAllocations)
    .innerJoin(workerProfiles, eq(requestAllocations.workerId, workerProfiles.id))
    .innerJoin(
      workforceMovements,
      and(
        eq(workforceMovements.workerId, requestAllocations.workerId),
        eq(workforceMovements.movementType, "transfer"),
        eq(workforceMovements.status, "TRANSFER_COMPLETED"),
        isNotNull(workforceMovements.lifecycleAppliedAt),
      ),
    )
    .where(inArray(requestAllocations.requestId, requestIds));
}

/* ============================================================
   KPI — RECRUITED + PIPELINE (mục 1): Daily Application + Workflow
   là source of truth Application/Screened/Interviewed/Recruited.
   Stage "Đã tuyển" = stage kết thúc APPROVED (workflow_stages isEnd).
   ============================================================ */
export const RECRUITED_STAGE = "APPROVED";

export type PipelineRow = {
  requestId: string | null;
  gender: string | null;
  status: string;
  submittedAt: Date;
};

async function fetchPipelineRows(ex: Executor, requestIds: string[]): Promise<(PipelineRow & { requestId: string })[]> {
  const rows = await ex
    .select({
      requestId: dailyApplications.requestId,
      gender: dailyApplications.gender,
      status: dailyApplications.status,
      submittedAt: dailyApplications.submittedAt,
    })
    .from(dailyApplications)
    .where(and(inArray(dailyApplications.requestId, requestIds), isNull(dailyApplications.deletedAt)));
  // SQL đã lọc request_id IN (...) nên request_id không thể null — ép kiểu để phần còn lại an toàn.
  return rows as (PipelineRow & { requestId: string })[];
}

function countGender(rows: { gender: string | null }[], pred: (g: string | null) => boolean): number {
  return rows.filter((r) => pred(r.gender)).length;
}

/* ============================================================
   BATCH KPI (mục 9 + 10 + 14) — as of date
   ============================================================ */
export type RequestRow = Pick<
  RecruitmentRequest,
  "id" | "maleRq" | "femaleRq" | "totalRequest" | "requestedDate" | "expectedDate" | "endDate" | "createdAt"
>;

export type AsOfResolver = (r: RequestRow) => string;

export async function batchComputeRequestKpis(
  requestRows: RequestRow[],
  asOf: string | AsOfResolver,
  executor: Executor = db,
): Promise<Map<string, RequestKpi>> {
  const result = new Map<string, RequestKpi>();
  if (requestRows.length === 0) return result;

  const ids = requestRows.map((r) => r.id);
  const resolver: AsOfResolver = typeof asOf === "string" ? () => asOf : asOf;
  const today = todayStr();

  // Chia theo asOf: live (hôm nay) dùng trạng thái HIỆN TẠI (chính xác tuyệt đối);
  // lịch sử dùng cửa sổ thời gian started_at/ended_at/starting_date/end_date (mục 14).
  const asOfMap = new Map(requestRows.map((r) => [r.id, resolver(r)]));
  const liveIds = requestRows.filter((r) => asOfMap.get(r.id) === today).map((r) => r.id);
  const histByAsOf = new Map<string, string[]>();
  for (const r of requestRows) {
    const a = asOfMap.get(r.id) ?? today;
    if (a === today) continue;
    const list = histByAsOf.get(a) ?? [];
    list.push(r.id);
    histByAsOf.set(a, list);
  }

  const allocRows = [
    ...(liveIds.length > 0 ? await fetchLiveAllocationRows(executor, liveIds) : []),
    ...(await Promise.all(
      [...histByAsOf.entries()].map(([asOfDate, histIds]) => fetchHistoricalAllocationRows(executor, histIds, asOfDate)),
    )).flat(),
  ];

  const [quitRows, transferRows, pipelineRows] = await Promise.all([
    fetchQuitRows(executor, ids),
    fetchTransferOutRows(executor, ids),
    fetchPipelineRows(executor, ids),
  ]);

  const allocByRequest = new Map<string, typeof allocRows>();
  for (const a of allocRows) {
    const list = allocByRequest.get(a.requestId) ?? [];
    list.push(a);
    allocByRequest.set(a.requestId, list);
  }
  const quitByRequest = new Map<string, QuitRow[]>();
  for (const q of quitRows) {
    const list = quitByRequest.get(q.requestId) ?? [];
    list.push(q);
    quitByRequest.set(q.requestId, list);
  }
  const transferByRequest = new Map<string, TransferOutRow[]>();
  for (const t of transferRows) {
    const list = transferByRequest.get(t.requestId) ?? [];
    list.push(t);
    transferByRequest.set(t.requestId, list);
  }
  const pipelineByRequest = new Map<string, PipelineRow[]>();
  for (const p of pipelineRows) {
    const list = pipelineByRequest.get(p.requestId) ?? [];
    list.push(p);
    pipelineByRequest.set(p.requestId, list);
  }

  for (const r of requestRows) {
    const asOfDate = asOfMap.get(r.id) ?? today;
    const allocs = allocByRequest.get(r.id) ?? [];
    const quits = dedupeByMovementId(
      (quitByRequest.get(r.id) ?? []).filter((q) => movementInRequestWindow(q, requestWindow(r), asOfDate)),
    );
    const transfers = dedupeByMovementId(
      (transferByRequest.get(r.id) ?? []).filter((t) => movementInRequestWindow(t, requestWindow(r), asOfDate)),
    );
    const pipeline = (pipelineByRequest.get(r.id) ?? []).filter((p) => toVNDateStr(p.submittedAt) <= asOfDate);

    const maleCurrent = countGender(allocs, isMale);
    const femaleCurrent = countGender(allocs, isFemale);
    const maleQuit = countGender(quits, isMale);
    const femaleQuit = countGender(quits, isFemale);
    const maleTransferOut = countGender(transfers, isMale);
    const femaleTransferOut = countGender(transfers, isFemale);
    const recruitedRows = pipeline.filter((p) => p.status === RECRUITED_STAGE);
    const maleRecruited = countGender(recruitedRows, isMale);
    const femaleRecruited = countGender(recruitedRows, isFemale);

    result.set(
      r.id,
      computeRequestKpi({
        maleRequest: r.maleRq,
        femaleRequest: r.femaleRq,
        totalRequest: resolveTotalRequestOf(r),
        maleCurrent,
        femaleCurrent,
        maleRecruited,
        femaleRecruited,
        maleQuit,
        femaleQuit,
        maleTransferOut,
        femaleTransferOut,
      }),
    );
  }

  return result;
}

/* ============================================================
   KPI CACHE (mục 9) — timestamp + recompute job; không phải source of truth
   ============================================================ */
export const KPI_CACHE_FRESH_MS = 5 * 60_000;

export async function readFreshRequestKpiCache(
  requestIds: string[],
  asOf: string,
): Promise<Map<string, { kpi: RequestKpi; computedAt: string }>> {
  if (requestIds.length === 0) return new Map();
  const minComputed = new Date(Date.now() - KPI_CACHE_FRESH_MS);
  const rows = await db
    .select()
    .from(requestKpiCache)
    .where(
      and(
        inArray(requestKpiCache.requestId, requestIds),
        eq(requestKpiCache.asOfDate, asOf),
        gte(requestKpiCache.computedAt, minComputed),
      ),
    );
  const map = new Map<string, { kpi: RequestKpi; computedAt: string }>();
  for (const row of rows) {
    map.set(row.requestId, {
      kpi: row.payload as unknown as RequestKpi,
      computedAt: row.computedAt.toISOString(),
    });
  }
  return map;
}

export async function storeRequestKpiCache(rows: { requestId: string; asOf: string; kpi: RequestKpi }[]) {
  if (rows.length === 0) return;
  await db
    .insert(requestKpiCache)
    .values(
      rows.map((r) => ({
        requestId: r.requestId,
        asOfDate: r.asOf,
        payload: r.kpi as unknown as Record<string, unknown>,
        computedAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: requestKpiCache.requestId,
      set: {
        asOfDate: sql`excluded.as_of_date`,
        payload: sql`excluded.payload`,
        computedAt: sql`excluded.computed_at`,
      },
    });
}

/** Recompute job (mục 9) — chạy qua Vercel Cron /api/cron/run. */
export async function recomputeRequestKpiCache(): Promise<number> {
  const rows = await db
    .select({
      id: recruitmentRequests.id,
      maleRq: recruitmentRequests.maleRq,
      femaleRq: recruitmentRequests.femaleRq,
      totalRequest: recruitmentRequests.totalRequest,
      requestedDate: recruitmentRequests.requestedDate,
      expectedDate: recruitmentRequests.expectedDate,
      endDate: recruitmentRequests.endDate,
      createdAt: recruitmentRequests.createdAt,
    })
    .from(recruitmentRequests)
    .where(isNull(recruitmentRequests.deletedAt));
  if (rows.length === 0) return 0;
  const kpis = await batchComputeRequestKpis(rows, todayStr());
  const payloads = rows
    .filter((r) => kpis.has(r.id))
    .map((r) => ({ requestId: r.id, asOf: todayStr(), kpi: kpis.get(r.id)! }));
  await storeRequestKpiCache(payloads);
  return payloads.length;
}

/* ============================================================
   LIST (mục 10, 11)
   ============================================================ */
export type WorkforceRequestRow = RecruitmentRequest & {
  deptName: string | null;
  kpi: RequestKpi;
  applications: { male: number; female: number; total: number };
  linkedPeriod: { id: string; status: string; startDate: string; endDate: string } | null;
};

export async function listWorkforceRequests(opts: {
  scope: string[] | null;
  status?: string;
  departmentId?: string;
  search?: string;
  asOf?: string | AsOfResolver;
  limit?: number;
}): Promise<WorkforceRequestRow[]> {
  const conditions = [isNull(recruitmentRequests.deletedAt)];
  const scopeCond = requestScopeCondition(opts.scope);
  if (scopeCond) conditions.push(scopeCond);
  if (opts.status) conditions.push(eq(recruitmentRequests.status, opts.status));
  if (opts.departmentId) conditions.push(eq(recruitmentRequests.departmentId, opts.departmentId));
  if (opts.search?.trim()) {
    const q = `%${opts.search.trim()}%`;
    conditions.push(
      or(
        sql`${recruitmentRequests.requestCode} ILIKE ${q}`,
        sql`${recruitmentRequests.requester} ILIKE ${q}`,
        sql`${recruitmentRequests.department} ILIKE ${q}`,
        sql`${recruitmentRequests.position} ILIKE ${q}`,
        sql`${recruitmentRequests.jobTitle} ILIKE ${q}`,
      )!,
    );
  }

  const rows = await db
    .select({
      request: recruitmentRequests,
      deptName: departments.deptName,
    })
    .from(recruitmentRequests)
    .leftJoin(departments, eq(recruitmentRequests.departmentId, departments.id))
    .where(and(...conditions))
    .orderBy(desc(recruitmentRequests.createdAt))
    .limit(opts.limit ?? 300);

  const requestRows = rows.map((r) => r.request);
  let asOfResolver: AsOfResolver;
  if (opts.asOf === undefined) {
    asOfResolver = () => todayStr();
  } else if (typeof opts.asOf === "function") {
    asOfResolver = opts.asOf;
  } else {
    asOfResolver = () => opts.asOf as string;
  }
  const kpis = await batchComputeRequestKpis(requestRows, asOfResolver);
  const pipeline = await fetchPipelineRows(db, requestRows.map((r) => r.id));

  const appByRequest = new Map<string, PipelineRow[]>();
  for (const p of pipeline) {
    const list = appByRequest.get(p.requestId) ?? [];
    list.push(p);
    appByRequest.set(p.requestId, list);
  }

  const linkedPeriods = await db
    .select({
      requestId: planningPeriods.requestId,
      id: planningPeriods.id,
      status: planningPeriods.status,
      startDate: planningPeriods.startDate,
      endDate: planningPeriods.endDate,
    })
    .from(planningPeriods)
    .where(inArray(planningPeriods.requestId, requestRows.map((r) => r.id)));
  const linkedByRequest = new Map<string, (typeof linkedPeriods)[number]>();
  for (const p of linkedPeriods) if (p.requestId) linkedByRequest.set(p.requestId, p);

  return rows.map((r) => {
    const asOfDate = asOfResolver(r.request);
    const apps = (appByRequest.get(r.request.id) ?? []).filter((p) => toVNDateStr(p.submittedAt) <= asOfDate);
    const linked = linkedByRequest.get(r.request.id);
    return {
      ...r.request,
      deptName: r.deptName ?? null,
      kpi:
        kpis.get(r.request.id) ??
        computeRequestKpi({
          maleRequest: r.request.maleRq,
          femaleRequest: r.request.femaleRq,
          totalRequest: resolveTotalRequestOf(r.request),
          maleCurrent: 0,
          femaleCurrent: 0,
          maleRecruited: 0,
          femaleRecruited: 0,
          maleQuit: 0,
          femaleQuit: 0,
          maleTransferOut: 0,
          femaleTransferOut: 0,
        }),
      applications: {
        male: countGender(apps, isMale),
        female: countGender(apps, isFemale),
        total: apps.length,
      },
      linkedPeriod: linked
        ? { id: linked.id, status: linked.status, startDate: linked.startDate, endDate: linked.endDate }
        : null,
    };
  });
}

/* ============================================================
   DETAIL (mục 10) — bao gồm drill-down + history + comments
   ============================================================ */
export type RequestDetail = {
  request: RecruitmentRequest & { deptName: string | null };
  kpi: RequestKpi;
  pipeline: { status: string; male: number; female: number; total: number }[];
  currentWorkers: {
    allocationId: string;
    workerId: string;
    workerName: string | null;
    cccd: string;
    gender: string | null;
    sessionId: string;
    deptName: string | null;
    allocatedAt: Date;
    allocatedBy: string;
  }[];
  resignedWorkers: {
    movementId: string;
    workerId: string;
    workerName: string | null;
    gender: string | null;
    effectiveDate: string;
    reason: string | null;
  }[];
  transferredWorkers: {
    movementId: string;
    workerId: string;
    workerName: string | null;
    gender: string | null;
    effectiveDate: string;
    fromDeptName: string | null;
    toDeptName: string | null;
    /** Request mà worker được allocate SAU khi rời request này — null nếu chưa
     *  ai chủ động allocate họ vào request nào (approved design mục 3: KHÔNG đoán). */
    destinationRequestId: string | null;
    destinationRequestCode: string | null;
  }[];
  history: {
    id: string;
    action: string;
    workerId: string;
    workerName: string | null;
    fromRequestId: string | null;
    toRequestId: string | null;
    reason: string | null;
    overrideConfirmed: boolean;
    changedBy: string;
    changedAt: Date;
  }[];
  overrides: (typeof requestAllocationOverrides.$inferSelect)[];
  comments: (typeof requestComments.$inferSelect)[];
  linkedPeriod: { id: string; status: string; startDate: string; endDate: string } | null;
};

export async function getRequestDetail(requestId: string, asOf?: string): Promise<RequestDetail | null> {
  const [row] = await db
    .select({ request: recruitmentRequests, deptName: departments.deptName })
    .from(recruitmentRequests)
    .leftJoin(departments, eq(recruitmentRequests.departmentId, departments.id))
    .where(and(eq(recruitmentRequests.id, requestId), isNull(recruitmentRequests.deletedAt)));
  if (!row) return null;

  const today = todayStr();
  const asOfResolved = asOf ?? today;
  const isLive = asOfResolved === today;

  const kpis = await batchComputeRequestKpis([row.request], asOfResolved);
  const kpi = kpis.get(requestId)!;

  const currentWorkersColumns = {
    allocationId: requestAllocations.id,
    workerId: requestAllocations.workerId,
    workerName: workerProfiles.fullName,
    cccd: workerProfiles.cccd,
    gender: workerProfiles.gender,
    sessionId: requestAllocations.employmentSessionId,
    deptName: departments.deptName,
    allocatedAt: requestAllocations.startedAt,
    allocatedBy: requestAllocations.allocatedBy,
  };
  const currentWorkersQuery = db
    .select(currentWorkersColumns)
    .from(requestAllocations)
    .innerJoin(employmentSessions, eq(requestAllocations.employmentSessionId, employmentSessions.id))
    .innerJoin(workerProfiles, eq(requestAllocations.workerId, workerProfiles.id))
    .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
    .where(
      isLive ? liveAllocationCondition([requestId]) : historicalAllocationCondition([requestId], asOfResolved),
    )
    .orderBy(requestAllocations.startedAt);

  const [pipeline, currentWorkers, quitRows, transferRows, history, overrides, comments, linkedPeriods] = await Promise.all([
    fetchPipelineRows(db, [requestId]),
    currentWorkersQuery,
    fetchQuitRows(db, [requestId]),
    fetchTransferOutRows(db, [requestId]),
    db
      .select({
        id: requestAllocationHistory.id,
        action: requestAllocationHistory.action,
        workerId: requestAllocationHistory.workerId,
        workerName: workerProfiles.fullName,
        fromRequestId: requestAllocationHistory.fromRequestId,
        toRequestId: requestAllocationHistory.toRequestId,
        reason: requestAllocationHistory.reason,
        overrideConfirmed: requestAllocationHistory.overrideConfirmed,
        changedBy: requestAllocationHistory.changedBy,
        changedAt: requestAllocationHistory.changedAt,
      })
      .from(requestAllocationHistory)
      .leftJoin(workerProfiles, eq(requestAllocationHistory.workerId, workerProfiles.id))
      .where(eq(requestAllocationHistory.requestId, requestId))
      .orderBy(desc(requestAllocationHistory.changedAt))
      .limit(200),
    db
      .select()
      .from(requestAllocationOverrides)
      .where(eq(requestAllocationOverrides.requestId, requestId))
      .orderBy(desc(requestAllocationOverrides.createdAt)),
    db.select().from(requestComments).where(eq(requestComments.requestId, requestId)).orderBy(requestComments.createdAt),
    db
      .select({
        id: planningPeriods.id,
        status: planningPeriods.status,
        startDate: planningPeriods.startDate,
        endDate: planningPeriods.endDate,
      })
      .from(planningPeriods)
      .where(eq(planningPeriods.requestId, requestId)),
  ]);

  const window = requestWindow(row.request);
  const resignedRaw = dedupeByMovementId(quitRows.filter((q) => movementInRequestWindow(q, window, asOfResolved)));
  const transferredRaw = dedupeByMovementId(transferRows.filter((t) => movementInRequestWindow(t, window, asOfResolved)));

  const workerIds = [...new Set([...resignedRaw, ...transferredRaw].map((r) => r.workerId))];
  const movementIds = [...new Set(resignedRaw.map((r) => r.movementId))];
  const deptIds = [
    ...new Set(transferredRaw.flatMap((t) => [t.fromDeptId, t.toDeptId].filter((d): d is string => !!d))),
  ];
  const [profiles, movements, transferDepts, nextAllocations] = await Promise.all([
    workerIds.length > 0
      ? db
          .select({ id: workerProfiles.id, fullName: workerProfiles.fullName })
          .from(workerProfiles)
          .where(inArray(workerProfiles.id, workerIds))
      : Promise.resolve([]),
    movementIds.length > 0
      ? db
          .select({ id: workforceMovements.id, reason: workforceMovements.reason })
          .from(workforceMovements)
          .where(inArray(workforceMovements.id, movementIds))
      : Promise.resolve([]),
    deptIds.length > 0
      ? db.select({ id: departments.id, deptName: departments.deptName }).from(departments).where(inArray(departments.id, deptIds))
      : Promise.resolve([]),
    // Destination request (nếu có) — request TIẾP THEO worker được CHỦ ĐỘNG allocate
    // sau khi rời request này (approved design mục 3: KHÔNG đoán theo department).
    workerIds.length > 0
      ? db
          .select({
            workerId: requestAllocations.workerId,
            requestId: requestAllocations.requestId,
            requestCode: recruitmentRequests.requestCode,
            startedAt: requestAllocations.startedAt,
          })
          .from(requestAllocations)
          .innerJoin(recruitmentRequests, eq(requestAllocations.requestId, recruitmentRequests.id))
          .where(and(inArray(requestAllocations.workerId, workerIds), ne(requestAllocations.requestId, requestId)))
          .orderBy(requestAllocations.startedAt)
      : Promise.resolve([]),
  ]);
  const nameMap = new Map(profiles.map((p) => [p.id, p.fullName]));
  const reasonMap = new Map(movements.map((m) => [m.id, m.reason]));
  const deptNameMap = new Map(transferDepts.map((d) => [d.id, d.deptName]));

  const resignedWorkers = resignedRaw.map((q) => ({
    movementId: q.movementId,
    workerId: q.workerId,
    workerName: normalizePersonName(nameMap.get(q.workerId) ?? "") || null,
    gender: q.gender,
    effectiveDate: q.effectiveDate,
    reason: reasonMap.get(q.movementId) ?? null,
  }));

  const transferredWorkers = transferredRaw.map((t) => {
    // Destination = phân bổ SỚM NHẤT của worker (ở request KHÁC) bắt đầu SAU khi
    // transfer này có hiệu lực — nếu chưa có, coi như "chưa phân bổ request đích".
    const destination = nextAllocations
      .filter((a) => a.workerId === t.workerId && toVNDateStr(a.startedAt) >= t.effectiveDate)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0];
    return {
      movementId: t.movementId,
      workerId: t.workerId,
      workerName: normalizePersonName(nameMap.get(t.workerId) ?? "") || null,
      gender: t.gender,
      effectiveDate: t.effectiveDate,
      fromDeptName: t.fromDeptId ? (deptNameMap.get(t.fromDeptId) ?? null) : null,
      toDeptName: t.toDeptId ? (deptNameMap.get(t.toDeptId) ?? null) : null,
      destinationRequestId: destination?.requestId ?? null,
      destinationRequestCode: destination?.requestCode ?? null,
    };
  });

  const pipelineStages = new Map<string, PipelineRow[]>();
  for (const p of pipeline) {
    const list = pipelineStages.get(p.status) ?? [];
    list.push(p);
    pipelineStages.set(p.status, list);
  }

  return {
    request: { ...row.request, deptName: row.deptName ?? null },
    kpi,
    pipeline: [...pipelineStages.entries()].map(([status, list]) => ({
      status,
      male: countGender(list, isMale),
      female: countGender(list, isFemale),
      total: list.length,
    })),
    currentWorkers: currentWorkers.map((w) => ({ ...w, workerName: normalizePersonName(w.workerName ?? "") || null })),
    resignedWorkers,
    transferredWorkers,
    history: history.map((h) => ({ ...h, workerName: normalizePersonName(h.workerName ?? "") || null })),
    overrides,
    comments,
    linkedPeriod: linkedPeriods[0]
      ? {
          id: linkedPeriods[0].id,
          status: linkedPeriods[0].status,
          startDate: linkedPeriods[0].startDate,
          endDate: linkedPeriods[0].endDate,
        }
      : null,
  };
}

/* ============================================================
   ALLOCATION SERVICE (mục 4, 5, 6, 15)
   ============================================================ */
export type AllocateOutcome = {
  results: {
    employmentSessionId: string;
    workerId: string;
    workerName: string;
    outcome: "ALLOCATED" | "REALLOCATED" | "ALREADY";
  }[];
  warnings: WarningDetail[];
  overridden: boolean;
};

export type AllocateErrorCode = "TOTAL_OVER_TARGET" | "INVALID" | "FORBIDDEN" | "NOT_FOUND";

function allocateError(message: string, code: AllocateErrorCode): never {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  throw e;
}

export async function allocateWorkersToRequest(input: {
  session: Session;
  requestId: string;
  employmentSessionIds: string[];
  reason?: string | null;
  override?: { confirmed: boolean; reason: string } | null;
}): Promise<AllocateOutcome> {
  const ids = [...new Set(input.employmentSessionIds)];
  if (ids.length === 0) allocateError("Chưa chọn lao động nào.", "INVALID");
  if (ids.length > 500) allocateError("Tối đa 500 lao động mỗi lần phân bổ.", "INVALID");

  const canOverride = await hasPermission(input.session.role, "planning.overallocate");
  if (input.override && !canOverride) {
    allocateError(
      "Tài khoản của bạn không có quyền planning.overallocate để phân bổ vượt tổng nhu cầu.",
      "FORBIDDEN",
    );
  }

  const txResult = await db.transaction(async (tx) => {
    // KHOÁ request — serialize các lần phân bổ đồng thời (mục 6 + test G).
    const [request] = await tx
      .select({
        id: recruitmentRequests.id,
        maleRq: recruitmentRequests.maleRq,
        femaleRq: recruitmentRequests.femaleRq,
        totalRequest: recruitmentRequests.totalRequest,
        deletedAt: recruitmentRequests.deletedAt,
        planningPeriodId: recruitmentRequests.planningPeriodId,
        departmentId: recruitmentRequests.departmentId,
      })
      .from(recruitmentRequests)
      .where(eq(recruitmentRequests.id, input.requestId))
      .for("update");
    if (!request || request.deletedAt) allocateError("Không tìm thấy Workforce Request.", "NOT_FOUND");

    // Data Scope: phải thấy được request mới được phân bổ (mục 11).
    const scope = await getUserScope(input.session);
    if (!scopeAllowsDepartment(scope, request.departmentId)) {
      allocateError("Workforce Request nằm ngoài Data Scope được cấp.", "NOT_FOUND");
    }

    // Employment Session phải thực sự ACTIVE (source of truth).
    const sessions = await tx
      .select({
        id: employmentSessions.id,
        workerId: employmentSessions.workerId,
        status: employmentSessions.status,
        endDate: employmentSessions.endDate,
        dailyApplicationId: employmentSessions.dailyApplicationId,
        workerName: workerProfiles.fullName,
        gender: workerProfiles.gender,
        workerDeletedAt: workerProfiles.deletedAt,
      })
      .from(employmentSessions)
      .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
      .where(inArray(employmentSessions.id, ids));

    if (sessions.length !== ids.length) {
      allocateError("Có Employment Session không tồn tại.", "INVALID");
    }
    for (const s of sessions) {
      if (!isSessionActiveNow({ status: s.status, endDate: s.endDate }) || s.workerDeletedAt) {
        allocateError(
          `Employment Session của "${normalizePersonName(s.workerName ?? "") || s.workerId}" không còn ACTIVE — chỉ phân bổ lao động đang thực sự ACTIVE.`,
          "INVALID",
        );
      }
    }

    // ACTIVE allocations hiện có: của request đích + của các worker liên quan.
    const existingRows = await tx
      .select({
        id: requestAllocations.id,
        requestId: requestAllocations.requestId,
        workerId: requestAllocations.workerId,
        sessionId: requestAllocations.employmentSessionId,
      })
      .from(requestAllocations)
      .where(
        and(
          eq(requestAllocations.status, "ACTIVE"),
          or(eq(requestAllocations.requestId, request.id), inArray(requestAllocations.workerId, sessions.map((s) => s.workerId))),
        ),
      );

    // Gender cho warning giới tính — đọc profile của mọi worker liên quan.
    const genderByWorker = new Map<string, string | null>();
    for (const s of sessions) genderByWorker.set(s.workerId, s.gender ?? null);
    const existingWorkerIds = [...new Set(existingRows.map((r) => r.workerId))];
    if (existingWorkerIds.length > 0) {
      const profiles = await tx
        .select({ id: workerProfiles.id, gender: workerProfiles.gender })
        .from(workerProfiles)
        .where(inArray(workerProfiles.id, existingWorkerIds));
      for (const p of profiles) genderByWorker.set(p.id, p.gender);
    }

    const allocsForRequest: ActiveAllocationRef[] = existingRows
      .filter((r) => r.requestId === request.id)
      .map((r) => ({
        id: r.id,
        requestId: r.requestId,
        workerId: r.workerId,
        sessionId: r.sessionId,
        gender: classifyGender(genderByWorker.get(r.workerId)),
      }));

    const totalRequest = resolveTotalRequestOf(request);
    const results: AllocateOutcome["results"] = [];
    let overridden = false;

    for (const s of sessions) {
      const existingForWorker = existingRows.find((r) => r.workerId === s.workerId) ?? null;
      const target = { sessionId: s.id, workerId: s.workerId, gender: classifyGender(s.gender ?? null) };

      const plan = planAllocation(
        {
          targetRequestId: request.id,
          totalRequest,
          maleRequest: request.maleRq,
          femaleRequest: request.femaleRq,
          allocations: allocsForRequest,
          existingForWorker: existingForWorker
            ? {
                ...existingForWorker,
                gender: classifyGender(genderByWorker.get(s.workerId)),
              }
            : null,
        },
        target,
        input.override ?? undefined,
      );

      if (plan.outcome === "REJECTED") {
        allocateError(plan.message, "TOTAL_OVER_TARGET");
      }
      if (plan.outcome === "NOOP") {
        results.push({
          employmentSessionId: s.id,
          workerId: s.workerId,
          workerName: normalizePersonName(s.workerName ?? "") || s.workerId,
          outcome: "ALREADY",
        });
        continue;
      }

      // 1) Kết thúc allocation cũ (re-allocate) — KHÔNG tạo Resignation, session vẫn ACTIVE.
      if (plan.existingForWorker) {
        await tx
          .update(requestAllocations)
          .set({
            status: "ENDED",
            endedAt: new Date(),
            endedBy: input.session.username,
            endReason: input.reason?.trim() || "Tái phân bổ sang Workforce Request khác",
            updatedAt: new Date(),
          })
          .where(eq(requestAllocations.id, plan.existingForWorker.id));
        await tx.insert(requestAllocationHistory).values({
          requestId: request.id,
          workerId: s.workerId,
          employmentSessionId: s.id,
          fromRequestId: plan.existingForWorker.requestId,
          toRequestId: request.id,
          action: plan.overrideApplied ? "OVERRIDE" : "REALLOCATE",
          reason: input.reason?.trim() || null,
          overrideConfirmed: plan.overrideApplied,
          changedBy: input.session.username,
        });
      }

      // 2) Tạo allocation mới. onConflict + partial unique index chống double-click/race (test G).
      const inserted = await tx
        .insert(requestAllocations)
        .values({
          employmentSessionId: s.id,
          workerId: s.workerId,
          requestId: request.id,
          status: "ACTIVE",
          allocatedBy: input.session.username,
        })
        .onConflictDoNothing({
          target: requestAllocations.workerId,
          where: sql`status = 'ACTIVE'`,
        })
        .returning({ id: requestAllocations.id });

      if (inserted.length === 0) {
        // Race/double-click: worker ĐÃ có ACTIVE allocation — kiểm tra xem có phải request này không.
        const [dupe] = await tx
          .select({ requestId: requestAllocations.requestId })
          .from(requestAllocations)
          .where(and(eq(requestAllocations.workerId, s.workerId), eq(requestAllocations.status, "ACTIVE")));
        if (dupe?.requestId === request.id) {
          results.push({
            employmentSessionId: s.id,
            workerId: s.workerId,
            workerName: normalizePersonName(s.workerName ?? "") || s.workerId,
            outcome: "ALREADY",
          });
          continue;
        }
        allocateError(
          "Lao động này vừa được phân bổ vào request khác bởi một thao tác đồng thời. Vui lòng thử lại.",
          "INVALID",
        );
      }

      if (!plan.existingForWorker) {
        await tx.insert(requestAllocationHistory).values({
          requestId: request.id,
          workerId: s.workerId,
          employmentSessionId: s.id,
          fromRequestId: null,
          toRequestId: request.id,
          action: plan.overrideApplied ? "OVERRIDE" : "ALLOCATE",
          reason: input.reason?.trim() || null,
          overrideConfirmed: plan.overrideApplied,
          changedBy: input.session.username,
        });
      }

      // 3) Override vượt tổng nhu cầu → log RIÊNG (mục 6 + 15).
      if (plan.overrideApplied) {
        overridden = true;
        await tx.insert(requestAllocationOverrides).values({
          requestId: request.id,
          workerId: s.workerId,
          changedBy: input.session.username,
          reason: (input.override?.reason ?? "").trim() || "Override phân bổ vượt tổng nhu cầu",
          confirmed: true,
          currentTotal: allocsForRequest.length,
          totalRequest,
        });
      }

      // 4) Pipeline: liên kết Daily Application gốc vào request (nếu chưa có).
      if (s.dailyApplicationId) {
        await tx
          .update(dailyApplications)
          .set({ requestId: request.id })
          .where(and(eq(dailyApplications.id, s.dailyApplicationId), isNull(dailyApplications.requestId)));
      }

      // 5) Mirror sang Planning (nếu request có planning_period liên kết) — additive, không xoá dữ liệu planning.
      //    Ghi cả recruitment_request_id + allocation_start_date để đồng bộ với mô hình vòng đời
      //    phân bổ append-only của Planning (migration 2026-08-17) — Task tái phân bổ / màn hình
      //    Planning nhìn thấy phân bổ này theo đúng request.
      if (request.planningPeriodId) {
        await tx
          .insert(planningAllocations)
          .values({
            employmentSessionId: s.id,
            planningPeriodId: request.planningPeriodId,
            recruitmentRequestId: request.id,
            allocationStartDate: todayStr(),
            allocatedBy: input.session.username,
          })
          .onConflictDoNothing();
      }

      allocsForRequest.push({
        id: inserted[0].id,
        requestId: request.id,
        workerId: s.workerId,
        sessionId: s.id,
        gender: target.gender,
      });

      results.push({
        employmentSessionId: s.id,
        workerId: s.workerId,
        workerName: normalizePersonName(s.workerName ?? "") || s.workerId,
        outcome: plan.existingForWorker ? "REALLOCATED" : "ALLOCATED",
      });
    }

    const finalWarnings = computeWarnings({
      maleRequest: request.maleRq,
      femaleRequest: request.femaleRq,
      totalRequest,
      maleCurrent: allocsForRequest.filter((a) => a.gender === "male").length,
      femaleCurrent: allocsForRequest.filter((a) => a.gender === "female").length,
      totalCurrent: allocsForRequest.length,
    });

    // Invalidate KPI cache của các request bị ảnh hưởng (mục 9) — không để dashboard đọc cache cũ.
    const affectedRequestIds = new Set<string>([request.id]);
    for (const r of existingRows) if (r.requestId !== request.id) affectedRequestIds.add(r.requestId);
    for (const rid of affectedRequestIds) {
      await tx.delete(requestKpiCache).where(eq(requestKpiCache.requestId, rid));
    }

    return { results, warnings: finalWarnings, overridden };
  });

  await writeAudit(
    input.session,
    txResult.overridden ? "OVERRIDE_REQUEST_ALLOCATION" : "ALLOCATE_TO_REQUEST",
    "request_allocations",
    {
      requestId: input.requestId,
      workers: txResult.results.map((r) => ({ workerId: r.workerId, outcome: r.outcome })),
      overridden: txResult.overridden,
      reason: input.reason?.trim() || input.override?.reason?.trim() || null,
    },
  );

  return txResult;
}

export type EndActiveRequestAllocationsResult = {
  ended: number;
  /** Request bị ảnh hưởng (Balance cần recompute — mục I.5). */
  affectedRequestIds: string[];
};

/**
 * PRIMITIVE DÙNG CHUNG (Phase 2B mục 3.3) — kết thúc mọi ACTIVE request
 * allocation của 1 worker: đóng request_allocations + ghi
 * request_allocation_history (action=END). CHỈ đụng lớp Request — KHÔNG
 * có side-effect nào khác (không đụng Planning). Dùng cho CẢ resignation
 * lẫn transfer, mỗi luồng tự quyết định xử lý Planning riêng theo đúng
 * nghiệp vụ của luồng đó (xem 2 wrapper bên dưới).
 */
async function endActiveRequestAllocations(
  workerId: string,
  endedBy: string,
  reason: string,
  executor: Executor,
): Promise<EndActiveRequestAllocationsResult> {
  const rows = await executor
    .select({
      id: requestAllocations.id,
      requestId: requestAllocations.requestId,
      employmentSessionId: requestAllocations.employmentSessionId,
    })
    .from(requestAllocations)
    .where(and(eq(requestAllocations.workerId, workerId), eq(requestAllocations.status, "ACTIVE")));

  for (const row of rows) {
    await executor
      .update(requestAllocations)
      .set({
        status: "ENDED",
        endedAt: new Date(),
        endedBy,
        endReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(requestAllocations.id, row.id));
    await executor.insert(requestAllocationHistory).values({
      requestId: row.requestId,
      workerId,
      employmentSessionId: row.employmentSessionId,
      fromRequestId: row.requestId,
      toRequestId: null,
      action: "END",
      reason,
      changedBy: endedBy,
    });
  }

  return { ended: rows.length, affectedRequestIds: [...new Set(rows.map((r) => r.requestId))] };
}

/** Kết thúc mọi ACTIVE request allocation của 1 worker (gọi khi nghỉ việc được xác nhận — mục 9).
 *  Đồng thời ĐÓNG (allocation_end_date) các phân bổ planning đang mở của worker — khớp mô hình
 *  vòng đời append-only của Planning (đóng phân bổ ≠ nghỉ việc; ở đây là nghỉ việc THẬT nên
 *  phân bổ phải đóng). Hành vi giữ NGUYÊN so với trước refactor Phase 2B — chỉ tách phần lõi
 *  Request allocation ra `endActiveRequestAllocations()` dùng chung với transfer. */
export async function endActiveRequestAllocationsForWorker(
  workerId: string,
  endedBy: string,
  reason: string,
  executor: Executor = db,
): Promise<EndActiveRequestAllocationsResult> {
  const result = await endActiveRequestAllocations(workerId, endedBy, reason, executor);

  // Đồng bộ phía Planning: đóng phân bổ planning đang mở của worker này.
  const openPlanning = await executor
    .select({ sessionId: planningAllocations.employmentSessionId })
    .from(planningAllocations)
    .innerJoin(employmentSessions, eq(planningAllocations.employmentSessionId, employmentSessions.id))
    .where(and(eq(employmentSessions.workerId, workerId), isNull(planningAllocations.allocationEndDate)));
  if (openPlanning.length > 0) {
    await executor
      .update(planningAllocations)
      .set({ allocationEndDate: todayStr(), reallocatedBy: endedBy, reallocatedAt: new Date() })
      .where(
        and(
          inArray(planningAllocations.employmentSessionId, openPlanning.map((r) => r.sessionId)),
          isNull(planningAllocations.allocationEndDate),
        ),
      );
  }

  return result;
}

/**
 * Kết thúc mọi ACTIVE request allocation của 1 worker khi THUYÊN CHUYỂN có hiệu
 * lực (approved design mục 3 + Phase 2B mục 3.3). CHỈ đóng lớp Request — KHÔNG
 * đóng planning allocation (transfer có lifecycle Planning riêng, xử lý bởi
 * `autoAllocateInternship()` ngay sau lời gọi này trong `finalizeTransferEffect()`
 * — dùng chung logic đóng như resignation ở đây sẽ tạo side-effect kép ngoài
 * phạm vi transfer). KHÔNG tự allocate vào request nào khác — đó luôn là hành
 * động thủ công riêng của user (allocateWorkersToRequest/reallocateDws).
 */
export async function endActiveRequestAllocationsForTransfer(
  workerId: string,
  endedBy: string,
  reason: string,
  executor: Executor = db,
): Promise<EndActiveRequestAllocationsResult> {
  return endActiveRequestAllocations(workerId, endedBy, reason, executor);
}

/* ============================================================
   MIRROR PLANNING → REQUEST (mục 8 + 9)
   Khi luồng cũ auto-allocate vào 1 planning period CÓ liên kết
   request, mirror sang request_allocations để request vẫn là
   source of truth. Tôn trọng quy tắc chặn vượt tổng nhu cầu:
   nếu request đã đủ thì KHÔNG mirror (chỉ còn allocation planning
   legacy) — không tự override khi không có người dùng xác nhận.

   Phase 3B (Decision B): kết quả trước đây là boolean, khiến caller
   (autoAllocateInternship()) không thể phân biệt "request đã đủ chỉ
   tiêu" với "period không liên kết request" hay "worker đã đúng vị
   trí từ trước" — ba trạng thái hoàn toàn khác nghĩa nhưng đều trả
   `false`/im lặng. Đổi sang discriminated result để caller log/audit
   chính xác mà KHÔNG đổi bất kỳ logic ghi DB nào bên dưới.
   ============================================================ */
export type MirrorPlanningAllocationOutcome =
  | { status: "SYNCED"; requestId: string }
  | { status: "ALREADY_CURRENT"; requestId: string }
  | { status: "NOT_LINKED" }
  | { status: "REJECTED_FULL"; requestId: string };

export async function mirrorPlanningAllocationToRequest(input: {
  planningPeriodId: string;
  employmentSessionId: string;
  workerId: string;
  allocatedBy: string;
  reason?: string;
  executor?: Executor;
}): Promise<MirrorPlanningAllocationOutcome> {
  const ex = input.executor ?? db;
  const [period] = await ex
    .select({ requestId: planningPeriods.requestId })
    .from(planningPeriods)
    .where(eq(planningPeriods.id, input.planningPeriodId));
  if (!period?.requestId) return { status: "NOT_LINKED" };

  // Pre-merge review finding (TOCTOU): trước đây SELECT này không khoá — hai lệnh
  // mirror đồng thời (vd. nhiều dòng bulk-import cùng auto-allocate vào 1 request
  // liên kết, hoặc mirror này chạy song song với reallocateDws()/
  // allocateWorkersToRequest() trên CÙNG request đích) đều có thể đọc "current"
  // giống nhau TRƯỚC khi bên kia commit, rồi cả hai cùng ghi → vượt target thật sự
  // (không chỉ là rủi ro lý thuyết). FOR UPDATE ở đây khoá ĐÚNG bản ghi
  // recruitment_requests mà reallocateDws()/allocateWorkersToRequest() cũng khoá
  // (cùng bảng, cùng cột id, cùng FOR UPDATE) — Postgres serialize mọi tổ hợp giữa
  // 4 entry-point (mirror, reallocateDws, allocateWorkersToRequest, một mirror khác)
  // nhắm cùng 1 request đích. Khoá này KHÔNG làm mirror thành fatal: REJECTED_FULL
  // vẫn chỉ là return bình thường, Employment/Planning phía trên không rollback.
  //
  // Deadlock: nếu MỘT worker vừa đang được recruiter reallocate thủ công
  // (reallocateDws khoá planning_allocations của CHÍNH dòng đó trước, rồi khoá
  // recruitment_requests) VỪA đúng lúc lifecycle transfer/onboarding của CHÍNH
  // worker đó gọi autoAllocateInternship() (ghi planning_allocations của CHÍNH
  // dòng đó trước, rồi khoá recruitment_requests ở đây) — thứ tự khoá bị đảo
  // ngược giữa hai flow, tạo nguy cơ deadlock. Đây là kịch bản rất hẹp (cùng 1
  // worker, cùng 1 thời điểm, hai lifecycle khác nhau chạy song song) mà Postgres
  // tự phát hiện và huỷ MỘT bên giao dịch (lỗi 40P01) thay vì treo — không mất
  // dữ liệu, không âm thầm sai, nhưng CÓ THỂ khiến giao dịch Employment/Transfer
  // đó thất bại toàn bộ thay vì chỉ mirror bị REJECTED_FULL. Chấp nhận rủi ro hẹp
  // này thay vì mở rộng phạm vi fix sang retry/backoff (ngoài phạm vi pre-merge
  // review này) — xem PR description mục "Remaining risks".
  const [request] = await ex
    .select({
      id: recruitmentRequests.id,
      maleRq: recruitmentRequests.maleRq,
      femaleRq: recruitmentRequests.femaleRq,
      totalRequest: recruitmentRequests.totalRequest,
      deletedAt: recruitmentRequests.deletedAt,
    })
    .from(recruitmentRequests)
    .where(eq(recruitmentRequests.id, period.requestId))
    .for("update");
  // Request đã bị xoá/không tồn tại: coi như period không còn liên kết hợp lệ.
  if (!request || request.deletedAt) return { status: "NOT_LINKED" };

  // Gắn recruitment_request_id vào dòng planning vừa được auto-allocate tạo (nếu chưa có)
  // — đồng bộ với mô hình vòng đời phân bổ của Planning (migration 2026-08-17).
  await ex
    .update(planningAllocations)
    .set({ recruitmentRequestId: request.id })
    .where(
      and(
        eq(planningAllocations.employmentSessionId, input.employmentSessionId),
        eq(planningAllocations.planningPeriodId, input.planningPeriodId),
        isNull(planningAllocations.allocationEndDate),
        isNull(planningAllocations.recruitmentRequestId),
      ),
    );

  const activeRows = await ex
    .select({ id: requestAllocations.id, requestId: requestAllocations.requestId, workerId: requestAllocations.workerId, sessionId: requestAllocations.employmentSessionId })
    .from(requestAllocations)
    .where(and(eq(requestAllocations.status, "ACTIVE"), eq(requestAllocations.requestId, request.id)));

  const existingForWorker = activeRows.find((r) => r.workerId === input.workerId) ?? null;

  const totalRequest = resolveTotalRequestOf(request);
  const plan = planAllocation(
    {
      targetRequestId: request.id,
      totalRequest,
      maleRequest: request.maleRq,
      femaleRequest: request.femaleRq,
      allocations: activeRows.map((r) => ({
        id: r.id,
        requestId: r.requestId,
        workerId: r.workerId,
        sessionId: r.sessionId,
        gender: classifyGender(undefined),
      })),
      existingForWorker: existingForWorker
        ? { ...existingForWorker, gender: classifyGender(undefined) }
        : null,
    },
    { sessionId: input.employmentSessionId, workerId: input.workerId, gender: classifyGender(undefined) },
  );

  if (plan.outcome === "REJECTED") {
    console.warn("[workforce-request] mirror rejected: request đích đã đủ chỉ tiêu", {
      periodId: input.planningPeriodId,
      requestId: request.id,
      workerId: input.workerId,
    });
    return { status: "REJECTED_FULL", requestId: request.id };
  }
  if (plan.outcome === "NOOP") {
    return { status: "ALREADY_CURRENT", requestId: request.id };
  }

  if (plan.existingForWorker) {
    await ex
      .update(requestAllocations)
      .set({
        status: "ENDED",
        endedAt: new Date(),
        endedBy: input.allocatedBy,
        endReason: input.reason ?? "Tái phân bổ tự động (mirror Planning)",
        updatedAt: new Date(),
      })
      .where(eq(requestAllocations.id, plan.existingForWorker.id));
  }
  await ex
    .insert(requestAllocations)
    .values({
      employmentSessionId: input.employmentSessionId,
      workerId: input.workerId,
      requestId: request.id,
      status: "ACTIVE",
      allocatedBy: input.allocatedBy,
    })
    .onConflictDoNothing({
      target: requestAllocations.workerId,
      where: sql`status = 'ACTIVE'`,
    });
  await ex.insert(requestAllocationHistory).values({
    requestId: request.id,
    workerId: input.workerId,
    employmentSessionId: input.employmentSessionId,
    fromRequestId: plan.existingForWorker?.requestId ?? null,
    toRequestId: request.id,
    action: plan.existingForWorker ? "REALLOCATE" : "ALLOCATE",
    reason: input.reason ?? "Tự động phân bổ theo Planning (mirror)",
    changedBy: input.allocatedBy,
  });
  return { status: "SYNCED", requestId: request.id };
}

/* ============================================================
   ĐỒNG BỘ NGƯỢC: PLANNING TÁI PHÂN BỔ → REQUEST (mục 4 + 9)
   Luồng tái phân bổ của Planning (planning-reallocation.ts,
   migration 2026-08-17) chuyển planning allocation giữa 2 request.
   Hàm này đồng bộ sang request_allocations để request vẫn là
   source of truth của KPI. Tôn trọng block vượt tổng nhu cầu:
   nếu request đích đã đủ thì KHÔNG tạo allocation (chỉ log) —
   không tự override khi không có người dùng xác nhận.
   ============================================================ */
export async function syncRequestAllocationOnPlanningMove(input: {
  executor: Executor;
  employmentSessionId: string;
  fromRequestId: string;
  toRequestId: string;
  actor: string;
  reason?: string;
}): Promise<boolean> {
  const ex = input.executor;

  const [session] = await ex
    .select({ workerId: employmentSessions.workerId })
    .from(employmentSessions)
    .where(eq(employmentSessions.id, input.employmentSessionId));
  if (!session?.workerId) return false;

  const [toRequest] = await ex
    .select({
      id: recruitmentRequests.id,
      maleRq: recruitmentRequests.maleRq,
      femaleRq: recruitmentRequests.femaleRq,
      totalRequest: recruitmentRequests.totalRequest,
      deletedAt: recruitmentRequests.deletedAt,
    })
    .from(recruitmentRequests)
    .where(eq(recruitmentRequests.id, input.toRequestId));
  if (!toRequest || toRequest.deletedAt) return false;

  const activeRows = await ex
    .select({
      id: requestAllocations.id,
      requestId: requestAllocations.requestId,
      workerId: requestAllocations.workerId,
      sessionId: requestAllocations.employmentSessionId,
    })
    .from(requestAllocations)
    .where(
      and(
        eq(requestAllocations.status, "ACTIVE"),
        or(eq(requestAllocations.requestId, input.toRequestId), eq(requestAllocations.workerId, session.workerId)),
      ),
    );

  const existingForWorker = activeRows.find((r) => r.workerId === session.workerId) ?? null;
  const plan = planAllocation(
    {
      targetRequestId: input.toRequestId,
      totalRequest: resolveTotalRequestOf(toRequest),
      maleRequest: toRequest.maleRq,
      femaleRequest: toRequest.femaleRq,
      allocations: activeRows
        .filter((r) => r.requestId === input.toRequestId)
        .map((r) => ({ ...r, gender: classifyGender(undefined) })),
      existingForWorker: existingForWorker ? { ...existingForWorker, gender: classifyGender(undefined) } : null,
    },
    { sessionId: input.employmentSessionId, workerId: session.workerId, gender: classifyGender(undefined) },
  );

  if (plan.outcome === "REJECTED") {
    console.warn("[workforce-request] planning-move sync skipped (request đích đã đủ)", {
      from: input.fromRequestId,
      to: input.toRequestId,
      workerId: session.workerId,
    });
    return false;
  }
  if (plan.outcome === "NOOP") return false;

  if (plan.existingForWorker) {
    await ex
      .update(requestAllocations)
      .set({
        status: "ENDED",
        endedAt: new Date(),
        endedBy: input.actor,
        endReason: input.reason ?? "Tái phân bổ theo luồng Planning",
        updatedAt: new Date(),
      })
      .where(eq(requestAllocations.id, plan.existingForWorker.id));
  }
  await ex
    .insert(requestAllocations)
    .values({
      employmentSessionId: input.employmentSessionId,
      workerId: session.workerId,
      requestId: input.toRequestId,
      status: "ACTIVE",
      allocatedBy: input.actor,
    })
    .onConflictDoNothing({
      target: requestAllocations.workerId,
      where: sql`status = 'ACTIVE'`,
    });
  await ex.insert(requestAllocationHistory).values({
    requestId: input.toRequestId,
    workerId: session.workerId,
    employmentSessionId: input.employmentSessionId,
    fromRequestId: plan.existingForWorker?.requestId ?? input.fromRequestId,
    toRequestId: input.toRequestId,
    action: plan.existingForWorker ? "REALLOCATE" : "ALLOCATE",
    reason: input.reason ?? "Đồng bộ từ luồng tái phân bổ Planning",
    changedBy: input.actor,
  });
  return true;
}

/* ============================================================
   LIÊN KẾT PLANNING ↔ REQUEST (mục 8) — bằng ID, 2 chiều
   ============================================================ */
export async function linkRequestToPlanningPeriod(requestId: string, planningPeriodId: string, by: string) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select({ id: recruitmentRequests.id, deletedAt: recruitmentRequests.deletedAt })
      .from(recruitmentRequests)
      .where(eq(recruitmentRequests.id, requestId))
      .for("update");
    if (!request || request.deletedAt) throw new Error("Không tìm thấy Workforce Request.");
    const [period] = await tx
      .select({ id: planningPeriods.id })
      .from(planningPeriods)
      .where(eq(planningPeriods.id, planningPeriodId))
      .for("update");
    if (!period) throw new Error("Không tìm thấy Planning Period.");

    await tx
      .update(recruitmentRequests)
      .set({ planningPeriodId, updatedAt: new Date() })
      .where(eq(recruitmentRequests.id, requestId));
    await tx
      .update(planningPeriods)
      .set({ requestId, updatedAt: new Date() })
      .where(eq(planningPeriods.id, planningPeriodId));
    return { requestId, planningPeriodId };
  });
}

/* ============================================================
   COMMENTS (mục 11)
   ============================================================ */
export async function listRequestComments(requestId: string) {
  return db
    .select()
    .from(requestComments)
    .where(eq(requestComments.requestId, requestId))
    .orderBy(requestComments.createdAt);
}

export async function addRequestComment(requestId: string, session: Session, body: string) {
  const [request] = await db
    .select({ id: recruitmentRequests.id })
    .from(recruitmentRequests)
    .where(and(eq(recruitmentRequests.id, requestId), isNull(recruitmentRequests.deletedAt)));
  if (!request) throw new Error("Không tìm thấy Workforce Request.");
  const [row] = await db
    .insert(requestComments)
    .values({ requestId, userId: session.id, username: session.username, body: body.trim() })
    .returning();
  return row;
}

/* ============================================================
   DANH SÁCH SESSION CHO PHÂN BỔ (Recruiter view — mục 12)
   ============================================================ */
export type AllocationCandidateSession = {
  sessionId: string;
  workerId: string;
  workerName: string | null;
  cccd: string;
  gender: string | null;
  deptName: string | null;
  regDate: string;
  currentRequestId: string | null;
  currentRequestCode: string | null;
};

export async function listSessionsForAllocation(
  search?: string,
  scope: string[] | null = null,
): Promise<AllocationCandidateSession[]> {
  const conditions = [
    eq(employmentSessions.status, "APPROVED"),
    isNull(employmentSessions.endDate),
    isNull(workerProfiles.deletedAt),
    or(isNull(employmentSessions.startingDate), lte(employmentSessions.startingDate, todayStr()))!,
  ];
  if (search?.trim()) {
    const q = `%${search.trim()}%`;
    conditions.push(or(sql`${workerProfiles.fullName} ILIKE ${q}`, sql`${workerProfiles.cccd} ILIKE ${q}`)!);
  }
  // Production Recovery audit (PII leak) — TRƯỚC ĐÂY không lọc Data Scope: trả fullName+CCCD cho
  // tối đa 200 session ACTIVE TOÀN CÔNG TY, kể cả khi caller bị giới hạn scope. Các endpoint khác
  // dùng chung employmentSessions.deptId đều lọc — endpoint này thì không, dù cùng risk (PII).
  if (scope !== null) {
    if (scope.length === 0) return [];
    conditions.push(inArray(employmentSessions.deptId, scope));
  }

  const rows = await db
    .select({
      sessionId: employmentSessions.id,
      workerId: employmentSessions.workerId,
      workerName: workerProfiles.fullName,
      cccd: workerProfiles.cccd,
      gender: workerProfiles.gender,
      deptName: departments.deptName,
      regDate: employmentSessions.regDate,
      currentRequestId: requestAllocations.requestId,
      currentRequestCode: recruitmentRequests.requestCode,
    })
    .from(employmentSessions)
    .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
    .leftJoin(
      requestAllocations,
      and(eq(requestAllocations.employmentSessionId, employmentSessions.id), eq(requestAllocations.status, "ACTIVE")),
    )
    .leftJoin(
      recruitmentRequests,
      and(eq(recruitmentRequests.id, requestAllocations.requestId), isNull(recruitmentRequests.deletedAt)),
    )
    .where(and(...conditions))
    .orderBy(desc(employmentSessions.regDate))
    .limit(200);

  return rows.map((r) => ({ ...r, workerName: normalizePersonName(r.workerName ?? "") || null }));
}

/* ============================================================
   PLANNING DASHBOARD (mục 13) — tổng hợp + drill-down
   ============================================================ */
export type RequestDashboard = {
  summary: ReturnType<typeof aggregateRequestKpis>;
  rows: {
    id: string;
    requestCode: string;
    department: string | null;
    section: string | null;
    groupName: string | null;
    expectedDate: string | null;
    status: string;
    kpi: RequestKpi;
  }[];
  source: "LIVE" | "CACHE";
  computedAt: string;
  asOfDate: string;
};

export async function getRequestDashboard(scope: string[] | null, asOf = todayStr()): Promise<RequestDashboard> {
  const conditions = [isNull(recruitmentRequests.deletedAt)];
  const scopeCond = requestScopeCondition(scope);
  if (scopeCond) conditions.push(scopeCond);

  const rows = await db
    .select({
      id: recruitmentRequests.id,
      requestCode: recruitmentRequests.requestCode,
      department: recruitmentRequests.department,
      section: recruitmentRequests.section,
      groupName: recruitmentRequests.groupName,
      expectedDate: recruitmentRequests.expectedDate,
      endDate: recruitmentRequests.endDate,
      status: recruitmentRequests.status,
      maleRq: recruitmentRequests.maleRq,
      femaleRq: recruitmentRequests.femaleRq,
      totalRequest: recruitmentRequests.totalRequest,
      requestedDate: recruitmentRequests.requestedDate,
      createdAt: recruitmentRequests.createdAt,
    })
    .from(recruitmentRequests)
    .where(and(...conditions));

  const ids = rows.map((r) => r.id);

  // CACHE (mục 9): chỉ dùng cho dashboard tổng hợp, có timestamp; mọi quyết định
  // allocation LUÔN tính live trong transaction — cache không phải source of truth.
  const cached =
    asOf === todayStr() ? await readFreshRequestKpiCache(ids, asOf) : new Map<string, { kpi: RequestKpi; computedAt: string }>();
  let source: "LIVE" | "CACHE" = "CACHE";
  let kpis: Map<string, RequestKpi>;
  if (cached.size === ids.length && ids.length > 0) {
    kpis = new Map([...cached.entries()].map(([id, v]) => [id, v.kpi]));
    source = "CACHE";
  } else {
    kpis = await batchComputeRequestKpis(rows, asOf);
    await storeRequestKpiCache(rows.filter((r) => kpis.has(r.id)).map((r) => ({ requestId: r.id, asOf, kpi: kpis.get(r.id)! })));
    source = "LIVE";
  }

  const dashboardRows = rows.map((r) => ({
    id: r.id,
    requestCode: r.requestCode,
    department: r.department,
    section: r.section,
    groupName: r.groupName,
    expectedDate: r.expectedDate,
    status: r.status,
    kpi:
      kpis.get(r.id) ??
      computeRequestKpi({
        maleRequest: r.maleRq,
        femaleRequest: r.femaleRq,
        totalRequest: resolveTotalRequest(r.maleRq, r.femaleRq, r.totalRequest),
        maleCurrent: 0,
        femaleCurrent: 0,
        maleRecruited: 0,
        femaleRecruited: 0,
        maleQuit: 0,
        femaleQuit: 0,
        maleTransferOut: 0,
        femaleTransferOut: 0,
      }),
  }));

  const computedAt =
    source === "CACHE" && cached.size > 0
      ? [...cached.values()].reduce((max, v) => (v.computedAt > max ? v.computedAt : max), "")
      : new Date().toISOString();

  return {
    summary: aggregateRequestKpis(dashboardRows.map((r) => r.kpi)),
    rows: dashboardRows,
    source,
    computedAt,
    asOfDate: asOf,
  };
}
