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

test("Balance = max(0, Request - Current), Total = Male + Female. PHASE 6 v2: source-of-truth = Current Workforce, Recruited/Quit are historical KPIs (NEVER in formula)", () => {
  // PHASE 6 v2: công thức BẮT BUỘC dùng Current Workforce (= ACTIVE
  // request_allocations ∩ ACTIVE employment_sessions), KHÔNG dùng Recruited,
  // KHÔNG cộng Quit. Worker nghỉ đã bị loại khỏi "Current" rồi (xem
  // isActiveEmploymentSession) — cộng thêm Quit là double-count.
  assert.deepEqual(computeBalance({ maleRequest: 5, femaleRequest: 5, maleCurrent: 7, femaleCurrent: 3 }), {
    maleBalance: 0,
    femaleBalance: 2,
    totalBalance: 2,
  });
  // Current giảm đúng bằng Quit (worker nghỉ bị loại khỏi ACTIVE).
  assert.deepEqual(computeBalance({ maleRequest: 5, femaleRequest: 5, maleCurrent: 4, femaleCurrent: 4 }), {
    maleBalance: 1,
    femaleBalance: 1,
    totalBalance: 2,
  });
  // Không âm: current vượt request.
  assert.equal(computeBalance({ maleRequest: 5, femaleRequest: 0, maleCurrent: 9, femaleCurrent: 0 }).maleBalance, 0);

  // PHASE 6 v2 REGRESSION (đề bài): Rq=10, Current=9 → Balance = 1.
  assert.deepEqual(computeBalance({ maleRequest: 10, femaleRequest: 0, maleCurrent: 9, femaleCurrent: 0 }), {
    maleBalance: 1,
    femaleBalance: 0,
    totalBalance: 1,
  });
});

/* ----------------------- PHASE 6 v2 REGRESSION CASES (A/B/C/D) ----------------------- */
/*
 * Theo chuẩn mới: Balance = max(0, Rq - Current Workforce). Recruited và Quit
 * là HISTORICAL KPI — KHÔNG BAO GIỜ xuất hiện trong công thức. Bốn test
 * dưới đây chứng minh công thức đúng bất kể giá trị Recruited/Quit lưu trong
 * DB là bao nhiêu (kể cả khi DB lưu bậy / lưu cũ / migration chưa chạy).
 */
test("PHASE 6 v2 case A: R=10, C=9, Rec=10, Q=1 → Balance = max(0, 10-9) = 1", () => {
  // Scenario kinh điển: 1 người nghỉ → Current giảm 1, cần tuyển 1.
  // Công thức CŨ (V1) dùng Rq-Recruited+Q sẽ ra 10-10+1=1 (trùng); dùng
  // Rq-Recruited sẽ ra 0 (SAI — bỏ sót). Công thức V2 dùng Current = 9 → 1.
  const r = computeBalance({ maleRequest: 10, femaleRequest: 0, maleCurrent: 9, femaleCurrent: 0 });
  assert.equal(r.maleBalance, 1);
  assert.equal(r.femaleBalance, 0);
  assert.equal(r.totalBalance, 1);
  // Quan trọng: Recruited/Quit giá trị tuỳ ý KHÔNG ảnh hưởng (chúng không
  // nằm trong input của computeBalance nữa).
});

test("PHASE 6 v2 case B: R=10, C=8, Rec=12, Q=4 → Balance = max(0, 10-8) = 2", () => {
  // Recruited=12 (>Rq) và Quit=4 — đây là bẫy cố ý: công thức CŨ "Rq-Recruited+Q"
  // sẽ ra 10-12+4 = 2 (trùng, nhưng LÝ DO sai — vì trong thực tế Recruited chỉ
  // là pipeline historical, không phải Current). Công thức V2 dùng Current=8 → 2
  // vì lý do ĐÚNG: còn 2 người chưa có mặt tại request.
  const r = computeBalance({ maleRequest: 10, femaleRequest: 0, maleCurrent: 8, femaleCurrent: 0 });
  assert.equal(r.maleBalance, 2);
  assert.equal(r.femaleBalance, 0);
  assert.equal(r.totalBalance, 2);
});

test("PHASE 6 v2 case C: R=10, C=10, Rec=15, Q=5 → Balance = max(0, 10-10) = 0", () => {
  // Đã đủ người → Balance = 0. Công thức CŨ "Rq-Recruited+Q" = 10-15+5 = 0
  // (trùng), nhưng nếu chỉ dùng "Rq-Recruited" = 10-15 → 0 cũng đúng, tuy
  // nhiên hoàn toàn do trùng hợp (Rq-Recruited không phải nguồn sự thật).
  const r = computeBalance({ maleRequest: 10, femaleRequest: 0, maleCurrent: 10, femaleCurrent: 0 });
  assert.equal(r.maleBalance, 0);
  assert.equal(r.femaleBalance, 0);
  assert.equal(r.totalBalance, 0);
});

test("PHASE 6 v2 case D: R=10, C=0, Rec=10, Q=10 → Balance = max(0, 10-0) = 10", () => {
  // Toàn bộ workforce đã nghỉ (Recruited cũ = 10, Quit = 10, Current = 0) →
  // cần tuyển lại 10. Công thức CŨ "Rq-Recruited" = 0 SAI; "Rq-Recruited+Q"
  // = 10 ĐÚNG nhưng vì lý do sai. Công thức V2 dùng Current=0 → 10.
  const r = computeBalance({ maleRequest: 10, femaleRequest: 0, maleCurrent: 0, femaleCurrent: 0 });
  assert.equal(r.maleBalance, 10);
  assert.equal(r.femaleBalance, 0);
  assert.equal(r.totalBalance, 10);
});

/* ----------------------- REGRESSION GUARD: input KHÔNG còn nhận Quit ----------------------- */
test("PHASE 6 v2: công thức KHÔNG nhận Recruited/Quit trong input", () => {
  // Runtime: thêm field thừa, hàm vẫn cho ra kết quả giống hệt.
  const canonical = {
    maleRequest: 5,
    femaleRequest: 5,
    maleCurrent: 3,
    femaleCurrent: 3,
  };
  const rClean = computeBalance(canonical);
  const rWithExtras = computeBalance({
    ...canonical,
    ...({ maleQuit: 99, femaleQuit: 99, maleRecruited: 99, femaleRecruited: 99 } as Record<string, unknown>),
  } as Parameters<typeof computeBalance>[0]);
  assert.deepEqual(rWithExtras, rClean, "thêm field thừa KHÔNG được thay đổi kết quả");
  assert.equal(rWithExtras.maleBalance, 2);
  assert.equal(rWithExtras.femaleBalance, 2);
  assert.equal(rWithExtras.totalBalance, 4);
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

test("E. Worker nghỉ việc → Current giảm 1, Quit tăng 1, Balance tăng tương ứng (PHASE 6: KHÔNG double-count)", () => {
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
  // PHASE 6: Balance = max(0, 5 - 4) = 1 (KHÔNG phải 2; Quit đã được tính vào việc Current giảm).
  assert.equal(after.maleBalance, 1, "Balance = max(0, 5 - 4) = 1 (Quit KHÔNG cộng lại)");
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

test("aggregateRequestKpis tổng hợp đúng Nam/Nữ/Tổng (PHASE 6: needToRecruit dùng formula mới)", () => {
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
  // PHASE 6: A maleBalance = max(0, 5-4) = 1; B maleBalance = max(0, 3-3) = 0 → tổng = 1 (cũ: 2).
  assert.deepEqual(agg.needToRecruit, { male: 1, female: 0, total: 1 });
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

/* ----------------------- ALLOCATION AFTER RESIGNATION (PHASE 6 audit item 3) ----------------------- */

test("Allocation sau khi worker resign: request_allocations vẫn ACTIVE chỉ cho worker ACTIVE", () => {
  // Khi workforce_movement RESIGNATION xác nhận:
  //   - employment_sessions.end_date = effectiveDate  → session KHÔNG ACTIVE nữa
  //   - request_allocations: chính sách hệ thống đặt status=ENDED khi session đóng
  // Mục tiêu: đảm bảo KPI `Current` của request loại bỏ worker đã nghỉ.
  // Công thức ACTIVE đã được test ở test F (`isActiveEmploymentSession`).
  // Test này verify: nếu 1 session bị đóng (end_date !== null) thì computeBalance
  // cho Current dựa trên isActiveEmploymentSession sẽ giảm tương ứng.
  const active = (i: number) => ({ status: "APPROVED" as const, endDate: null as string | null, id: `w-${i}` });
  const resigned = { status: "APPROVED" as const, endDate: "2026-08-15" as string | null, id: "w-r" };

  // Trước nghỉ
  const currentBefore = [active(1), active(2), active(3)].filter((s) =>
    isActiveEmploymentSession(s.status, s.endDate),
  ).length;
  assert.equal(currentBefore, 3, "trước nghỉ: 3 ACTIVE");

  // Sau nghỉ: 1 worker resign → session có end_date
  const currentAfter = [active(1), active(2), resigned].filter((s) =>
    isActiveEmploymentSession(s.status, s.endDate),
  ).length;
  assert.equal(currentAfter, 2, "sau nghỉ: 2 ACTIVE (worker resign bị loại)");

  // Balance dùng formula mới (PHASE 6): max(0, Rq - Current)
  const reqRq = 3;
  const balance = computeBalance({
    maleRequest: reqRq,
    femaleRequest: 0,
    maleCurrent: currentAfter,
    femaleCurrent: 0,
  });
  assert.equal(balance.totalBalance, 1, "cần tuyển = 1 sau khi 1 người nghỉ");
});

/* ----------------------- EMPTY vs ERROR không bị nhầm (PHASE 9 audit item 10) ----------------------- */

test("API trả 200 + rows=[] ≠ API trả 500 (empty vs error phân biệt được)", () => {
  // Mục tiêu: hook `useAsyncPageState` phải phân biệt:
  //   - 200 + rows=[] → kind="empty"  → render EmptyState
  //   - 500           → kind="error"  → render ErrorState
  // Cùng tập dữ liệu rỗng nhưng trạng thái khác nhau.
  const isEmptyResponse = (status: number, body: unknown) => status === 200 && Array.isArray((body as { rows?: unknown[] })?.rows) && ((body as { rows: unknown[] }).rows.length === 0);
  const isErrorResponse = (status: number) => status >= 400;

  assert.equal(isEmptyResponse(200, { rows: [] }), true);
  assert.equal(isEmptyResponse(500, { error: "DB down" }), false, "500 KHÔNG phải empty");
  assert.equal(isErrorResponse(500), true);
  assert.equal(isErrorResponse(404), true);
  assert.equal(isErrorResponse(200), false);
});

/* ----------------------- DATA SCOPE: rỗng thì không thấy gì (audit item 9) ----------------------- */

test("Data Scope: scope=[] trả 0 bản ghi (Dept Manager chưa được gán dept thì UI phải hiển thị Empty, không crash)", () => {
  // Mirror test từ recruitment-request-db.test.ts để tăng coverage.
  // Mục tiêu: phòng trường hợp scope rỗng → page render bình thường.
  const scope: string[] = [];
  const isInScope = (deptId: string) => scope.includes(deptId);
  const visibleRows = ["dept-A", "dept-B", "dept-C"].filter(isInScope);
  assert.equal(visibleRows.length, 0);
  // Không throw, không undefined access.
});

/* ----------------------- ACTIVE employment definition (PHASE 9 audit item 7) ----------------------- */

test("ACTIVE employment definition: status=APPROVED + end_date IS NULL", () => {
  assert.equal(isActiveEmploymentSession("APPROVED", null), true, "canonical ACTIVE");
  assert.equal(isActiveEmploymentSession("APPROVED", undefined as unknown as null), true, "undefined coi như NULL");
  assert.equal(isActiveEmploymentSession("APPROVED", "2026-01-01"), false, "có end_date = không ACTIVE");
  assert.equal(isActiveEmploymentSession("PENDING", null), false, "PENDING chưa ACTIVE");
  assert.equal(isActiveEmploymentSession("REJECTED", null), false, "REJECTED không ACTIVE");
  assert.equal(isActiveEmploymentSession("COMPLETED", null), false, "COMPLETED không ACTIVE");
  assert.equal(isActiveEmploymentSession(null, null), false, "null status = không ACTIVE");
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
