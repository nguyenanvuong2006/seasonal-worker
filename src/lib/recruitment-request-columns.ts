/* ============================================================
   RECRUITMENT REQUEST — COLUMN CATALOG (PURE, no "server-only")
   ------------------------------------------------------------
   NGUỒN SỰ THẬT DUY NHẤT cho toàn bộ tập cột của Planning /
   Workforce Recruitment Request.

   Yêu cầu #2: KHÔNG hardcode danh sách cột trong UI. UI chỉ đọc
   catalog này + bản ghi cấu hình lưu trong DB (planning_column_configs).
   Module này thuần tuý (không import DB / server-only) nên dùng được
   ở cả server, client và unit test.

   Yêu cầu #10: mỗi cột khai báo rõ NGUỒN SỰ THẬT (`source`):
     - SYSTEM : hệ thống tự tính từ Daily Application / Employment
                Session / planning_allocations / workforce_movements.
                Import Excel KHÔNG được phép ghi đè.
     - DERIVED: công thức thuần từ các cột khác (Balance, ratio...).
                Import Excel KHÔNG được phép ghi đè.
     - INPUT  : do Recruiter/HR nhập hoặc import từ Excel.
   ============================================================ */

export type ColumnSource = "SYSTEM" | "DERIVED" | "INPUT";
export type ColumnType = "text" | "longtext" | "number" | "money" | "date" | "status" | "percent" | "days";
export type ColumnGroup = "identity" | "org" | "reason" | "demand" | "funnel" | "balance" | "dates" | "meta";
export type DeviceKind = "desktop" | "mobile";

export type ColumnDef = {
  /** Khoá ổn định — dùng trong DB config, API sort/filter và UI. */
  key: string;
  /** Nhãn gốc theo file Excel Recruitment Request của Dalat Hasfarm. */
  label: string;
  /** Nhãn tiếng Việt hiển thị trên UI. */
  labelVi: string;
  group: ColumnGroup;
  type: ColumnType;
  source: ColumnSource;
  /** Cột có thể dùng để sắp xếp phía server. */
  sortable?: boolean;
  /** Cột nên ghim (sticky) khi Admin bật sticky cho cột đó. */
  stickyCapable?: boolean;
  /** Độ rộng gợi ý (px) cho bảng ngang. */
  width?: number;
  /** Ưu tiên hiển thị trên mobile (thấp = quan trọng hơn). */
  mobilePriority?: number;
};

/* ------------------------------------------------------------
   CATALOG — thứ tự khai báo = thứ tự mặc định của bảng.
   ------------------------------------------------------------ */
export const RECRUITMENT_REQUEST_COLUMNS: ColumnDef[] = [
  // --- Identity ---------------------------------------------------------
  { key: "requestCode", label: "Request Code", labelVi: "Mã yêu cầu", group: "identity", type: "text", source: "INPUT", sortable: true, stickyCapable: true, width: 150, mobilePriority: 1 },
  { key: "requester", label: "Requester", labelVi: "Người yêu cầu", group: "identity", type: "text", source: "INPUT", sortable: true, width: 150, mobilePriority: 6 },
  { key: "position", label: "Position", labelVi: "Vị trí", group: "identity", type: "text", source: "INPUT", sortable: true, width: 150, mobilePriority: 5 },
  { key: "jobTitle", label: "Job title", labelVi: "Chức danh", group: "identity", type: "text", source: "INPUT", width: 160 },

  // --- Org structure (Location → Division → Department → Section → Group)
  { key: "location", label: "Location", labelVi: "Địa điểm", group: "org", type: "text", source: "INPUT", sortable: true, width: 120 },
  { key: "division", label: "Division", labelVi: "Khối", group: "org", type: "text", source: "INPUT", sortable: true, width: 120 },
  { key: "department", label: "Department", labelVi: "Phòng ban", group: "org", type: "text", source: "INPUT", sortable: true, stickyCapable: true, width: 160, mobilePriority: 3 },
  { key: "section", label: "Section", labelVi: "Tổ", group: "org", type: "text", source: "INPUT", sortable: true, width: 120 },
  { key: "groupName", label: "Group", labelVi: "Nhóm", group: "org", type: "text", source: "INPUT", sortable: true, width: 120 },

  // --- Reason -----------------------------------------------------------
  { key: "reason", label: "Reason", labelVi: "Lý do", group: "reason", type: "text", source: "INPUT", sortable: true, width: 160 },
  { key: "noteForReason", label: "Note for reason", labelVi: "Ghi chú lý do", group: "reason", type: "longtext", source: "INPUT", width: 200 },
  { key: "specialRequirements", label: "Special Requirements", labelVi: "Yêu cầu đặc biệt", group: "reason", type: "longtext", source: "INPUT", width: 200 },

  // --- Demand (nhu cầu) -------------------------------------------------
  { key: "maleRq", label: "Male Rq", labelVi: "Nam yêu cầu", group: "demand", type: "number", source: "INPUT", sortable: true, width: 90, mobilePriority: 7 },
  { key: "femaleRq", label: "Female Rq", labelVi: "Nữ yêu cầu", group: "demand", type: "number", source: "INPUT", sortable: true, width: 90, mobilePriority: 8 },
  { key: "totalRequest", label: "Total Request", labelVi: "Tổng yêu cầu", group: "demand", type: "number", source: "DERIVED", sortable: true, width: 100, mobilePriority: 4 },

  // --- Funnel (tự động từ Daily Application / Allocation / Movement) -----
  { key: "maleApplication", label: "Male Application", labelVi: "Nam ứng tuyển", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 100 },
  { key: "femaleApplication", label: "Female Application", labelVi: "Nữ ứng tuyển", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 100 },
  { key: "maleInterviewed", label: "Male Interviewed", labelVi: "Nam phỏng vấn", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 100 },
  { key: "femaleInterviewed", label: "Female Interviewed", labelVi: "Nữ phỏng vấn", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 100 },
  { key: "maleRecruited", label: "Male Recruited", labelVi: "Nam đã tuyển", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 100, mobilePriority: 9 },
  { key: "femaleRecruited", label: "Female Recruited", labelVi: "Nữ đã tuyển", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 100, mobilePriority: 10 },
  { key: "maleQuit", label: "Male Quit", labelVi: "Nam nghỉ", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 90 },
  { key: "femaleQuit", label: "Female Quit", labelVi: "Nữ nghỉ", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 90 },
  { key: "screened", label: "Screened", labelVi: "Đã sàng lọc", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 100 },
  { key: "interview", label: "Interview", labelVi: "Phỏng vấn", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 100 },
  { key: "recruit", label: "Recruit", labelVi: "Tuyển", group: "funnel", type: "number", source: "SYSTEM", sortable: true, width: 100 },

  // --- Balance (công thức, không cho Excel ghi đè) ----------------------
  { key: "maleBalance", label: "Male Balance", labelVi: "Còn thiếu Nam", group: "balance", type: "number", source: "DERIVED", sortable: true, width: 100 },
  { key: "femaleBalance", label: "Female Balance", labelVi: "Còn thiếu Nữ", group: "balance", type: "number", source: "DERIVED", sortable: true, width: 100 },
  { key: "totalBalance", label: "Total Balance", labelVi: "Tổng còn thiếu", group: "balance", type: "number", source: "DERIVED", sortable: true, width: 110, mobilePriority: 11 },
  { key: "recruitedVsExpected", label: "Recruited vs Expected", labelVi: "Đã tuyển / Kế hoạch", group: "balance", type: "percent", source: "DERIVED", sortable: true, width: 130 },

  // --- Dates (Yêu cầu #6 — SÁU trường ngày TÁCH BIỆT) -------------------
  { key: "requestedDate", label: "Requested Date", labelVi: "Ngày yêu cầu", group: "dates", type: "date", source: "INPUT", sortable: true, width: 120 },
  { key: "expectedDate", label: "Expected Date", labelVi: "Ngày cần nhân lực", group: "dates", type: "date", source: "INPUT", sortable: true, stickyCapable: true, width: 130, mobilePriority: 2 },
  { key: "startingDate", label: "Starting Date", labelVi: "Ngày nhận việc", group: "dates", type: "date", source: "INPUT", sortable: true, width: 120 },
  { key: "endDate", label: "End Date", labelVi: "Ngày kết thúc yêu cầu", group: "dates", type: "date", source: "INPUT", sortable: true, width: 140 },
  { key: "offeredDate", label: "Offered Date", labelVi: "Ngày đề nghị", group: "dates", type: "date", source: "INPUT", sortable: true, width: 120 },
  { key: "completedDate", label: "Completed Date", labelVi: "Ngày tuyển đủ", group: "dates", type: "date", source: "INPUT", sortable: true, width: 130 },
  { key: "offeredVsRequested", label: "Offered vs Requested", labelVi: "Offered − Yêu cầu (ngày)", group: "dates", type: "days", source: "DERIVED", sortable: true, width: 140 },
  { key: "completedVsRequested", label: "Completed vs Requested", labelVi: "Tuyển đủ − Yêu cầu (ngày)", group: "dates", type: "days", source: "DERIVED", sortable: true, width: 150 },

  // --- Meta -------------------------------------------------------------
  { key: "status", label: "Status", labelVi: "Trạng thái", group: "meta", type: "status", source: "INPUT", sortable: true, width: 120, mobilePriority: 12 },
  { key: "month", label: "Month", labelVi: "Tháng", group: "meta", type: "text", source: "INPUT", sortable: true, width: 90 },
  { key: "monthRc", label: "Month_Rc", labelVi: "Tháng tuyển", group: "meta", type: "text", source: "INPUT", sortable: true, width: 100 },
  { key: "monthReport", label: "Month_Report", labelVi: "Tháng báo cáo", group: "meta", type: "text", source: "INPUT", sortable: true, width: 110 },
  { key: "cost", label: "Cost", labelVi: "Chi phí", group: "meta", type: "money", source: "INPUT", sortable: true, width: 110 },
  { key: "to", label: "ToRq", labelVi: "Chuyển tới", group: "meta", type: "text", source: "INPUT", width: 120 },
  { key: "rqStatus", label: "ToRq Status", labelVi: "Trạng thái ToRq", group: "meta", type: "text", source: "INPUT", sortable: true, width: 130 },
  { key: "remarks", label: "Remarks", labelVi: "Ghi chú", group: "meta", type: "longtext", source: "INPUT", width: 200 },
];

export const COLUMN_BY_KEY: Record<string, ColumnDef> = Object.fromEntries(
  RECRUITMENT_REQUEST_COLUMNS.map((c) => [c.key, c]),
);

export const ALL_COLUMN_KEYS: string[] = RECRUITMENT_REQUEST_COLUMNS.map((c) => c.key);

/** Cột KHÔNG được phép ghi đè bằng import Excel/Sheets (Yêu cầu #10). */
export const SYSTEM_OWNED_COLUMN_KEYS: string[] = RECRUITMENT_REQUEST_COLUMNS
  .filter((c) => c.source !== "INPUT")
  .map((c) => c.key);

/** Cột được phép sort phía server (whitelist chống SQL injection). */
export const SORTABLE_COLUMN_KEYS: string[] = RECRUITMENT_REQUEST_COLUMNS
  .filter((c) => c.sortable)
  .map((c) => c.key);

export function isSystemOwnedColumn(key: string): boolean {
  return SYSTEM_OWNED_COLUMN_KEYS.includes(key);
}

/* ============================================================
   PROFILE MẶC ĐỊNH THEO VAI TRÒ (Yêu cầu #2 & #3)
   ------------------------------------------------------------
   `visible`  : tập cột hiển thị mặc định.
   `sticky`   : cột ghim mặc định.
   `readOnly` : vai trò chỉ được xem, mọi cột đều khoá sửa.
   Admin có thể ghi đè toàn bộ qua bảng planning_column_configs.
   ============================================================ */
export type RoleColumnProfile = {
  role: string;
  device: DeviceKind;
  visible: string[];
  sticky: string[];
  readOnly: boolean;
};

const DESKTOP_FULL = ALL_COLUMN_KEYS;

/** Cột Dept Manager được xem: chỉ số nhu cầu / phân bổ / nghỉ / cần tuyển / tiến độ. */
const DEPT_MANAGER_DESKTOP = [
  "requestCode", "position", "location", "division", "department", "section", "groupName",
  "reason", "maleRq", "femaleRq", "totalRequest",
  "maleApplication", "femaleApplication", "maleRecruited", "femaleRecruited",
  "maleQuit", "femaleQuit", "maleBalance", "femaleBalance", "totalBalance",
  "recruitedVsExpected", "status",
  "requestedDate", "expectedDate", "startingDate", "endDate",
];

const HR_DIRECTOR_DESKTOP = [
  "requestCode", "requester", "position", "location", "division", "department", "section", "groupName",
  "reason", "maleRq", "femaleRq", "totalRequest",
  "maleApplication", "femaleApplication", "maleInterviewed", "femaleInterviewed",
  "maleRecruited", "femaleRecruited", "maleQuit", "femaleQuit",
  "maleBalance", "femaleBalance", "totalBalance", "recruitedVsExpected",
  "status", "requestedDate", "expectedDate", "endDate", "completedDate",
  "completedVsRequested", "month", "cost",
];

function mobileSubset(keys: string[], take = 6): string[] {
  return keys
    .filter((k) => COLUMN_BY_KEY[k]?.mobilePriority !== undefined)
    .sort((a, b) => (COLUMN_BY_KEY[a].mobilePriority! - COLUMN_BY_KEY[b].mobilePriority!))
    .slice(0, take);
}

export const DEFAULT_ROLE_COLUMN_PROFILES: RoleColumnProfile[] = [
  { role: "ADMIN", device: "desktop", visible: DESKTOP_FULL, sticky: ["requestCode"], readOnly: false },
  { role: "ADMIN", device: "mobile", visible: mobileSubset(DESKTOP_FULL), sticky: ["requestCode"], readOnly: false },

  { role: "HR_RECRUITER", device: "desktop", visible: DESKTOP_FULL, sticky: ["requestCode", "expectedDate"], readOnly: false },
  { role: "HR_RECRUITER", device: "mobile", visible: mobileSubset(DESKTOP_FULL), sticky: ["requestCode"], readOnly: false },

  { role: "HR_DIRECTOR", device: "desktop", visible: HR_DIRECTOR_DESKTOP, sticky: ["requestCode", "department"], readOnly: true },
  { role: "HR_DIRECTOR", device: "mobile", visible: mobileSubset(HR_DIRECTOR_DESKTOP), sticky: ["requestCode"], readOnly: true },

  { role: "DEPT_MANAGER", device: "desktop", visible: DEPT_MANAGER_DESKTOP, sticky: ["requestCode", "department", "expectedDate"], readOnly: true },
  { role: "DEPT_MANAGER", device: "mobile", visible: mobileSubset(DEPT_MANAGER_DESKTOP), sticky: ["requestCode"], readOnly: true },
];

export function defaultProfileFor(role: string, device: DeviceKind): RoleColumnProfile {
  return (
    DEFAULT_ROLE_COLUMN_PROFILES.find((p) => p.role === role && p.device === device) ??
    DEFAULT_ROLE_COLUMN_PROFILES.find((p) => p.role === "HR_RECRUITER" && p.device === device)!
  );
}

/* ============================================================
   RESOLVE — hợp nhất catalog + cấu hình Admin lưu trong DB
   ============================================================ */
export type StoredColumnConfigItem = {
  columnKey: string;
  visible: boolean;
  sticky: boolean;
  sortOrder: number;
};

export type ResolvedColumn = ColumnDef & {
  visible: boolean;
  sticky: boolean;
  sortOrder: number;
  /** Vai trò hiện tại có được sửa giá trị cột này không. */
  editable: boolean;
};

/**
 * Hợp nhất catalog gốc với cấu hình Admin đã lưu.
 * - Cột lạ trong config (đã bị xoá khỏi catalog) được bỏ qua an toàn.
 * - Cột mới trong catalog mà config chưa biết → lấy theo profile mặc định
 *   của vai trò, xếp cuối bảng. Nhờ vậy thêm cột mới không phá config cũ.
 */
export function resolveColumnsForRole(
  role: string,
  device: DeviceKind,
  stored: StoredColumnConfigItem[] | null | undefined,
  opts?: { canEdit?: boolean },
): ResolvedColumn[] {
  const profile = defaultProfileFor(role, device);
  const storedMap = new Map((stored ?? []).map((s) => [s.columnKey, s]));
  const canEdit = (opts?.canEdit ?? !profile.readOnly) && !profile.readOnly;

  const resolved: ResolvedColumn[] = RECRUITMENT_REQUEST_COLUMNS.map((col, index) => {
    const s = storedMap.get(col.key);
    return {
      ...col,
      visible: s ? s.visible : profile.visible.includes(col.key),
      sticky: (s ? s.sticky : profile.sticky.includes(col.key)) && !!col.stickyCapable,
      sortOrder: s ? s.sortOrder : 1000 + index,
      // Cột SYSTEM/DERIVED không bao giờ sửa tay được — kể cả Admin (Yêu cầu #10).
      editable: canEdit && col.source === "INPUT",
    };
  });

  resolved.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
  return resolved;
}

/** Chỉ các cột đang bật, đã sắp xếp — dùng để render bảng. */
export function visibleColumns(resolved: ResolvedColumn[]): ResolvedColumn[] {
  return resolved.filter((c) => c.visible);
}
