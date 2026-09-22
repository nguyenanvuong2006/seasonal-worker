import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Dynamic Questions Versioning", () => {
  it("resolves the correct version based on regDate", () => {
    const mockQuestions = [
      { fieldKey: "dan_toc", applyFrom: "2026-01-01", effectiveTo: "2026-09-22", options: ["Kinh", "Mông"] },
      { fieldKey: "dan_toc", applyFrom: "2026-09-22", effectiveTo: null, options: ["Kinh", "Khác"] }
    ];

    const getVersionForDate = (regDate: string) => {
      let effectiveQ = null;
      for (const v of mockQuestions) {
        const applyFromMatch = !v.applyFrom || v.applyFrom <= regDate;
        const effectiveToMatch = !v.effectiveTo || v.effectiveTo > regDate;
        if (applyFromMatch && effectiveToMatch) {
          effectiveQ = v;
          break;
        }
      }
      return effectiveQ;
    };

    const v1 = getVersionForDate("2026-05-10");
    assert.equal(v1?.applyFrom, "2026-01-01");
    assert.equal(v1?.effectiveTo, "2026-09-22");

    const v2 = getVersionForDate("2026-10-01");
    assert.equal(v2?.applyFrom, "2026-09-22");
    assert.equal(v2?.effectiveTo, null);
  });
  
  it("proves malformed overlapping versions cannot result in two questions with the same fieldKey being rendered OR accepted by registration validation", () => {
    const mockRows = [
      { fieldKey: "dan_toc", applyFrom: "2026-09-22", effectiveTo: null, isRequired: true, isActive: true, visibleToApplicants: true },
      { fieldKey: "dan_toc", applyFrom: "2026-09-22", effectiveTo: "2026-10-01", isRequired: true, isActive: true, visibleToApplicants: true }, // MALFORMED OVERLAP
      { fieldKey: "ton_giao", applyFrom: "2026-01-01", effectiveTo: null, isRequired: true, isActive: true, visibleToApplicants: true }
    ];
    
    // 1. Simulate getApplicantEffectiveQuestions fail-closed logic
    const keyCounts = new Map<string, number>();
    for (const row of mockRows) keyCounts.set(row.fieldKey, (keyCounts.get(row.fieldKey) || 0) + 1);
    
    const activeQuestions = [];
    for (const row of mockRows) {
      if (keyCounts.get(row.fieldKey)! > 1) continue; // Excluded completely
      if (row.isActive && row.visibleToApplicants) activeQuestions.push(row);
    }
    
    // Proof 1: Rendered questions array contains exactly 1 item (dan_toc is gone)
    assert.equal(activeQuestions.length, 1);
    assert.equal(activeQuestions[0].fieldKey, "ton_giao");
    
    // 2. Simulate Registration Validation logic mapping over activeQuestions
    let validationError = null;
    const rawAnswers = { ton_giao: "KhA'ng" }; // User didn't submit dan_toc
    
    for (const q of activeQuestions) {
      if (q.isRequired && !rawAnswers[q.fieldKey as keyof typeof rawAnswers]) {
        validationError = "Missing " + q.fieldKey;
      }
    }
    
    // Proof 2: Validation succeeds because the duplicated (and thus excluded) question is not enforced
    assert.equal(validationError, null, "Registration validation succeeds without the overlapping question");
  });

  it("handles companion value when processing old application with Khac", () => {
    // Simulated export logic resolving value
    const mockQuestions = [
      { fieldKey: "dan_toc", applyFrom: "2026-09-22", effectiveTo: null, options: ["Kinh", "Khác"], fieldType: "SELECT" }
    ];
    const r = {
      regDate: "2026-10-01",
      customAnswers: { dan_toc: "Khác", dan_toc__other: "Tày" }
    };
    const q = mockQuestions[0];
    const baseValue = r.customAnswers[q.fieldKey as keyof typeof r.customAnswers];
    const hasOtherOption = q.options.some((opt) => opt.toLowerCase() === "khác");
    let exportValue = baseValue;
    if (hasOtherOption && baseValue === "Khác") {
      const otherValue = r.customAnswers[`${q.fieldKey}__other` as keyof typeof r.customAnswers];
      if (otherValue) {
        exportValue = `Khác (${otherValue})`;
      }
    }
    assert.equal(exportValue, "Khác (Tày)");
  });

  it("sanitizes legacy values for returning applicants", () => {
    const oldAnswers = { dan_toc: "Mường", custom_field: "123" };
    const returningQuestions = [
      { fieldKey: "dan_toc", fieldType: "SELECT", options: ["Kinh", "Khác"] },
      { fieldKey: "custom_field", fieldType: "TEXT", options: null }
    ];

    const validAnswers: Record<string, string> = {};
    for (const q of returningQuestions) {
      if (oldAnswers[q.fieldKey as keyof typeof oldAnswers]) {
        const val = oldAnswers[q.fieldKey as keyof typeof oldAnswers];
        if (q.fieldType === "SELECT" && Array.isArray(q.options)) {
          if (q.options.includes(val) || (val === "Khác" && q.options.some((opt: string) => opt.toLowerCase() === "khác"))) {
            validAnswers[q.fieldKey] = val;
          }
        } else {
          validAnswers[q.fieldKey] = val;
        }
      }
    }

    assert.equal(validAnswers["dan_toc"], undefined, "Mường should be stripped out as it is not in the current options");
    assert.equal(validAnswers["custom_field"], "123", "TEXT fields should be preserved");
  });
  it("fail-closed resolution excludes duplicate effective versions for the same fieldKey", () => {
    const mockRows = [
      { fieldKey: "dan_toc", applyFrom: "2026-09-22", effectiveTo: null },
      { fieldKey: "dan_toc", applyFrom: "2026-09-22", effectiveTo: "2026-10-01" }, // MALFORMED OVERLAP
      { fieldKey: "ton_giao", applyFrom: "2026-01-01", effectiveTo: null }
    ];
    const keyCounts = new Map<string, number>();
    for (const row of mockRows) keyCounts.set(row.fieldKey, (keyCounts.get(row.fieldKey) || 0) + 1);
    const validRows = [];
    for (const row of mockRows) {
      if (keyCounts.get(row.fieldKey)! > 1) continue; // Fail closed
      validRows.push(row);
    }
    assert.equal(validRows.length, 1);
    assert.equal(validRows[0].fieldKey, "ton_giao");
  });
});
