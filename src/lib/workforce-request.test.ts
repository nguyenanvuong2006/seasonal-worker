import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyGender,
  computeBalance,
  computeRequestKpi,
  computeWarnings,
  aggregateRequestKpis,
  isActiveEmploymentSession,
  planAllocation,
  resolveTotalRequest,
  TOTAL_OVER_TARGET_MESSAGE,
  type ActiveAllocationRef,
  type AllocationPlanState,
} from "./workforce-request-kpi.ts";

/* ============================================================
   TEST SET — Workforce Request ↔ Planning ↔ Employment/Allocation
   Tương ứng mục 16 của yêu cầu:
   A. 5M+5F, phân bổ 7M+3F → cho phép + MALE_OVER_TARGET.
   B. Tổng 10, phân bổ người thứ 11 → từ chối (không override).
   C. Có planning.overallocate + reason → cho phép + audit (override).
   D. Chuyển Request A → B: A giảm 1, B tăng 1, tổng công ty không đổi.
   E. Nghỉ việc: Current giảm 1, Quit tăng 1, Balance tăng tương ứng.
   F. Request hết hạn nhưng worker ACTIVE → Employment không đổi.
   G. Gọi lặp / double-click → không double allocation.
   ============================================================ */

const M = "male" as const;
const F = "female" as const;

function ref(id: string, requestId: string, workerId: string, gender: "male" | "female" | "unknown"): ActiveAllocationRef {
  return { id, requestId, sessionId: `s-${workerId}`, workerId, gender };
}

function baseState(targetRequestId: string, totalRequest: number, maleRequest: number, femaleRequest: number, allocations: ActiveAllocationRef[] = [], existingForWorker: ActiveAllocationRef | null = null): AllocationPlanState {
  return { targetRequestId, totalRequest, maleRequest, femaleRequest, allocations, existingForWorker };
}

/** Áp dụng 1 plan lên danh sách ACTIVE allocations (mô phỏng lớp DB của service). */
function applyPlan(
  allocations: ActiveAllocationRef[],
  targetRequestId: string,
  worker: { sessionId: string; workerId: string; gender: "male" | "female" | "unknown" },
  plan: ReturnType<typeof planAllocation>,
): ActiveAllocationRef[] {
  if (plan.outcome === "NOOP" || plan.outcome === "REJECTED") return allocations;
  let next = allocations;
  if (plan.existingForWorker) {
    next = next.filter((a) => a.id !== plan.existingForWorker!.id); // ENDED
  }
  // unique partial index tương đương: không tồn tại ACTIVE khác của cùng worker
  assert.equal(next.some((a) => a.workerId === worker.workerId), false, "worker phải rời allocation cũ trước khi vào mới");
  return [...next, ref(`al-${worker.workerId}@${targetRequestId}`, targetRequestId, worker.workerId, worker.gender)];
}

/* ----------------------- CÔNG THỨC (mục 3) ----------------------- */

test("Balance = max(0, Request - Current + Quit), Total = Male + Female", () => {
  assert.deepEqual(computeBalance({ maleRequest: 5, femaleRequest: 5, maleCurrent: 7, femaleCurrent: 3, maleQuit: 0, femaleQuit: 0 }), {
    maleBalance: 0,
    femaleBalance: 2,
    totalBalance: 2,
  });
  assert.deepEqual(computeBalance({ maleRequest: 5, femaleRequest: 5, maleCurrent: 4, femaleCurrent: 4, maleQuit: 1, femaleQuit: 1 }), {
    maleBalance: 2,
    femaleBalance: 2,
    totalBalance: 4,
  });
  // Không âm: current vượt request + quit
  assert.equal(computeBalance({ maleRequest: 5, femaleRequest: 0, maleCurrent: 9, femaleCurrent: 0, maleQuit: 1, femaleQuit: 0 }).maleBalance, 0);
});

test("Total Request = Male + Female; fallback legacy total_request khi cả 2 = 0", () => {
  assert.equal(resolveTotalRequest(5, 5), 10);
  assert.equal(resolveTotalRequest(0, 0, 12), 12);
  assert.equal(resolveTotalRequest(0, 0, 0), 0);
});

test("classifyGender khớp quy ước hệ thống (nam/nữ/male/female/m/f + includes)", () => {
  assert.equal(classifyGender("Nam"), "male");
  assert.equal(classifyGender("M"), "male");
  assert.equal(classifyGender("male"), "male");
  assert.equal(classifyGender("Nữ"), "female");
  assert.equal(classifyGender("nu"), "female");
  assert.equal(classifyGender("F"), "female");
  assert.equal(classifyGender("female"), "female");
  assert.equal(classifyGender(""), "unknown");
  assert.equal(classifyGender(null), "unknown");
});

/* ----------------------- WARNING (mục 5 + 7) ----------------------- */

test("Warnings: lệch cơ cấu Nam/Nữ là SOFT warning, TOTAL_OVER_TARGET là BLOCKING", () => {
  const warnings = computeWarnings({ maleRequest: 5, femaleRequest: 5, totalRequest: 10, maleCurrent: 7, femaleCurrent: 3, totalCurrent: 10 });
  const codes = warnings.map((w) => w.code);
  assert.ok(codes.includes("MALE_OVER_TARGET"));
  assert.ok(codes.includes("FEMALE_SHORTAGE"));
  assert.ok(!codes.includes("TOTAL_OVER_TARGET"));
  assert.ok(!codes.includes("FULFILLED"));
  const maleOver = warnings.find((w) => w.code === "MALE_OVER_TARGET")!;
  assert.equal(maleOver.severity, "SOFT");
  assert.equal(maleOver.message, "Nam đang vượt cơ cấu yêu cầu 2 người; tổng nhân lực vẫn trong giới hạn.");

  const over = computeWarnings({ maleRequest: 5, femaleRequest: 5, totalRequest: 10, maleCurrent: 6, femaleCurrent: 5, totalCurrent: 11 });
  const overCodes = over.map((w) => w.code);
  assert.ok(overCodes.includes("TOTAL_OVER_TARGET"));
  assert.equal(over.find((w) => w.code === "TOTAL_OVER_TARGET")!.severity, "BLOCKING");
  assert.equal(over.find((w) => w.code === "TOTAL_OVER_TARGET")!.message, TOTAL_OVER_TARGET_MESSAGE);

  const fulfilled = computeWarnings({ maleRequest: 5, femaleRequest: 5, totalRequest: 10, maleCurrent: 5, femaleCurrent: 5, totalCurrent: 10 });
  assert.ok(fulfilled.map((w) => w.code).includes("FULFILLED"));
});

test("TOTAL_OVER_TARGET_MESSAGE là đúng chuỗi yêu cầu", () => {
  assert.equal(TOTAL_OVER_TARGET_MESSAGE, "Tổng phân bổ đã vượt tổng nhu cầu.");
});

/* ----------------------- TEST A (mục 16.A) ----------------------- */

test("A. Request 5M+5F, phân bổ 7M+3F → cho phép + MALE_OVER_TARGET", () => {
  let allocations: ActiveAllocationRef[] = [];
  const mkState = () => baseState("RQ-A", 10, 5, 5, allocations);
  for (let i = 0; i < 7; i++) {
    const plan = planAllocation(mkState(), { sessionId: `s-m${i}`, workerId: `w-m${i}`, gender: M });
    assert.equal(plan.outcome, "ALLOCATE", `phân bổ nam thứ ${i + 1} phải được phép`);
    allocations = applyPlan(allocations, "RQ-A", { sessionId: `s-m${i}`, workerId: `w-m${i}`, gender: M }, plan);
  }
  for (let i = 0; i < 3; i++) {
    const plan = planAllocation(mkState(), { sessionId: `s-f${i}`, workerId: `w-f${i}`, gender: F });
    assert.equal(plan.outcome, "ALLOCATE", `phân bổ nữ thứ ${i + 1} phải được phép`);
    allocations = applyPlan(allocations, "RQ-A", { sessionId: `s-f${i}`, workerId: `w-f${i}`, gender: F }, plan);
  }
  assert.equal(allocations.length, 10);
  assert.equal(allocations.filter((a) => a.gender === "male").length, 7);
  assert.equal(allocations.filter((a) => a.gender === "female").length, 3);

  const kpi = computeRequestKpi({
    maleRequest: 5,
    femaleRequest: 5,
    totalRequest: 10,
    maleCurrent: 7,
    femaleCurrent: 3,
    maleRecruited: 10,
    femaleRecruited: 0,
    maleQuit: 0,
    femaleQuit: 0,
  });
  const codes = kpi.warnings.map((w) => w.code);
  assert.ok(codes.includes("MALE_OVER_TARGET"), "phải có cảnh báo Nam vượt cơ cấu");
  assert.ok(codes.includes("FEMALE_SHORTAGE"), "phải có cảnh báo thiếu Nữ");
  assert.ok(!codes.includes("TOTAL_OVER_TARGET"), "tổng vẫn trong giới hạn → không chặn");
  assert.equal(kpi.maleBalance, 0);
  assert.equal(kpi.femaleBalance, 2);
  assert.equal(kpi.totalBalance, 2);
  assert.equal(kpi.fillRatePercent, 100);
});

/* ----------------------- TEST B + C (mục 16.B + 16.C) ----------------------- */

test("B. Tổng 10, phân bổ người thứ 11 → REJECT nếu không có override", () => {
  const allocations = Array.from({ length: 10 }, (_, i) => ref(`al${i}`, "RQ-B", `w${i}`, i % 2 === 0 ? M : F));
  const plan = planAllocation(baseState("RQ-B", 10, 5, 5, allocations), { sessionId: "s11", workerId: "w11", gender: M });
  assert.equal(plan.outcome, "REJECTED");
  if (plan.outcome === "REJECTED") {
    assert.equal(plan.code, "TOTAL_OVER_TARGET");
    assert.equal(plan.message, TOTAL_OVER_TARGET_MESSAGE);
  }
});

test("C. override {confirmed: true, reason} → cho phép người thứ 11 + đánh dấu override", () => {
  const allocations = Array.from({ length: 10 }, (_, i) => ref(`al${i}`, "RQ-C", `w${i}`, i % 2 === 0 ? M : F));
  const plan = planAllocation(
    baseState("RQ-C", 10, 5, 5, allocations),
    { sessionId: "s11", workerId: "w11", gender: M },
    { confirmed: true, reason: "Đơn hàng tăng đột biến, Giám đốc duyệt vượt chỉ tiêu" },
  );
  assert.equal(plan.outcome, "ALLOCATE");
  if (plan.outcome === "ALLOCATE") {
    assert.equal(plan.overrideApplied, true);
    assert.equal(plan.projectedCounts.total, 11);
    assert.ok(plan.warnings.map((w) => w.code).includes("TOTAL_OVER_TARGET"), "vẫn phải hiển thị warning vượt tổng sau override");
  }
});

test("C2. override thiếu reason hoặc chưa confirm → vẫn REJECT", () => {
  const allocations = Array.from({ length: 10 }, (_, i) => ref(`al${i}`, "RQ-C2", `w${i}`, M));
  for (const override of [{ confirmed: true, reason: "" }, { confirmed: true, reason: "   " }, { confirmed: false, reason: "x" }]) {
    const plan = planAllocation(baseState("RQ-C2", 10, 10, 0, allocations), { sessionId: "s11", workerId: "w11", gender: M }, override);
    assert.equal(plan.outcome, "REJECTED", `override ${JSON.stringify(override)} phải bị từ chối`);
  }
});

/* ----------------------- TEST D (mục 16.D) ----------------------- */

test("D. Chuyển Request A → B: A giảm 1, B tăng 1, tổng công ty không đổi", () => {
  const allocA = [ref("a1", "RQ-A", "w1", M), ref("a2", "RQ-A", "w2", F)];
  const allocB = [ref("b1", "RQ-B", "w3", M)];
  const companyTotal = allocA.length + allocB.length;

  const plan = planAllocation(
    baseState("RQ-B", 10, 5, 5, allocB, allocA[0]),
    { sessionId: "s-w1", workerId: "w1", gender: M },
  );
  assert.equal(plan.outcome, "ALLOCATE");
  if (plan.outcome === "ALLOCATE") {
    assert.ok(plan.existingForWorker, "phải có allocation cũ cần kết thúc");
    assert.equal(plan.existingForWorker!.requestId, "RQ-A");
    assert.equal(plan.existingForWorker!.workerId, "w1");
  }

  // Áp dụng: kết thúc allocation A của w1, tạo allocation B của w1.
  const afterA = applyPlan(allocA, "RQ-B", { sessionId: "s-w1", workerId: "w1", gender: M }, plan).filter((a) => a.requestId === "RQ-A");
  const afterB = applyPlan([...allocA, ...allocB], "RQ-B", { sessionId: "s-w1", workerId: "w1", gender: M }, plan).filter((a) => a.requestId === "RQ-B");
  const afterAll = applyPlan([...allocA, ...allocB], "RQ-B", { sessionId: "s-w1", workerId: "w1", gender: M }, plan);

  assert.equal(afterA.length, allocA.length - 1, "A phải giảm 1");
  assert.equal(afterB.length, allocB.length + 1, "B phải tăng 1");
  assert.equal(afterAll.length, companyTotal, "tổng nhân lực công ty không đổi");
  assert.equal(afterAll.filter((a) => a.workerId === "w1").length, 1, "worker chỉ xuất hiện 1 lần (không double count)");

  // KHÔNG tạo Resignation: plan engine không có bất kỳ chỉ thị nào về resignation/session.
  if (plan.outcome === "ALLOCATE") {
    assert.equal("sessionClose" in plan, false);
  }
});

/* ----------------------- TEST E (mục 16.E) ----------------------- */

test("E. Worker nghỉ việc → Current giảm 1, Quit tăng 1, Balance tăng tương ứng", () => {
  const before = computeRequestKpi({
    maleRequest: 5,
    femaleRequest: 5,
    totalRequest: 10,
    maleCurrent: 5,
    femaleCurrent: 5,
    maleRecruited: 10,
    femaleRecruited: 0,
    maleQuit: 0,
    femaleQuit: 0,
  });
  assert.equal(before.maleBalance, 0);
  assert.ok(before.warnings.map((w) => w.code).includes("FULFILLED"));

  const after = computeRequestKpi({
    maleRequest: 5,
    femaleRequest: 5,
    totalRequest: 10,
    maleCurrent: 4, // Current giảm 1
    femaleCurrent: 5,
    maleRecruited: 10,
    femaleRecruited: 0,
    maleQuit: 1, // Quit tăng 1
    femaleQuit: 0,
  });
  assert.equal(after.maleCurrent, before.maleCurrent - 1);
  assert.equal(after.maleQuit, before.maleQuit + 1);
  assert.equal(after.maleBalance, 2, "Balance = max(0, 5 - 4 + 1) = 2");
  assert.ok(after.warnings.map((w) => w.code).includes("MALE_SHORTAGE"));
});

/* ----------------------- TEST F (mục 16.F) ----------------------- */

test("F. Planning Request hết hạn nhưng worker vẫn ACTIVE → Employment không thay đổi", () => {
  // Employment ACTIVE chỉ phụ thuộc status + endDate — KHÔNG có tham số nào về
  // trạng thái Planning/Request trong hàm kiểm tra (đúng thiết kế: request
  // EXPIRED không đụng tới employment session).
  assert.equal(isActiveEmploymentSession("APPROVED", null), true);
  assert.equal(isActiveEmploymentSession("APPROVED", "2026-08-15"), false);
  assert.equal(isActiveEmploymentSession("REJECTED", null), false);

  // Kết thúc 1 ALLOCATION (request hết hạn) không sinh bất kỳ thay đổi session nào:
  // planAllocation không có chỉ thị đóng session — worker vẫn ACTIVE cho tới khi
  // có nghiệp vụ nghỉ việc thật.
  const plan = planAllocation(
    baseState("RQ-B", 10, 5, 5, [ref("b1", "RQ-B", "w3", M)], ref("a1", "RQ-A", "w1", M)),
    { sessionId: "s-w1", workerId: "w1", gender: M },
  );
  assert.equal(plan.outcome, "ALLOCATE");
  if (plan.outcome === "ALLOCATE") {
    assert.equal(plan.existingForWorker!.requestId, "RQ-A");
  }
});

/* ----------------------- TEST G (mục 16.G) ----------------------- */

test("G. Gọi lặp / double-click → NOOP, không double allocation", () => {
  const allocations = [ref("a1", "RQ-G", "w1", M)];
  const state = () => baseState("RQ-G", 10, 5, 5, allocations, allocations[0]);
  const first = planAllocation(state(), { sessionId: "s-w1", workerId: "w1", gender: M });
  assert.equal(first.outcome, "NOOP");

  // Dù gọi bao nhiêu lần, danh sách ACTIVE vẫn 1 phần tử.
  const after = applyPlan(allocations, "RQ-G", { sessionId: "s-w1", workerId: "w1", gender: M }, first);
  assert.equal(after.filter((a) => a.workerId === "w1").length, 1);
  const again = planAllocation(baseState("RQ-G", 10, 5, 5, after, after[0]), { sessionId: "s-w1", workerId: "w1", gender: M });
  assert.equal(again.outcome, "NOOP");
  assert.equal(after.length, 1);
});

/* ----------------------- DASHBOARD (mục 13) ----------------------- */

test("aggregateRequestKpis tổng hợp đúng Nam/Nữ/Tổng", () => {
  const kpiA = computeRequestKpi({
    maleRequest: 5, femaleRequest: 5, totalRequest: 10,
    maleCurrent: 4, femaleCurrent: 6,
    maleRecruited: 4, femaleRecruited: 6,
    maleQuit: 1, femaleQuit: 0,
  });
  const kpiB = computeRequestKpi({
    maleRequest: 3, femaleRequest: 0, totalRequest: 3,
    maleCurrent: 3, femaleCurrent: 0,
    maleRecruited: 3, femaleRecruited: 0,
    maleQuit: 0, femaleQuit: 0,
  });
  const agg = aggregateRequestKpis([kpiA, kpiB]);
  assert.deepEqual(agg.totalRequested, { male: 8, female: 5, total: 13 });
  assert.deepEqual(agg.currentWorkforce, { male: 7, female: 6, total: 13 });
  assert.deepEqual(agg.totalQuit, { male: 1, female: 0, total: 1 });
  assert.deepEqual(agg.needToRecruit, { male: 2, female: 0, total: 2 });
});

/* ----------------------- FILL RATE ----------------------- */

test("fillRatePercent: đáp ứng đủ = 100, vượt = 100 (clamp), không có nhu cầu = 0", () => {
  const full = computeRequestKpi({
    maleRequest: 5, femaleRequest: 5, totalRequest: 10,
    maleCurrent: 5, femaleCurrent: 5,
    maleRecruited: 0, femaleRecruited: 0, maleQuit: 0, femaleQuit: 0,
  });
  assert.equal(full.fillRatePercent, 100);
  const over = computeRequestKpi({
    maleRequest: 5, femaleRequest: 5, totalRequest: 10,
    maleCurrent: 7, femaleCurrent: 5,
    maleRecruited: 0, femaleRecruited: 0, maleQuit: 0, femaleQuit: 0,
  });
  assert.equal(over.fillRatePercent, 100);
  const zero = computeRequestKpi({
    maleRequest: 0, femaleRequest: 0, totalRequest: 0,
    maleCurrent: 0, femaleCurrent: 0,
    maleRecruited: 0, femaleRecruited: 0, maleQuit: 0, femaleQuit: 0,
  });
  assert.equal(zero.fillRatePercent, 0);
});

/* ----------------------- Giới tính unknown chỉ tính vào tổng ----------------------- */

test("Gender unknown không bị tính nhầm vào Nam hoặc Nữ", () => {
  const kpi = computeRequestKpi({
    maleRequest: 5, femaleRequest: 5, totalRequest: 10,
    maleCurrent: 4, femaleCurrent: 4,
    maleRecruited: 0, femaleRecruited: 0, maleQuit: 0, femaleQuit: 0,
  });
  assert.equal(kpi.totalCurrent, 8);
  assert.equal(kpi.maleCurrent + kpi.femaleCurrent, 8);
  assert.equal(computeWarnings({ maleRequest: 5, femaleRequest: 5, totalRequest: 10, maleCurrent: 4, femaleCurrent: 4, totalCurrent: 9 })
    .some((w) => w.code === "TOTAL_OVER_TARGET"), false);
});
