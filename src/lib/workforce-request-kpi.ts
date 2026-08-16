/* ============================================================
   WORKFORCE REQUEST — KPI & ALLOCATION ENGINE (PURE)
   ------------------------------------------------------------
   Module THUẦN (không import "server-only", không import @/db):
   - Công thức KPI Nam/Nữ (Balance, Fill rate, Warnings) — dùng
     chung cho API, Planning và test.
   - Bộ lập kế hoạch phân bổ (planAllocation) — quyết định
     ALLOCATE / REALLOCATE / NOOP / REJECT trước khi ghi DB.
   Đây là SOURCE OF TRUTH của CÔNG THỨC: mọi nơi tính số liệu
   nhân lực phải đi qua module này, không tự viết công thức.
   ============================================================ */

export type GenderBucket = "male" | "female" | "unknown";

/**
 * Employment Session đang thực sự ACTIVE (mục 1): status APPROVED + chưa có endDate.
 * ĐỘC LẬP với trạng thái Planning/Request — request hết hạn (EXPIRED) KHÔNG làm thay
 * đổi trạng thái Employment (test F): session chỉ đổi khi có nghiệp vụ thật
 * (nghỉ việc xác nhận, đóng/mở session).
 */
export function isActiveEmploymentSession(status: string | null, endDate: string | null): boolean {
  return status === "APPROVED" && endDate == null;
}

/** Phân loại giới tính theo đúng quy ước hệ thống (khớp helpers.isMale/isFemale). */
export function classifyGender(gender?: string | null): GenderBucket {
  const g = (gender ?? "").trim().toLowerCase();
  if (g === "nữ" || g === "nu" || g === "female" || g === "f" || g.includes("nữ") || g.includes("nu")) return "female";
  if (g === "nam" || g === "male" || g === "m" || g.includes("nam")) return "male";
  return "unknown";
}

export type GenderCounts = { male: number; female: number; total: number };

export function emptyCounts(): GenderCounts {
  return { male: 0, female: 0, total: 0 };
}

export function addGender(counts: GenderCounts, gender: GenderBucket, n = 1): GenderCounts {
  const next = { ...counts, total: counts.total + n };
  if (gender === "male") next.male += n;
  else if (gender === "female") next.female += n;
  return next;
}

/* ============================================================
   WARNING STATES (mục 7)
   ------------------------------------------------------------
   - MALE_SHORTAGE / FEMALE_SHORTAGE: soft warning.
   - MALE_OVER_TARGET / FEMALE_OVER_TARGET: soft warning (lệch
     cơ cấu Nam/Nữ được phép — mục 5).
   - TOTAL_OVER_TARGET: BLOCKING (chặn allocation mới nếu không
     có quyền planning.overallocate — mục 6).
   - FULFILLED: đã đáp ứng đủ nhu cầu.
   ============================================================ */
export const WARNING_CODES = [
  "MALE_SHORTAGE",
  "FEMALE_SHORTAGE",
  "MALE_OVER_TARGET",
  "FEMALE_OVER_TARGET",
  "TOTAL_OVER_TARGET",
  "FULFILLED",
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];
export type WarningSeverity = "OK" | "SOFT" | "BLOCKING";

export type WarningDetail = {
  code: WarningCode;
  severity: WarningSeverity;
  message: string;
};

export const TOTAL_OVER_TARGET_MESSAGE = "Tổng phân bổ đã vượt tổng nhu cầu.";

export type WarningInput = {
  maleRequest: number;
  femaleRequest: number;
  totalRequest: number;
  maleCurrent: number;
  femaleCurrent: number;
  totalCurrent: number;
};

export function computeWarnings(input: WarningInput): WarningDetail[] {
  const warnings: WarningDetail[] = [];
  const { maleRequest, femaleRequest, totalRequest, maleCurrent, femaleCurrent, totalCurrent } = input;

  const totalOver = totalRequest > 0 && totalCurrent > totalRequest;
  if (totalOver) {
    warnings.push({ code: "TOTAL_OVER_TARGET", severity: "BLOCKING", message: TOTAL_OVER_TARGET_MESSAGE });
  }

  if (maleRequest > 0 && maleCurrent > maleRequest) {
    const diff = maleCurrent - maleRequest;
    warnings.push({
      code: "MALE_OVER_TARGET",
      severity: "SOFT",
      message: totalOver
        ? `Nam đang vượt cơ cấu yêu cầu ${diff} người (đồng thời tổng phân bổ đang vượt).`
        : `Nam đang vượt cơ cấu yêu cầu ${diff} người; tổng nhân lực vẫn trong giới hạn.`,
    });
  }
  if (femaleRequest > 0 && femaleCurrent > femaleRequest) {
    const diff = femaleCurrent - femaleRequest;
    warnings.push({
      code: "FEMALE_OVER_TARGET",
      severity: "SOFT",
      message: totalOver
        ? `Nữ đang vượt cơ cấu yêu cầu ${diff} người (đồng thời tổng phân bổ đang vượt).`
        : `Nữ đang vượt cơ cấu yêu cầu ${diff} người; tổng nhân lực vẫn trong giới hạn.`,
    });
  }
  if (maleRequest > 0 && maleCurrent < maleRequest) {
    warnings.push({
      code: "MALE_SHORTAGE",
      severity: "SOFT",
      message: `Thiếu ${maleRequest - maleCurrent} lao động Nam so với nhu cầu.`,
    });
  }
  if (femaleRequest > 0 && femaleCurrent < femaleRequest) {
    warnings.push({
      code: "FEMALE_SHORTAGE",
      severity: "SOFT",
      message: `Thiếu ${femaleRequest - femaleCurrent} lao động Nữ so với nhu cầu.`,
    });
  }

  const fulfilled =
    totalRequest > 0 &&
    !totalOver &&
    maleCurrent >= maleRequest &&
    femaleCurrent >= femaleRequest;
  if (fulfilled) {
    warnings.push({ code: "FULFILLED", severity: "OK", message: "Đã đáp ứng đủ nhu cầu nhân lực." });
  }

  return warnings;
}

/* ============================================================
   CÔNG THỨC BALANCE (mục 3) + PHASE 6 (double-count fix)
   ------------------------------------------------------------
   Male Balance   = max(0, Male Request − Male Current)
   Female Balance = max(0, Female Request − Female Current)
   Total Balance  = Male Balance + Female Balance

   LÝ DO ĐỔI (PHASE 6 audit): Quit đã được tính vào "Current" rồi — worker
   nghỉ bị loại khỏi ACTIVE Employment Session (xem
   `isActiveEmploymentSession` ở trên), nên Current đã giảm đúng 1. Cộng
   thêm Quit ở đây là double-count. Test bắt buộc: Rq=10, Current-before=10,
   1 quit → Current=9, Quit=1 → Balance cũ = 2 (SAI); Balance mới = 1 (ĐÚNG).
   Quit vẫn còn là historical KPI (attrition reporting) nhưng KHÔNG cộng vào
   nhu cầu tuyển mới.
   ============================================================ */
export function computeBalance(input: {
  maleRequest: number;
  femaleRequest: number;
  maleCurrent: number;
  femaleCurrent: number;
  /** Nhận nhưng KHÔNG dùng trong công thức — giữ để không phá call-site cũ. */
  maleQuit?: number;
  femaleQuit?: number;
}): { maleBalance: number; femaleBalance: number; totalBalance: number } {
  const maleBalance = Math.max(0, input.maleRequest - input.maleCurrent);
  const femaleBalance = Math.max(0, input.femaleRequest - input.femaleCurrent);
  return { maleBalance, femaleBalance, totalBalance: maleBalance + femaleBalance };
}

/* ============================================================
   REQUEST KPI (mục 2 + 3 + 7) — đầu ra chuẩn cho mọi view
   ============================================================ */
export type RequestKpiInput = {
  /** Nhu cầu được YÊU CẦU (source: recruitment_requests.male_rq / female_rq). */
  maleRequest: number;
  femaleRequest: number;
  /** Total Request = Male Request + Female Request (legacy fallback: cột total_request khi cả 2 = 0). */
  totalRequest: number;
  /** Hiện có — đếm từ ACTIVE Employment Session có ACTIVE allocation (source of truth). */
  maleCurrent: number;
  femaleCurrent: number;
  /** Đã tuyển — pipeline Daily Application + Workflow (stage kết thúc "Đã nhận việc"). */
  maleRecruited: number;
  femaleRecruited: number;
  /** Nghỉ việc — RESIGNATION đã xác nhận (INACTIVE) trong khoảng thời gian request. */
  maleQuit: number;
  femaleQuit: number;
};

export type RequestKpi = GenderCounts & {
  maleRequest: number;
  femaleRequest: number;
  totalRequest: number;
  maleCurrent: number;
  femaleCurrent: number;
  totalCurrent: number;
  maleRecruited: number;
  femaleRecruited: number;
  totalRecruited: number;
  maleQuit: number;
  femaleQuit: number;
  totalQuit: number;
  maleBalance: number;
  femaleBalance: number;
  totalBalance: number;
  fillRatePercent: number;
  warnings: WarningDetail[];
};

export function computeRequestKpi(input: RequestKpiInput): RequestKpi {
  const totalCurrent = input.maleCurrent + input.femaleCurrent;
  const totalRecruited = input.maleRecruited + input.femaleRecruited;
  const totalQuit = input.maleQuit + input.femaleQuit;

  const balance = computeBalance(input);

  const fillRatePercent =
    input.totalRequest > 0 ? Math.min(100, Math.round((totalCurrent / input.totalRequest) * 100)) : 0;

  const warnings = computeWarnings({
    maleRequest: input.maleRequest,
    femaleRequest: input.femaleRequest,
    totalRequest: input.totalRequest,
    maleCurrent: input.maleCurrent,
    femaleCurrent: input.femaleCurrent,
    totalCurrent,
  });

  return {
    male: input.maleCurrent,
    female: input.femaleCurrent,
    total: totalCurrent,
    maleRequest: input.maleRequest,
    femaleRequest: input.femaleRequest,
    totalRequest: input.totalRequest,
    maleCurrent: input.maleCurrent,
    femaleCurrent: input.femaleCurrent,
    totalCurrent,
    maleRecruited: input.maleRecruited,
    femaleRecruited: input.femaleRecruited,
    totalRecruited,
    maleQuit: input.maleQuit,
    femaleQuit: input.femaleQuit,
    totalQuit,
    maleBalance: balance.maleBalance,
    femaleBalance: balance.femaleBalance,
    totalBalance: balance.totalBalance,
    fillRatePercent,
    warnings,
  };
}

/** Lấy tổng nhu cầu chuẩn hoá: Male + Female; fallback về cột legacy total_request khi cả 2 = 0. */
export function resolveTotalRequest(maleRequest: number, femaleRequest: number, legacyTotalRequest = 0): number {
  if (maleRequest > 0 || femaleRequest > 0) return maleRequest + femaleRequest;
  return Math.max(0, legacyTotalRequest);
}

/* ============================================================
   ALLOCATION ENGINE (mục 4, 5, 6, 15) — thuần, dùng trước khi ghi DB
   ------------------------------------------------------------
   Quy tắc:
   1. 1 worker chỉ có tối đa 1 ACTIVE request allocation (DB
      partial unique index chốt thêm lớp cuối).
   2. Chuyển Request A → B = kết thúc allocation A + tạo B,
      KHÔNG tạo Resignation, Employment Session vẫn ACTIVE.
   3. Không hard-block lệch cơ cấu Nam/Nữ (chỉ warning).
   4. totalCurrent + 1 > Total Request → REJECT trừ khi override
      hợp lệ (quyền planning.overallocate + reason + confirmed).
   5. Gọi lặp lại (double-click/retry) → NOOP (không double).
   ============================================================ */

export type ActiveAllocationRef = {
  /** request_allocations.id (giả cho test) */
  id: string;
  requestId: string;
  sessionId: string;
  workerId: string;
  gender: GenderBucket;
};

export type AllocationPlanState = {
  /** Request đích của lần phân bổ. */
  targetRequestId: string;
  totalRequest: number;
  maleRequest: number;
  femaleRequest: number;
  /** ACTIVE allocations HIỆN TẠI của request đích. */
  allocations: ActiveAllocationRef[];
  /** ACTIVE allocation hiện có của worker mục tiêu ở BẤT KỲ request nào (null nếu chưa có). */
  existingForWorker: ActiveAllocationRef | null;
};

export type AllocationTarget = {
  sessionId: string;
  workerId: string;
  gender: GenderBucket;
};

export type AllocationOverrideInput = {
  confirmed: boolean;
  reason: string;
};

export type AllocationPlanResult =
  | { outcome: "NOOP"; allocation: ActiveAllocationRef; warnings: WarningDetail[] }
  | {
      outcome: "ALLOCATE";
      /** Allocation cần kết thúc trước (re-allocate từ request khác); null = allocation mới hoàn toàn. */
      existingForWorker: ActiveAllocationRef | null;
      overrideApplied: boolean;
      projectedCounts: GenderCounts;
      warnings: WarningDetail[];
    }
  | { outcome: "REJECTED"; code: "TOTAL_OVER_TARGET"; message: string };

export function planAllocation(
  state: AllocationPlanState,
  target: AllocationTarget,
  override?: AllocationOverrideInput,
): AllocationPlanResult {
  // 1) Idempotency: worker đã có ACTIVE allocation đúng request này → NOOP.
  if (state.existingForWorker && state.existingForWorker.requestId === state.targetRequestId) {
    return {
      outcome: "NOOP",
      allocation: state.existingForWorker,
      warnings: computeWarnings({
        maleRequest: state.maleRequest,
        femaleRequest: state.femaleRequest,
        totalRequest: state.totalRequest,
        maleCurrent: countBy(state.allocations, "male"),
        femaleCurrent: countBy(state.allocations, "female"),
        totalCurrent: state.allocations.length,
      }),
    };
  }

  // 2) BLOCK VƯỢT TỔNG NHU CẦU (mục 6): thêm 1 người sẽ vượt → cần override hợp lệ.
  const currentTotal = state.allocations.length;
  const wouldExceed = currentTotal >= state.totalRequest;
  const overrideValid =
    override !== undefined && override.confirmed && (override.reason ?? "").trim().length > 0;

  if (wouldExceed && !overrideValid) {
    return { outcome: "REJECTED", code: "TOTAL_OVER_TARGET", message: TOTAL_OVER_TARGET_MESSAGE };
  }

  // 3) Dự báo trạng thái sau khi thêm (để sinh warning giới tính — không chặn lệch cơ cấu).
  const projectedCounts = addGender(
    { male: countBy(state.allocations, "male"), female: countBy(state.allocations, "female"), total: currentTotal },
    target.gender,
  );

  const warnings = computeWarnings({
    maleRequest: state.maleRequest,
    femaleRequest: state.femaleRequest,
    totalRequest: state.totalRequest,
    maleCurrent: projectedCounts.male,
    femaleCurrent: projectedCounts.female,
    totalCurrent: projectedCounts.total,
  });

  return {
    outcome: "ALLOCATE",
    existingForWorker: state.existingForWorker,
    overrideApplied: wouldExceed && overrideValid,
    projectedCounts,
    warnings,
  };
}

function countBy(allocations: ActiveAllocationRef[], gender: "male" | "female"): number {
  return allocations.filter((a) => a.gender === gender).length;
}

/* ============================================================
   CÁC HÀM THUẦN HỖ TRỢ KHÁC
   ============================================================ */

/** Tổng hợp dashboard từ danh sách KPI request (mục 13). */
export function aggregateRequestKpis(kpis: RequestKpi[]): {
  totalRequested: GenderCounts;
  currentWorkforce: GenderCounts;
  totalRecruited: GenderCounts;
  totalQuit: GenderCounts;
  needToRecruit: GenderCounts;
} {
  const acc = {
    totalRequested: emptyCounts(),
    currentWorkforce: emptyCounts(),
    totalRecruited: emptyCounts(),
    totalQuit: emptyCounts(),
    needToRecruit: emptyCounts(),
  };
  for (const k of kpis) {
    acc.totalRequested.male += k.maleRequest;
    acc.totalRequested.female += k.femaleRequest;
    acc.totalRequested.total += k.totalRequest;
    acc.currentWorkforce.male += k.maleCurrent;
    acc.currentWorkforce.female += k.femaleCurrent;
    acc.currentWorkforce.total += k.totalCurrent;
    acc.totalRecruited.male += k.maleRecruited;
    acc.totalRecruited.female += k.femaleRecruited;
    acc.totalRecruited.total += k.totalRecruited;
    acc.totalQuit.male += k.maleQuit;
    acc.totalQuit.female += k.femaleQuit;
    acc.totalQuit.total += k.totalQuit;
    acc.needToRecruit.male += k.maleBalance;
    acc.needToRecruit.female += k.femaleBalance;
    acc.needToRecruit.total += k.totalBalance;
  }
  return acc;
}
