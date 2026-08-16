/* ============================================================
   PURE UTILITIES — không import "server-only"
   Có thể chạy trong test và client
   ============================================================ */

/* ============================================================
   HEADER ALIAS MAPPING — cho phép nhận biến thể tên cột
   khi paste từ Excel/Google Sheets
   ============================================================ */
const HEADER_ALIASES: Record<string, string[]> = {
  "Request Code": ["request_code", "ma yeu cau", "mã yêu cầu", "request code", "code", "ma tuyen dung", "mã tuyển dụng"],
  Requester: ["requester", "nguoi yeu cau", "người yêu cầu", "nguoi de xuat", "người đề xuất"],
  Position: ["position", "vi tri", "vị trí", "chuc vu", "chức vụ"],
  "Job title": ["job_title", "job title", "chuc danh", "chức danh", "cong viec", "công việc", "job"],
  Location: ["location", "dia diem", "địa điểm", "noi lam viec", "nơi làm việc", "loc"],
  Division: ["division", "khoi", "khối"],
  Department: ["department", "phong ban", "phòng ban", "bo phan", "bộ phận", "dept", "department_text", "department text"],
  Section: ["section", "to_nhom", "tổ"],
  Group: ["group", "nhom", "nhóm", "group_name", "group name"],
  Reason: ["reason", "ly do", "lý do", "nguyen nhan", "nguyên nhân"],
  "Note for reason": ["note_for_reason", "note for reason", "ghi chu ly do", "ghi chú lý do"],
  "Special Requirements": ["special_requirements", "special requirements", "yeu cau dac biet", "yêu cầu đặc biệt"],
  "Male Rq": ["male_rq", "male rq", "nam rq", "nam can", "nam cần", "male required"],
  "Female Rq": ["female_rq", "female rq", "nu rq", "nữ rq", "nu can", "nữ cần", "female required"],
  "Male Application": ["male_application", "male application", "nam app"],
  "Female Application": ["female_application", "female application", "nu app"],
  "Male Interviewed": ["male_interviewed", "male interviewed", "nam pv"],
  "Female Interviewed": ["female_interviewed", "female interviewed", "nu pv"],
  "Male Recruited": ["male_recruited", "male recruited", "nam tuyen", "nam tuyển"],
  "Female Recruited": ["female_recruited", "female recruited", "nu tuyen", "nữ tuyển"],
  "Male Quit": ["male_quit", "male quit", "nam nghi", "nam nghỉ"],
  "Female Quit": ["female_quit", "female quit", "nu nghi", "nữ nghỉ"],
  "Male Balance": ["male_balance", "male balance"],
  "Female Balance": ["female_balance", "female balance"],
  "Total Balance": ["total_balance", "total balance"],
  Status: ["status", "trang thai", "trạng thái"],
  "Requested Date": ["requested_date", "requested date", "ngay yeu cau", "ngày yêu cầu"],
  "Expected Date": ["expected_date", "expected date", "ngay du kien", "ngày dự kiến"],
  "Offered Date": ["offered_date", "offered date", "ngay de nghi", "ngày đề nghị"],
  "Completed Date": ["completed_date", "completed date", "ngay hoan thanh", "ngày hoàn thành"],
  Month: ["month", "thang", "tháng"],
  Cost: ["cost", "chi phi", "chi phí"],
  Remarks: ["remarks", "ghi chu", "ghi chú"],
  To: ["to", "den", "đến"],
  "Rq Status": ["rq_status", "rq status"],
  Month_Rc: ["month_rc", "month rc", "thang rc"],
  "Total Request": ["total_request", "total request"],
  "Recruited vs Expected": ["recruited_vs_expected", "recruited vs expected"],
  Screened: ["screened", "da loc", "đã lọc"],
  Interview: ["interview", "phong van", "phỏng vấn"],
  Recruit: ["recruit", "tuyen", "tuyển"],
  Month_Report: ["month_report", "month report"],
};

/** Chuẩn hoá tên header để so khớp không phân biệt hoa/thường/dấu/khoảng trắng */
export function normalizeHeaderName(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "");
}

/** Map 1 header từ Excel/TSV sang tên field chuẩn (canonical)
 *
 *  Ưu tiên: (1) khớp chính xác canonical name, (2) khớp alias.
 *  Điều này giải quyết xung đột khi alias của 1 field trùng với canonical name
 *  của field khác (vd "To" và "Section" đều có alias "to"/"tổ").
 */
export function resolveHeaderAlias(header: string): string | null {
  const normalized = normalizeHeaderName(header);
  if (!normalized) return null;

  // Bước 1: Khớp canonical name trước
  for (const canonical of Object.keys(HEADER_ALIASES)) {
    if (normalizeHeaderName(canonical) === normalized) return canonical;
  }

  // Bước 2: Khớp alias
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      if (normalizeHeaderName(alias) === normalized) return canonical;
    }
  }

  return null;
}

/** Map toàn bộ headers của 1 dòng dữ liệu sang field chuẩn */
export function mapRowToCanonical(
  rawRow: Record<string, string>,
): { canonical: Record<string, string>; unknownHeaders: string[] } {
  const canonical: Record<string, string> = {};
  const unknownHeaders: string[] = [];
  for (const [header, value] of Object.entries(rawRow)) {
    const resolved = resolveHeaderAlias(header);
    if (resolved) {
      canonical[resolved] = value;
    } else {
      unknownHeaders.push(header);
    }
  }
  return { canonical, unknownHeaders };
}

/* ============================================================
   VALIDATION
   ============================================================ */
export type ValidationResult = {
  valid: boolean;
  errors: { field: string; message: string }[];
  warnings: { field: string; message: string }[];
};

export function validateRow(row: Record<string, string>): ValidationResult {
  const errors: { field: string; message: string }[] = [];
  const warnings: { field: string; message: string }[] = [];

  // Request Code is required
  if (!row["Request Code"]?.trim()) {
    errors.push({ field: "Request Code", message: "Request Code là bắt buộc" });
  }

  // Validate numeric fields
  const numericFields = [
    "Male Rq", "Female Rq", "Male Application", "Female Application",
    "Male Interviewed", "Female Interviewed", "Male Recruited", "Female Recruited",
    "Male Quit", "Female Quit", "Male Balance", "Female Balance", "Total Balance",
    "Total Request", "Screened", "Interview", "Recruit", "Cost",
  ];
  for (const field of numericFields) {
    if (row[field] && isNaN(Number(row[field]))) {
      errors.push({ field, message: `"${field}" phải là số` });
    }
  }

  // Validate dates
  const dateFields = ["Requested Date", "Expected Date", "Offered Date", "Completed Date"];
  for (const field of dateFields) {
    if (row[field]?.trim()) {
      const d = parseDate(row[field]);
      if (!d) {
        errors.push({ field, message: `"${field}" không đúng định dạng ngày (dd/MM/yyyy hoặc yyyy-MM-dd)` });
      }
    }
  }

  // Validate status
  if (row["Status"]?.trim()) {
    const s = row["Status"].trim().toUpperCase();
    const validStatuses = ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED"];
    if (!validStatuses.includes(s)) {
      warnings.push({ field: "Status", message: `"${row["Status"]}" không phải status chuẩn, sẽ chuyển thành PENDING` });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function parseDate(s: string): string | null {
  // Try dd/MM/yyyy
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const d = parseInt(m1[1]), mo = parseInt(m1[2]), y = parseInt(m1[3]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 1900 && y <= 2100) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  // Try yyyy-MM-dd
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) {
    const y = parseInt(m2[1]), mo = parseInt(m2[2]), d = parseInt(m2[3]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 1900 && y <= 2100) {
      return s;
    }
  }
  return null;
}

export function toInt(v: string | undefined, def = 0): number {
  if (!v?.trim()) return def;
  const n = parseInt(v.trim().replace(/[^0-9\-]/g, ""));
  return isNaN(n) ? def : n;
}

/* ============================================================
   BALANCE COMPUTATION
   ============================================================ */
export function computeBalanceFromCanonical(canonical: Record<string, string>) {
  const maleRq = toInt(canonical["Male Rq"]);
  const femaleRq = toInt(canonical["Female Rq"]);
  const maleRecruited = toInt(canonical["Male Recruited"]);
  const femaleRecruited = toInt(canonical["Female Recruited"]);
  const maleQuit = toInt(canonical["Male Quit"]);
  const femaleQuit = toInt(canonical["Female Quit"]);

  // Male Balance = Male Rq - Male Allocated/Recruited + Male Quit
  const maleBalance = Math.max(0, maleRq - maleRecruited + maleQuit);
  // Female Balance = Female Rq - Female Allocated/Recruited + Female Quit
  const femaleBalance = Math.max(0, femaleRq - femaleRecruited + femaleQuit);
  // Total Balance = Male Balance + Female Balance
  const totalBalance = maleBalance + femaleBalance;

  return { maleBalance, femaleBalance, totalBalance };
}

export function normalizeStatus(s: string | undefined): string | null {
  if (!s?.trim()) return null;
  const upper = s.trim().toUpperCase();
  const valid = ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED"];
  if (valid.includes(upper)) return upper;
  if (upper.includes("PEND")) return "PENDING";
  if (upper.includes("PROCESS") || upper.includes("PROGRESS")) return "PROCESSING";
  if (upper.includes("COMPLETE") || upper.includes("DONE")) return "COMPLETED";
  if (upper.includes("CANCEL")) return "CANCELLED";
  return null;
}