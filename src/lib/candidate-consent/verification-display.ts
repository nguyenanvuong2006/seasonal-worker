/**
 * Display-only formatting for the public verification page + receipt —
 * pure functions, no DB/fetch, safe to import from both server and client
 * components. Deliberately says nothing about certificates/CA signing (see
 * the mission's own wording constraints) — every label here describes
 * tamper-evident evidence, never a certified digital signature.
 */
import type { PublicVerificationStatus } from "./verification-service.ts";

export function formatConfirmedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

/** "abcdef0123...9876fedcba" — never the full value in the UI's default view. */
export function abbreviateHash(hash: string, headLen = 8, tailLen = 8): string {
  if (hash.length <= headLen + tailLen + 1) return hash;
  return `${hash.slice(0, headLen)}…${hash.slice(-tailLen)}`;
}

export type StatusTone = "green" | "amber" | "red" | "gray";

export interface StatusPresentation {
  label: string;
  description: string;
  tone: StatusTone;
}

const STATUS_PRESENTATION: Record<PublicVerificationStatus, StatusPresentation> = {
  VALID: {
    label: "Hợp lệ",
    description: "Thông tin xác nhận và tài liệu khớp với bằng chứng được hệ thống ghi nhận.",
    tone: "green",
  },
  REVOKED: {
    label: "Đã thu hồi",
    description: "Hồ sơ này đã bị thu hồi. Thông tin xác nhận gốc bên dưới vẫn được lưu trữ nguyên vẹn.",
    tone: "gray",
  },
  SUPERSEDED: {
    label: "Đã được thay thế",
    description: "Hồ sơ này đã được thay thế bằng một hồ sơ mới hơn. Thông tin xác nhận gốc bên dưới vẫn được lưu trữ nguyên vẹn.",
    tone: "amber",
  },
  INVALID: {
    label: "Không hợp lệ",
    description: "Không thể xác minh tính toàn vẹn của bằng chứng xác nhận cho hồ sơ này.",
    tone: "red",
  },
  NOT_FOUND: {
    label: "Không tìm thấy",
    description: "Không tìm thấy hồ sơ xác nhận nào khớp với mã này. Vui lòng kiểm tra lại đường dẫn hoặc mã xác nhận.",
    tone: "gray",
  },
};

export function statusPresentation(status: PublicVerificationStatus): StatusPresentation {
  return STATUS_PRESENTATION[status];
}
