/**
 * The exact consent statement shown to the candidate and hashed into the
 * evidence record. Bumping CONSENT_VERSION (and updating CONSENT_TEXT
 * together) is the only supported way to change wording — old confirmations
 * keep their own frozen consentText/consentTextHash forever, unaffected.
 */
export const CONSENT_VERSION = "v1";
export const CONSENT_TEXT =
  "Tôi xác nhận đã đọc và đồng ý với toàn bộ nội dung của tài liệu này.";
