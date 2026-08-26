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
  { key: "employment", label: "Employment (Vòng đời làm việc)" },
  { key: "lich_su", label: "Lịch sử & Khôi phục" },
  { key: "du_lieu", label: "Nhập liệu & Metadata" },
  { key: "nguoi_dung", label: "Người dùng" },
  { key: "data_scope", label: "Data Scope" },
  { key: "rbac", label: "Phân quyền & Nhật ký" },
  { key: "cau_hinh_van_hanh", label: "Cấu hình & Vận hành hệ thống" },
  { key: "tong_quan", label: "Dashboard & Tìm kiếm" },
  { key: "quyen_rieng_tu", label: "Quyền riêng tư (PII)" },
  { key: "document_merge", label: "Document Merge" },
  // WORKFLOW TIẾP NHẬN — TÁCH VAI TRÒ — 3 nhóm quyền nghiệp vụ mới, tách biệt
  // khỏi tuyển dụng: Hành chính (mã công nhật), Vân tay (IT Code), Báo cơm.
  { key: "hanh_chinh", label: "Hành chính — Mã số công nhật" },
  { key: "van_tay", label: "Vân tay — IT Code" },
  { key: "bao_com", label: "Báo cơm" },
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
  // WORKFLOW TIẾP NHẬN — tách bạch "xếp việc" (employment.assign) và "Nhập vào DW Data" (mục IV):
  // hành động RIÊNG, rõ ràng, không suy diễn từ status Daily Application.
  { key: "dw.import_from_registration", name: "Nhập vào DW Data (từ Đăng ký)", group: "dw_data" },
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
  { key: "planning.import", name: "Import/Export Recruitment Requests", group: "planning" },
  // CATALOG CONSISTENCY FIX (Batch Permission Editor audit) — 3 quyền này đã
  // được INSERT thẳng vào bảng `permissions`/`role_permissions` bởi migration
  // 2026-08-17-planning-recruitment-upgrade.sql (Phần 5) và ĐÃ được các route
  // Planning thật enforce (planning/column-config/route.ts, planning/reallocate/
  // route.ts, task-center/route.ts) từ trước — nhưng KHÔNG BAO GIỜ được thêm
  // vào PERMISSION_CATALOG này. Vì GET /api/admin/permissions hiển thị quyền
  // từ DB (đã có 3 dòng này) nhưng toggle/batch_update_permissions validate
  // qua getCatalogPermission() (KHÔNG biết 3 key này) + KEY_RE (chỉ cho tối đa
  // 1 dấu chấm, trong khi "planning.columns.manage" có 2 dấu chấm) — mọi lần
  // lưu (đơn lẻ hay batch) có đụng tới 1 trong 3 quyền này đều bị từ chối
  // "Permission key không hợp lệ". Thêm vào đây để catalog LÀ nguồn chân lý
  // DUY NHẤT mà cả GET (hiển thị) và POST (validate) đều đối chiếu — không có
  // catalog frontend/backend tách biệt.
  { key: "planning.reallocate", name: "Chuyển phân bổ DW sang yêu cầu khác", group: "planning" },
  { key: "planning.columns.manage", name: "Cấu hình cột bảng Planning", group: "planning" },
  { key: "planning.comment", name: "Bình luận / ghi chú yêu cầu", group: "planning" },
  // WORKFORCE REQUEST LINKAGE — quyền gắn liền kiến trúc Workforce Request.
  // planning.overallocate MẶC ĐỊNH KHÔNG NẰM TRONG BASELINE (fail-closed): admin cấp
  // tại /admin/permissions khi business cần cho phép vượt tổng nhu cầu (mục 6).
  { key: "planning.overallocate", name: "Override phân bổ vượt tổng nhu cầu (Planning)", group: "planning" },
  { key: "workforce_request.view", name: "Xem Workforce Request (Yêu cầu nhân lực)", group: "planning" },
  { key: "workforce_request.allocate", name: "Phân bổ / tái phân bổ lao động vào Workforce Request", group: "planning" },
  { key: "workforce_request.comment", name: "Bình luận trên Workforce Request", group: "planning" },
  // Nghỉ việc / Thuyên chuyển
  { key: "workforce_movements.view", name: "Xem yêu cầu Nghỉ việc / Thuyên chuyển", group: "nghi_viec_thuyen_chuyen" },
  { key: "workforce_movements.create", name: "Tạo yêu cầu Nghỉ việc / Thuyên chuyển", group: "nghi_viec_thuyen_chuyen" },
  { key: "workforce_movements.manage", name: "HR xử lý yêu cầu Nghỉ việc / Thuyên chuyển", group: "nghi_viec_thuyen_chuyen" },
  // Employment Lifecycle (2026-08-16) — vòng đời làm việc là nguồn sự thật riêng, quyền riêng.
  { key: "employment.view", name: "Xem trạng thái Employment (đang làm/đã nghỉ)", group: "employment" },
  { key: "employment.assign", name: "Xếp việc (tạo/kích hoạt Employment Session)", group: "employment" },
  { key: "employment.resignation.report", name: "Báo nghỉ (Department trong Data Scope)", group: "employment" },
  { key: "employment.resignation.confirm", name: "Xác nhận nghỉ & xếp việc mới", group: "employment" },
  { key: "employment.history.view", name: "Xem Lịch sử làm việc đầy đủ", group: "employment" },
  { key: "employment.start_date_correction.request", name: "Yêu cầu điều chỉnh ngày nhận việc", group: "employment" },
  { key: "employment.start_date_correction.approve", name: "Duyệt điều chỉnh ngày nhận việc", group: "employment" },
  { key: "employment.reconcile", name: "Đối soát dữ liệu Employment (Reconciliation)", group: "employment" },
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
  // Hành chính — Mã số công nhật (mục VI, X)
  { key: "administration.daily_code.view", name: "Xem hàng chờ Mã số công nhật", group: "hanh_chinh" },
  { key: "administration.daily_code.submit", name: "Submit Mã số công nhật hàng loạt", group: "hanh_chinh" },
  // Vân tay — IT Code (mục VIII, X)
  { key: "fingerprint.view", name: "Xem hàng chờ IT Code / Vân tay", group: "van_tay" },
  { key: "fingerprint.submit", name: "Submit IT Code hàng loạt", group: "van_tay" },
  // Báo cơm (mục IX, X)
  { key: "meal.view", name: "Xem danh sách Báo cơm", group: "bao_com" },
  { key: "meal.export", name: "Xuất danh sách Báo cơm", group: "bao_com" },
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
  // WORKFLOW TIẾP NHẬN — TÁCH VAI TRÒ (mục II): 4 vai trò nghiệp vụ mới, mỗi vai trò
  // chỉ có quyền đúng trách nhiệm của mình — KHÔNG vai trò nào mặc định có quyền
  // của HR_RECRUITER hay ADMIN. ADMINISTRATION ("Nhân viên hành chính") KHÔNG PHẢI
  // ADMIN ("Quản trị viên hệ thống") — hai vai trò hoàn toàn tách biệt, không được
  // đại diện lẫn nhau bằng role === "ADMIN" ở bất kỳ đâu trong code.
  {
    key: "HR_SUPPORT",
    name: "Nhân viên hỗ trợ",
    description: "Dùng Document Merge cho hồ sơ đủ điều kiện: preview, merge, tạo PDF, gửi tài liệu. KHÔNG có quyền Recruiter mặc định, không sửa mã công nhật, không quản trị hệ thống.",
    isSystem: false,
    sortOrder: 5,
  },
  {
    key: "ADMINISTRATION",
    name: "Nhân viên hành chính",
    description: "Vai trò nghiệp vụ hành chính (KHÔNG PHẢI Quản trị viên hệ thống): xem danh sách đã nhập DW, nhập/cập nhật Mã số công nhật, submit hàng loạt. Không quản lý user/RBAC/Data Scope/System.",
    isSystem: false,
    sortOrder: 6,
  },
  {
    key: "FINGERPRINT_STAFF",
    name: "Nhân viên phụ trách vân tay",
    description: "Xem lao động đã có Mã số công nhật, nhập/cập nhật IT CODE, submit. Không sửa dữ liệu HR khác nếu không được cấp permission riêng.",
    isSystem: false,
    sortOrder: 7,
  },
  {
    key: "MEAL_STAFF",
    name: "Nhân viên báo cơm",
    description: "Xem danh sách đủ điều kiện báo cơm, xuất danh sách hôm nay. Không chỉnh sửa hồ sơ, không nhập IT CODE, không chỉnh Mã số công nhật.",
    isSystem: false,
    sortOrder: 8,
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
    "dw.import_from_registration",
    "worker_profile.view",
    "departments.manage",
    "planning.view",
    "planning.request",
    "planning.edit",
    "planning.activate",
    "planning.import",
    // Khớp migration 2026-08-17-planning-recruitment-upgrade.sql (Phần 5).
    "planning.reallocate",
    "planning.comment",
    "workforce_request.view",
    "workforce_request.allocate",
    "workforce_request.comment",
    "workforce_movements.view",
    "workforce_movements.create",
    "workforce_movements.manage",
    // Employment Lifecycle — Recruiter: xếp việc + xem lịch sử + YÊU CẦU điều chỉnh ngày
    // (KHÔNG approve — kể cả yêu cầu của chính mình, xem decideCorrection()).
    "employment.view",
    "employment.assign",
    "employment.resignation.confirm",
    "employment.history.view",
    "employment.start_date_correction.request",
    "history.view",
    "history.restore",
    "notifications.manage",
    "dashboard.view",
    "global_search.use",
    "privacy.view_cccd",
    "privacy.view_phone",
    "privacy.view_address",
    "document_merge.view",
    "document_merge.templates.manage",
    "document_merge.execute",
    "document_merge.history.view",
    "document_merge.history.delete",
  ],
  DEPT_MANAGER: [
    "registrations.view",
    "planning.view",
    "planning.request",
    // Khớp migration 2026-08-17-planning-recruitment-upgrade.sql (Phần 5) —
    // DEPT_MANAGER chỉ được BÌNH LUẬN, không import/sửa/tái phân bổ/cấu hình cột.
    "planning.comment",
    "workforce_request.view",
    "workforce_request.comment",
    "workforce_movements.view",
    "workforce_movements.create",
    // Employment Lifecycle — Manager: xem trạng thái + BÁO NGHỈ trong Data Scope của mình.
    "employment.view",
    "employment.resignation.report",
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
    "workforce_request.view",
    "workforce_request.comment",
    "workforce_movements.view",
    "employment.view",
    "employment.history.view",
    "history.view",
    "audit.view",
    "dashboard.view",
    "global_search.use",
    "privacy.view_cccd",
    "privacy.view_phone",
    "privacy.view_address",
    "document_merge.view",
    "document_merge.history.view",
  ],
  // Mục X trong đề bài — baseline HR_SUPPORT: chỉ Document Merge + xem tối thiểu
  // Daily Application để chọn hồ sơ. KHÔNG registrations.edit/.approve, KHÔNG dw.edit
  // toàn cục, KHÔNG employment.assign — không phải Recruiter.
  HR_SUPPORT: [
    "registrations.view",
    "document_merge.view",
    "document_merge.execute",
    "document_merge.history.view",
    "dashboard.view",
    "global_search.use",
  ],
  // Mục X — baseline ADMINISTRATION: chỉ Mã số công nhật + xem tối thiểu để chọn dòng.
  // KHÔNG users.manage/rbac.manage/data_scope.manage/backup/branding/system — KHÔNG PHẢI ADMIN.
  ADMINISTRATION: [
    "administration.daily_code.view",
    "administration.daily_code.submit",
    "dw.view",
    "dashboard.view",
    "global_search.use",
  ],
  // Mục X — baseline FINGERPRINT_STAFF: chỉ IT Code/Vân tay + xem danh tính tối thiểu.
  // KHÔNG registrations.approve, KHÔNG dw.edit toàn hệ thống.
  FINGERPRINT_STAFF: [
    "fingerprint.view",
    "fingerprint.submit",
    "dashboard.view",
    "global_search.use",
  ],
  // Mục X — baseline MEAL_STAFF: chỉ Báo cơm, KHÔNG sửa hồ sơ, KHÔNG PII mặc định
  // (privacy.view_cccd/phone/address KHÔNG nằm trong baseline — Admin cấp riêng nếu cần).
  MEAL_STAFF: [
    "meal.view",
    "meal.export",
    "dashboard.view",
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
  "BATCH_UPDATE_ROLE_PERMISSIONS",
] as const;

/**
 * BATCH PERMISSION EDITOR — "bulk enable" safety net.
 * ---------------------------------------------------------------------
 * "Bật tất cả" / "Bật cả nhóm" must NEVER silently sweep a system-
 * administration capability onto a business role (e.g. a role literally
 * named "C&B - Code DW" ending up with rbac.manage or users.manage just
 * because someone clicked "enable everything"). These keys are excluded
 * from any BLANKET enable action; the client shows why. This does NOT
 * block an admin from granting one of these individually — a deliberate,
 * one-by-one toggle for a specific role is still allowed and still goes
 * through the exact same requirePermission(["ADMIN"], "rbac.manage") gate
 * as every other permission change.
 */
export const BULK_ENABLE_PROTECTED_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "users.manage",
  "rbac.manage",
  "data_scope.manage",
  "backup.manage",
  "branding.manage",
  "system.view",
  "workflow.manage",
]);
