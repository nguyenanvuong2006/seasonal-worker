/**
 * Validation helpers for the public electronic signature box
 * used on /lookup after the recruiter dispatches a merged document.
 */

export const MAX_SIGNATURE_DATA_URL_LENGTH = 400_000;
export const MIN_SIGNATURE_DATA_URL_LENGTH = 80;

const SIGNATURE_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$/i;

export function isValidSignatureDataUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SIGNATURE_DATA_URL_LENGTH) return false;
  if (trimmed.length > MAX_SIGNATURE_DATA_URL_LENGTH) return false;
  if (!trimmed.startsWith("data:image/")) return false;
  return SIGNATURE_DATA_URL_RE.test(trimmed);
}

export type ConfirmationQuestion = {
  fieldKey: string;
  questionText: string;
  isRequired: boolean;
};

export function validateConfirmedAnswers(
  questions: ConfirmationQuestion[],
  answers: Record<string, unknown> | null | undefined,
): { ok: true; answers: Record<string, string> } | { ok: false; error: string } {
  const source = answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};
  const normalized: Record<string, string> = {};

  for (const question of questions) {
    const raw = source[question.fieldKey];
    const value = raw === undefined || raw === null ? "" : String(raw).trim();
    if (question.isRequired && !value) {
      return { ok: false, error: `Thiếu câu trả lời bắt buộc: "${question.questionText}"` };
    }
    if (value) normalized[question.fieldKey] = value;
  }

  return { ok: true, answers: normalized };
}

export function normalizeConfirmedAnswersInput(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    if (raw === undefined || raw === null) continue;
    const text = String(raw).trim();
    if (text) out[key] = text;
  }
  return out;
}
