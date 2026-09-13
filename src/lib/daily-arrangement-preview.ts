import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { planningPeriods } from "@/db/schema";
import { getRequestDetail, listWorkforceRequests } from "@/lib/workforce-request";
import { isHistoricalRequestStatus } from "@/lib/workforce-request-kpi";
import { todayStr } from "@/lib/helpers";

/**
 * MISSION E section 30-42 — DAILY ARRANGEMENT DECISION SUPPORT (read-only preview).
 * ------------------------------------------------------------------------------
 * This is deliberately a PREVIEW, never a second allocation engine: the real,
 * authoritative selection + atomic write already exists and runs automatically
 * at "xếp việc" time — `autoAllocateInternship()` (src/lib/planning.ts), called
 * from the registrations PATCH handler inside the SAME transaction that creates/
 * activates the employment session. That function already implements the
 * deterministic candidate order (ACTIVE planning period for the department,
 * ORIGINAL before SUPPLEMENT, earliest createdAt), the END+INSERT allocation
 * history pattern, and the canonical Request-capacity mirror (never overriding
 * automatically, never rewriting `requestId` destructively).
 *
 * What was MISSING before this file (mission's actual gap): the recruiter had
 * no VISIBILITY into which Request would be picked, whether the batch they are
 * about to arrange would exceed that Request's remaining need, or what other
 * departments still need workers — the real allocation ran silently. This
 * module answers exactly those three questions for the Daily Arrangement UI's
 * department picker, using the SAME candidate-period query
 * `autoAllocateInternship` uses (read-only mirror of its own ordering — not a
 * competing definition), and the SAME canonical `RequestKpi.totalBalance` used
 * everywhere else in the app (never the legacy persisted `totalBalance` column
 * read directly — `getRequestDetail`/`listWorkforceRequests` already recompute
 * it live). Never writes anything.
 */

export type RecommendedRequestPreview = {
  requestId: string;
  requestCode: string;
  target: number;
  current: number;
  balance: number;
};

export type OtherDepartmentGap = {
  deptId: string;
  deptName: string;
  target: number;
  current: number;
  balance: number;
};

export type DailyArrangementPreview = {
  deptId: string;
  recommendedRequest: RecommendedRequestPreview | null;
  /** true khi KHÔNG có live Recruitment Request nào sẽ được tự động gán cho bộ phận này —
   *  xếp việc vẫn được phép tiếp tục (Employment/Planning không phụ thuộc Request), nhưng
   *  cần cảnh báo quản lý (mục 33). */
  unattributedWarning: boolean;
  /** Chỉ có khi recommendedRequest tồn tại — chiếu N người sắp chọn vào Balance hiện tại. */
  projected: { selectedCount: number; projectedTotal: number; overNeed: number } | null;
  otherDepartments: OtherDepartmentGap[];
};

async function findCandidateRequestId(deptId: string, asOfDate: string): Promise<string | null> {
  const periods = await db
    .select({
      id: planningPeriods.id,
      requestId: planningPeriods.requestId,
      startDate: planningPeriods.startDate,
      endDate: planningPeriods.endDate,
    })
    .from(planningPeriods)
    .where(and(eq(planningPeriods.departmentId, deptId), eq(planningPeriods.status, "ACTIVE")))
    .orderBy(asc(planningPeriods.supplementIndex), asc(planningPeriods.createdAt));

  if (periods.length === 0) return null;
  const withinWindow = periods.filter((p) => p.startDate <= asOfDate && p.endDate >= asOfDate);
  const candidates = withinWindow.length > 0 ? withinWindow : periods;
  return candidates.find((p) => p.requestId)?.requestId ?? null;
}

export async function getDailyArrangementPreview(
  scope: string[] | null,
  deptId: string,
  selectedCount: number,
): Promise<DailyArrangementPreview> {
  const today = todayStr();
  const requestId = await findCandidateRequestId(deptId, today);

  let recommendedRequest: RecommendedRequestPreview | null = null;
  if (requestId) {
    const detail = await getRequestDetail(requestId);
    if (detail && !isHistoricalRequestStatus(detail.request.status)) {
      recommendedRequest = {
        requestId,
        requestCode: detail.request.requestCode,
        target: detail.kpi.totalRequest,
        current: detail.kpi.totalCurrent,
        balance: detail.kpi.totalBalance,
      };
    }
  }

  const projected =
    recommendedRequest && selectedCount > 0
      ? {
          selectedCount,
          projectedTotal: recommendedRequest.current + selectedCount,
          overNeed: Math.max(0, recommendedRequest.current + selectedCount - recommendedRequest.target),
        }
      : null;

  const allLive = await listWorkforceRequests({ scope });
  const otherDepartments = allLive
    .filter((r) => !isHistoricalRequestStatus(r.status) && r.departmentId !== deptId && r.kpi.totalBalance > 0)
    .reduce<Map<string, OtherDepartmentGap>>((map, r) => {
      const key = r.departmentId ?? r.id;
      const existing = map.get(key);
      if (existing) {
        existing.target += r.kpi.totalRequest;
        existing.current += r.kpi.totalCurrent;
        existing.balance += r.kpi.totalBalance;
      } else {
        map.set(key, {
          deptId: r.departmentId ?? "",
          deptName: r.deptName ?? r.department ?? "—",
          target: r.kpi.totalRequest,
          current: r.kpi.totalCurrent,
          balance: r.kpi.totalBalance,
        });
      }
      return map;
    }, new Map())
    .values();

  return {
    deptId,
    recommendedRequest,
    unattributedWarning: recommendedRequest === null,
    projected,
    otherDepartments: Array.from(otherDepartments)
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 6),
  };
}
