import test from "node:test";
import assert from "node:assert/strict";
import { classifyDepartmentRisk, type RiskSignals } from "./risk-rules.ts";

const ZERO: RiskSignals = { currentGap: 0, totalRequested: 0, recentExits: 0, recentMovementOutflow: 0, openRecruitmentGapCount: 0, upcomingDemandCount: 0 };

test("no signals at all -> LOW, with an explicit 'no risk' factor rather than an empty list", () => {
  const r = classifyDepartmentRisk(ZERO);
  assert.equal(r.level, "LOW");
  assert.equal(r.score, 0);
  assert.deepEqual(r.factors, ["Không có dấu hiệu rủi ro thiếu người rõ rệt."]);
});

test("a severe gap ratio alone (>=25% of requested) is enough to reach HIGH", () => {
  const r = classifyDepartmentRisk({ ...ZERO, currentGap: 30, totalRequested: 100 });
  assert.equal(r.level, "HIGH");
  assert.equal(r.score, 2);
  assert.match(r.factors[0], /30 người/);
  assert.match(r.factors[0], /30%/);
});

test("a moderate gap ratio (10-25%) alone reaches only MEDIUM, never HIGH by itself", () => {
  const r = classifyDepartmentRisk({ ...ZERO, currentGap: 15, totalRequested: 100 });
  assert.equal(r.level, "MEDIUM");
  assert.equal(r.score, 1);
});

test("a small gap ratio (<10%) alone stays LOW", () => {
  const r = classifyDepartmentRisk({ ...ZERO, currentGap: 5, totalRequested: 100 });
  assert.equal(r.level, "LOW");
  assert.equal(r.score, 0);
  assert.match(r.factors[0], /mức nhẹ/);
});

test("a nonzero gap with totalRequested=0 is treated as a full (100%) ratio, not a division-by-zero crash", () => {
  const r = classifyDepartmentRisk({ ...ZERO, currentGap: 5, totalRequested: 0 });
  assert.equal(r.level, "HIGH");
});

test("multiple moderate signals accumulate to HIGH even without a severe gap", () => {
  const r = classifyDepartmentRisk({
    currentGap: 15,
    totalRequested: 100, // +1 (medium gap)
    recentExits: 3, // +1
    recentMovementOutflow: 2, // +1
    openRecruitmentGapCount: 1, // +1
    upcomingDemandCount: 0,
  });
  assert.equal(r.score, 4);
  assert.equal(r.level, "HIGH");
  assert.equal(r.factors.length, 4);
});

test("every nonzero signal contributes its own distinct, traceable factor string", () => {
  const r = classifyDepartmentRisk({
    currentGap: 5,
    totalRequested: 100,
    recentExits: 2,
    recentMovementOutflow: 1,
    openRecruitmentGapCount: 3,
    upcomingDemandCount: 4,
  });
  assert.equal(r.factors.length, 5); // gap(mức nhẹ) + exits + movement + recruitment + upcoming
  assert.ok(r.factors.some((f) => f.includes("nghỉ việc")));
  assert.ok(r.factors.some((f) => f.includes("thuyên chuyển")));
  assert.ok(r.factors.some((f) => f.includes("Yêu cầu tuyển dụng")));
  assert.ok(r.factors.some((f) => f.includes("Workforce Request sắp đến hạn")));
});

test("classification is a pure function — same input always yields the same output", () => {
  const input: RiskSignals = { currentGap: 12, totalRequested: 80, recentExits: 1, recentMovementOutflow: 0, openRecruitmentGapCount: 0, upcomingDemandCount: 0 };
  const a = classifyDepartmentRisk(input);
  const b = classifyDepartmentRisk(input);
  assert.deepEqual(a, b);
});
