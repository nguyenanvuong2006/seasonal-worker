export const VN_TZ_OFFSET_MINUTES = 7 * 60;

/** Today in Asia/Ho_Chi_Minh as YYYY-MM-DD (server & client safe). */
export function todayStr(): string {
  const now = new Date();
  const vn = new Date(now.getTime() + (VN_TZ_OFFSET_MINUTES + now.getTimezoneOffset()) * 60000);
  const y = vn.getFullYear();
  const m = String(vn.getMonth() + 1).padStart(2, "0");
  const d = String(vn.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const [y, m, d] = value.slice(0, 10).split("-");
  if (!y || !m || !d) return value;
  return `${d}/${m}/${y}`;
}

export function isFemale(gender?: string | null): boolean {
  if (!gender) return false;
  const g = gender.trim().toLowerCase();
  return g === "nữ" || g === "nu" || g === "female" || g === "f" || g.includes("nữ") || g.includes("nu");
}

export function isMale(gender?: string | null): boolean {
  if (!gender) return false;
  const g = gender.trim().toLowerCase();
  if (isFemale(gender)) return false;
  return g === "nam" || g === "male" || g === "m" || g.includes("nam");
}

export function maskCccd(cccd?: string | null): string {
  if (!cccd) return "—";
  const clean = cccd.trim();
  if (clean.length <= 4) return clean;
  return "•".repeat(clean.length - 4) + clean.slice(-4);
}

export const STATUS_META: Record<
  string,
  { label: string; tone: "gray" | "green" | "amber" | "red" | "blue" }
> = {
  PENDING: { label: "Chờ duyệt", tone: "amber" },
  APPROVED: { label: "Đã nhận việc", tone: "green" },
  REJECTED: { label: "Không nhận", tone: "red" },
  WAITLIST: { label: "Dự phòng", tone: "blue" },
};

export const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Quản trị viên",
  HR_RECRUITER: "Nhân sự tuyển dụng",
  DEPT_MANAGER: "Quản lý bộ phận",
};

export { isValidCccd } from "@/lib/validators";

export function isValidPhone(v: string) {
  return /^0\d{8,10}$/.test(v);
}
