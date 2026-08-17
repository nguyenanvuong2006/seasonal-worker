/**
 * Document Merge — retention policy (Phase 2).
 *
 * Default: 3 năm kể từ ngày merge (tính RIÊNG từng PDF).
 * Template builder có thể cấu hình: 1/2/3/5/10 năm hoặc "Không tự xoá" (null).
 * Policy được SNAPSHOT vào document_history.retention_policy_snapshot lúc tạo PDF;
 * đổi template sau này KHÔNG tự sửa retention của tài liệu cũ.
 *
 * Module THUẦN (không import server-only) — dùng được ở worker + cron + agent.
 */

export const RETENTION_OPTIONS = [
  { years: 1, label: "1 năm" },
  { years: 2, label: "2 năm" },
  { years: 3, label: "3 năm" },
  { years: 5, label: "5 năm" },
  { years: 10, label: "10 năm" },
  { years: null, label: "Không tự động xóa" },
] as const;

export type RetentionPolicy = {
  years: number | null;
  /** Nguồn của policy: 'template' | 'default' | 'admin_override' */
  source: "template" | "default" | "admin_override";
};

/** Retention mặc định khi không cấu hình (năm). */
export const DEFAULT_RETENTION_YEARS = 3;

/** Đọc default retention từ ENV (số năm hợp lệ, fallback 3). */
export function getDefaultRetentionYears(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.MERGE_DEFAULT_RETENTION_YEARS);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 100) return Math.floor(raw);
  return DEFAULT_RETENTION_YEARS;
}

/** Policy hợp lệ từ cấu hình template. years: null = không tự xoá. */
export function isAllowedRetentionYears(years: number | null | undefined): boolean {
  if (years === null || years === undefined) return true;
  return RETENTION_OPTIONS.some((option) => option.years === years);
}

/**
 * Tính retention_until từ ngày tạo PDF.
 * @param generatedAt Ngày tạo PDF (snapshot).
 * @param templateYears Cấu hình template (null = không tự xoá).
 * @param fallbackYears Giá trị mặc định khi template chưa cấu hình.
 */
export function computeRetentionUntil(
  generatedAt: Date,
  templateYears: number | null | undefined,
  fallbackYears: number | null = DEFAULT_RETENTION_YEARS,
): { retentionUntil: Date | null; policy: RetentionPolicy } {
  const hasExplicitTemplatePolicy = templateYears !== undefined;
  const years = hasExplicitTemplatePolicy ? templateYears : fallbackYears;
  if (years === null) {
    return { retentionUntil: null, policy: { years: null, source: hasExplicitTemplatePolicy ? "template" : "default" } };
  }
  const until = new Date(generatedAt.getTime());
  until.setUTCFullYear(until.getUTCFullYear() + years);
  return {
    retentionUntil: until,
    policy: { years, source: templateYears === undefined ? "default" : "template" },
  };
}

/** PDF còn trong vòng đời online? (chưa hết hạn retention) */
export function isWithinRetention(retentionUntil: Date | null, now: Date = new Date()): boolean {
  if (retentionUntil === null) return true; // "Không tự động xóa"
  return now.getTime() <= retentionUntil.getTime();
}
