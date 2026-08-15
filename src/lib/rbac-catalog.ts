/**
 * DYNAMIC RBAC V2 — PERMISSION CATALOG (thuần, không import DB/Next.js).
 * ---------------------------------------------------------------------
 * Bảng "dữ liệu nguồn" duy nhất cho toàn bộ hệ thống phân quyền động:
 *   - 4 vai trò hệ thống (ADMIN / HR_RECRUITER / DEPT_MANAGER / HR_DIRECTOR)
 *   - ~42 quyền chia 15 nhóm nghiệp vụ
 *   - baseline quyền cho từng vai trò
 *   - danh sách quyền được BACKEND ENFORCE (fail-closed)
 * Module này KHÔNG được import "server-only"/"@/db" — phải chạy được cả ở
 * client (sidebar, trang Phân quyền) lẫn test (node:test) như 1 nguồn chân lý.
 * Các hàm đọc/ghi DB nằm ở src/lib/rbac.ts (seed + helpers server-side).
 */

export type CatalogPermission = {
  key: string;
  name: string;
  group: string; // group key
};

export type CatalogGroup = {
  key: string;
  label: string;
};

export type CatalogRole = {
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  sortOrder: number;
};

/** 15 nhóm quyền mặc định (mục F trong PR). */
export const PERMISSION_GROUPS: readonly CatalogGroup[] = [
  { key: "tuyendung", label: "Tuyển dụng & Tiếp nhận" },
  { key: "cau_hoi_dong", label: "Câu hỏi động" },
  { key: "dw_data", label: "DW Data" },
  { key: "ho_so_tap_nghe", label: "Hồ sơ Tập nghề" },
  { key: "co_cau_to_chuc", label: "Cơ cấu tổ chức" },
  { key: "planning", label: "Planning (Kế hoạch nhu cầu)" },
  { key: "nghi_viec_thuyen_chuyen", label: "Nghỉ việc / Thuyên chuyển" },
  { key: "lich_su", label: "Lịch sử & Khôi phục" },
  { key: "du_lieu", label: "Nhập liệu & Metadata" },
  { key: "nguoi_dung", label: "Người dùng" },
  { key: "data_scope", label: "Data Scope" },
  { key: "rbac", label: "Phân quyền & Nhật ký" },
  { key: "cau_hinh_van_hanh", label: "Cấu hình & Vận hành hệ thống" },
  { key: "tong_quan", label: "Dashboard & Tìm kiếm" },
  { key: "quyen_rieng_tu", label: "Quyền riêng tư (PII)" },
  { key: "document_merge", label: "Document Merge" },
];

/** ~42 quyền — danh mục đầy đủ. Key phải trùng với key mà ROUTE thật sự kiểm tra. */
export const PERMISSION_CATALOG: readonly CatalogPermission[] = [
  // Tuyển dụng & Tiếp nhận
  { key: "registrations.view", name: "Xem Daily Application", group: "tuyendung" },
  { key: "registrations.edit", name: "Sửa Daily Application", group: "tuyendung" },
  { key: "registrations.approve", name: "Duyệt / Từ chối hồ sơ", group: "tuyendung" },
  { key: "registrations.export", name: "Xuất Excel", group: "tuyendung" },
  // Câu hỏi động
  { key: "questions.manage", name: "Quản lý Câu hỏi động (Form Builder)", group: "cau_hoi_dong" },
  // DW Data
  { key: "dw.view", name: "Xem DW Data", group: "dw_data" },
  { key: "dw.edit", name: "Sửa DW Data", group: "dw_data" },
  { key: "dw.delete", name: "Xoá DW Data", group: "dw_data" },
  // Hồ sơ Tập nghề
  { key: "worker_profile.view", name: "Xem Hồ sơ Tập nghề", group: "ho_so_tap_nghe" },
  { key: "worker_profile.edit", name: "Sửa Hồ sơ Tập nghề", group: "ho_so_tap_nghe" },
  // Cơ cấu tổ chức
  { key: "departments.manage", name: "Quản lý Cơ cấu tổ chức", group: "co_cau_to_chuc" },
  // Planning
  { key: "planning.view", name: "Xem Planning", group: "planning" },
  { key: "planning.request", name: "Tạo yêu cầu Planning (DRAFT)", group: "planning" },
  { key: "planning.edit", name: "Sửa Planning (revise)", group: "planning" },
  { key: "planning.activate", name: "Kích hoạt Planning", group: "planning" },
  // Nghỉ việc / Thuyên chuyển
  { key: "workforce_movements.view", name: "Xem yêu cầu Nghỉ việc / Thuyên chuyển", group: "nghi_viec_thuyen_chuyen" },
  { key: "workforce_movements.create", name: "Tạo yêu cầu Nghỉ việc / Thuyên chuyển", group: "nghi_viec_thuyen_chuyen" },
  { key: "workforce_movements.manage", name: "HR xử lý yêu cầu Nghỉ việc / Thuyên chuyển", group: "nghi_viec_thuyen_chuyen" },
  // Lịch sử & Khôi phục
  { key: "history.view", name: "Xem Lịch sử phiên bản", group: "lich_su" },
  { key: "history.restore", name: "Khôi phục phiên bản cũ", group: "lich_su" },
  { key: "recycle_bin.manage", name: "Quản lý Thùng rác", group: "lich_su" },
  // Nhập liệu & Metadata
  { key: "import.run", name: "Nhập dữ liệu (Import)", group: "du_lieu" },
  { key: "field_definitions.manage", name: "Quản lý Trường dữ liệu (Metadata)", group: "du_lieu" },
  // Người dùng
  { key: "users.view", name: "Xem danh sách người dùng", group: "nguoi_dung" },
  { key: "users.manage", name: "Quản lý tài khoản (tạo/sửa/khoá)", group: "nguoi_dung" },
  // Data Scope
  { key: "data_scope.view", name: "Xem cấu hình Data Scope", group: "data_scope" },
  { key: "data_scope.manage", name: "Gán / gỡ Data Scope", group: "data_scope" },
  // Phân quyền & Nhật ký
  { key: "rbac.view", name: "Xem cấu hình Phân quyền", group: "rbac" },
  { key: "rbac.manage", name: "Quản lý Vai trò & Phân quyền", group: "rbac" },
  { key: "audit.view", name: "Xem Nhật ký hệ thống (Audit Log)", group: "rbac" },
  // Cấu hình & Vận hành
  { key: "workflow.manage", name: "Quản lý Workflow", group: "cau_hinh_van_hanh" },
  { key: "rules.manage", name: "Quản lý Rule Engine", group: "cau_hinh_van_hanh" },
  { key: "notifications.manage", name: "Quản lý hàng đợi Thông báo", group: "cau_hinh_van_hanh" },
  { key: "branding.manage", name: "Quản lý Thương hiệu & Chủ đề năm", group: "cau_hinh_van_hanh" },
  { key: "system.view", name: "Xem Health Monitor / Control Center", group: "cau_hinh_van_hanh" },
  { key: "backup.manage", name: "Backup dữ liệu", group: "cau_hinh_van_hanh" },
  // Dashboard & Tìm kiếm
  { key: "dashboard.view", name: "Xem Dashboard / Task Center", group: "tong_quan" },
  { key: "dashboard.manage", name: "Quản lý widget Dashboard", group: "tong_quan" },
  { key: "global_search.use", name: "Sử dụng Tìm kiếm toàn hệ thống", group: "tong_quan" },
  // Quyền riêng tư (PII)
  { key: "privacy.view_cccd", name: "Xem CCCD (Export / Tìm kiếm)", group: "quyen_rieng_tu" },
  { key: "privacy.view_phone", name: "Xem SĐT (Export / Tìm kiếm)", group: "quyen_rieng_tu" },
  { key: "privacy.view_address", name: "Xem Địa chỉ (Export)", group: "quyen_rieng_tu" },
  // Document Merge
  { key: "document_merge.view", name: "Xem Document Merge Center", group: "document_merge" },
  { key: "document_merge.templates.manage", name: "Quản lý Templates", group: "document_merge" },
  { key: "document_merge.execute", name: "Thực hiện Merge", group: "document_merge" },
  { key: "document_merge.history.view", name: "Xem Lịch sử Merge", group: "document_merge" },
  { key: "document_merge.history.delete", name: "Xoá Lịch sử Merge", group: "document_merge" },
];

/** 4 vai trò hệ thống + nền tảng cho vai trò tuỳ chỉnh. */
export const SYSTEM_ROLES: readonly CatalogRole[] = [
  {
    key: "ADMIN",
    name: "Quản trị viên hệ thống",
    description: "Toàn quyền hệ thống (bypass mọi kiểm tra quyền), duy nhất cấu hình RBAC/Data Scope/Backup.",
    isSystem: true,
    sortOrder: 1,
  },
  {
    key: "HR_RECRUITER",
    name: "Nhân sự tuyển dụng",
    description: "Vận hành tuyển dụng: tiếp nhận/duyệt hồ sơ, DW Data, Hồ sơ Tập nghề, Planning, Nghỉ việc/Thuyên chuyển.",
    isSystem: true,
    sortOrder: 2,
  },
  {
    key: "DEPT_MANAGER",
    name: "Quản lý bộ phận",
    description: "Chỉ thao tác trong Data Scope được gán: xem hồ sơ APPROVED, tạo yêu cầu Planning (DRAFT), Nghỉ việc/Thuyên chuyển.",
    isSystem: true,
    sortOrder: 3,
  },
  {
    key: "HR_DIRECTOR",
    name: "Giám đốc Nhân sự",
    description: "Quyền nghiệp vụ cấp cao: xem hồ sơ/Planning/Nghỉ việc/Xuất Excel/Nhật ký — KHÔNG quản lý users/RBAC/Data Scope/Backup/Branding/Health.",
    isSystem: false,
    sortOrder: 4,
  },
];

export const SYSTEM_ROLE_KEYS: readonly string[] = SYSTEM_ROLES.map((r) => r.key);

export function getCatalogRole(key: string): CatalogRole | undefined {
  return SYSTEM_ROLES.find((r) => r.key === key);
}

export function getCatalogPermission(key: string): CatalogPermission | undefined {
  return PERMISSION_CATALOG.find((p) => p.key === key);
}

export function getCatalogGroup(key: string): CatalogGroup | undefined {
  return PERMISSION_GROUPS.find((g) => g.key === key);
}

export function permissionLabel(key: string): string {
  return getCatalogPermission(key)?.name ?? key;
}

export function roleLabel(key: string): string {
  return getCatalogRole(key)?.name ?? key;
}

/**
 * Baseline quyền cho từng vai trò hệ thống (mặc định khi CHƯA có dòng cấu hình nào).
 * ADMIN không cần liệt kê (bypass cứng trong hasPermission) — vẫn seed đủ để ma trận
 * hiển thị đúng.
 */
export const BASELINE_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  ADMIN: PERMISSION_CATALOG.map((p) => p.key),
  HR_RECRUITER: [
    "registrations.view",
    "registrations.edit",
    "registrations.approve",
    "registrations.export",
    "questions.manage",
    "dw.view",
    "dw.edit",
    "worker_profile.view",
    "departments.manage",
    "planning.view",
    "planning.request",
    "planning.edit",
    "planning.activate",
    "workforce_movements.view",
    "workforce_movements.create",
    "workforce_movements.manage",
    "history.view",
    "history.restore",
    "notifications.manage",
    "dashboard.view",
    "global_search.use",
    "privacy.view_cccd",
    "privacy.view_phone",
    "privacy.view_address",
  ],
  DEPT_MANAGER: [
    "registrations.view",
    "planning.view",
    "planning.request",
    "workforce_movements.view",
    "workforce_movements.create",
    "dashboard.view",
    "global_search.use",
  ],
  // Mục G trong PR — "Business authority": xem hồ sơ/planning/workforce/export/audit;
  // KHÔNG users.manage / rbac.manage / data_scope.manage / backup / branding / health.
  HR_DIRECTOR: [
    "registrations.view",
    "registrations.export",
    "dw.view",
    "worker_profile.view",
    "planning.view",
    "workforce_movements.view",
    "history.view",
    "audit.view",
    "dashboard.view",
    "global_search.use",
    "privacy.view_cccd",
    "privacy.view_phone",
    "privacy.view_address",
  ],
};

/** Mọi key trong BASELINE phải tồn tại trong PERMISSION_CATALOG — kiểm tra trong test. */
export const BASELINE_ROLE_KEYS: readonly string[] = Object.keys(BASELINE_ROLE_PERMISSIONS);

/**
 * Quyền được BACKEND THẬT SỰ enforce (fail-closed). Bất kỳ key nào nằm trong đây mà
 * role KHÔNG có dòng cấu hình (role_permissions) → TỪ CHỐI (trừ ADMIN bypass).
 * Hiện tại = toàn bộ catalog.
 */
export const ENFORCED_PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSION_CATALOG.map((p) => p.key));

/**
 * Ánh xạ key cũ → key mới sau khi "tách quyền gộp" (mục I trong PR).
 * Dùng để di trú các dòng role_permissions ĐÃ CẤU HÌNH (allowed = false) sang key mới,
 * tránh mất ý định khoá quyền của admin khi nâng cấp. Idempotent (ON CONFLICT DO NOTHING).
 */
export const LEGACY_PERMISSION_KEY_MAP: Readonly<Record<string, readonly string[]>> = {
  "workers.view": ["dw.view", "worker_profile.view"],
  "workers.edit": ["dw.edit", "worker_profile.edit"],
  "history.manage": ["history.view", "history.restore"],
  "permissions.manage": ["rbac.manage", "rbac.view"],
  "data_scopes.manage": ["data_scope.manage", "data_scope.view"],
  "planning.manage": ["planning.edit", "planning.activate", "planning.request"],
  "dashboard.manage": ["dashboard.view"],
};

export const LEGACY_PERMISSION_KEYS: readonly string[] = Object.keys(LEGACY_PERMISSION_KEY_MAP);

/** Nhóm tên action audit cho RBAC V2 (dùng cho filter trên trang Phân quyền). */
export const RBAC_AUDIT_ACTIONS = [
  "CREATE_ROLE",
  "UPDATE_ROLE",
  "CLONE_ROLE",
  "DISABLE_ROLE",
  "ENABLE_ROLE",
  "CREATE_PERMISSION",
  "ASSIGN_PERMISSION_TO_ROLE",
  "REMOVE_PERMISSION_FROM_ROLE",
  "UPDATE_PERMISSION",
] as const;
