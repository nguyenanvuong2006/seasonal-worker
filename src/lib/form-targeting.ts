export const TARGET_AUDIENCES = ["ALL", "NEW_ONLY", "RETURNING_ONLY"] as const;

export type TargetAudience = (typeof TARGET_AUDIENCES)[number];
export type ApplicantAudience = "NEW" | "RETURNING";

export type TargetedQuestion = {
  visibleToApplicants: boolean;
  targetAudience: string;
  skipForReturning: boolean;
};

export function normalizeTargetAudience(value: unknown): TargetAudience {
  return TARGET_AUDIENCES.includes(value as TargetAudience) ? (value as TargetAudience) : "ALL";
}

/**
 * Nguồn sự thật dùng chung giữa form công khai và API đăng ký.
 * `skipForReturning` là công tắc ưu tiên cao nhất để giữ tương thích với các
 * câu hỏi cũ; `targetAudience` cho phép nhắm nhóm chi tiết hơn.
 */
export function isQuestionForAudience(
  question: TargetedQuestion,
  audience: ApplicantAudience,
): boolean {
  if (!question.visibleToApplicants) return false;
  if (audience === "RETURNING" && question.skipForReturning) return false;

  const target = normalizeTargetAudience(question.targetAudience);
  if (target === "NEW_ONLY") return audience === "NEW";
  if (target === "RETURNING_ONLY") return audience === "RETURNING";
  return true;
}
