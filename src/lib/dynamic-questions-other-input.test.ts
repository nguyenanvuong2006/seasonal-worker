import test from "node:test";
import assert from "node:assert/strict";

type FormQuestion = {
  id: string;
  fieldKey: string;
  questionText: string;
  fieldType: string;
  options: string[] | null;
  isRequired: boolean;
};

const validateAnswers = (applicableQuestions: FormQuestion[], customAnswers: Record<string, string>) => {
  for (const question of applicableQuestions) {
    if (question.isRequired && !customAnswers[question.fieldKey]?.trim()) {
      return { ok: false, error: `Thiếu: ${question.questionText}` };
    }
    const hasOtherOption = question.fieldType === "SELECT" && question.options?.some((opt) => opt.trim().toLowerCase() === "khác");
    const isOtherSelected = customAnswers[question.fieldKey] === "Khác";
    if (hasOtherOption && isOtherSelected) {
      if (!customAnswers[`${question.fieldKey}__other`]?.trim()) {
        return { ok: false, error: `Thiếu: Nội dung "Khác" cho ${question.questionText}` };
      }
    }
  }
  return { ok: true };
};

test("Generic Other Input - Public Form & Server Validation", async (t) => {
  const question: FormQuestion = {
    id: "1",
    fieldKey: "dan_toc",
    questionText: "Dân tộc",
    fieldType: "SELECT",
    options: ["Kinh", "Khác"],
    isRequired: true,
  };

  await t.test("Rejects Khác without companion text", () => {
    const customAnswers = { dan_toc: "Khác" };
    const result = validateAnswers([question], customAnswers);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Thiếu: Nội dung "Khác" cho Dân tộc');
  });

  await t.test("Accepts Khác with companion text", () => {
    const customAnswers = { dan_toc: "Khác", dan_toc__other: "Tày" };
    const result = validateAnswers([question], customAnswers);
    assert.equal(result.ok, true);
  });

  await t.test("Accepts regular option", () => {
    const customAnswers = { dan_toc: "Kinh" };
    const result = validateAnswers([question], customAnswers);
    assert.equal(result.ok, true);
  });
  
  await t.test("Rejects missing required answer", () => {
    const customAnswers = {};
    const result = validateAnswers([question], customAnswers);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Thiếu: Dân tộc');
  });
});
