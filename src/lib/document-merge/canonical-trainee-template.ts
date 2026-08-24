/**
 * CANONICAL TRAINEE REGISTRATION TEMPLATE INVARIANT
 * 
 * There is exactly ONE authoritative template family for:
 * "Đăng ký tập nghề - Quy định tập nghề"
 * 
 * Its canonical authoring source is:
 * templates/document-merge/trainee-registration/canonical-source.html
 * 
 * This module provides the stable identity used by runtime selection logic.
 * It must NEVER fall back to array order, newest row, or Google Doc title.
 */

export const CANONICAL_TRAINEE_TEMPLATE_KEY = 'dang-ky-tap-nghe' as const;
export const CANONICAL_TRAINEE_GOOGLE_DOC_ID = '10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE' as const;

export function isCanonicalTraineeTemplate(googleDocId: string | null | undefined): boolean {
  return googleDocId === CANONICAL_TRAINEE_GOOGLE_DOC_ID;
}

export function assertCanonicalTraineeTemplate(googleDocId: string | null | undefined): asserts googleDocId is string {
  if (!isCanonicalTraineeTemplate(googleDocId)) {
    throw new Error(
      `CANONICAL_TEMPLATE_MISMATCH: Expected canonical trainee-registration template ` +
      `(${CANONICAL_TRAINEE_GOOGLE_DOC_ID}), got ${googleDocId ?? 'null'}`
    );
  }
}
