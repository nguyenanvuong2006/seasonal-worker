-- ============================================================================
-- DYNAMIC RBAC V2 — roles / permissions catalog + baseline role_permissions
-- ----------------------------------------------------------------------------
-- Additive + idempotent: CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING.
-- KHÔNG DROP, KHÔNG đổi users, KHÔNG mất user/password/data-scope/audit.
-- Chạy được nhiều lần (deploy an toàn lặp lại).
--
-- Deploy order (mục Q trong PR):
--   1) Chạy file này TRƯỚC/đồng thời code deploy (code có fallback baseline
--      in-memory nếu bảng catalog chưa tồn tại — xem src/lib/rbac-catalog.ts).
--   2) Deploy code.
--   3) Verify đăng nhập ADMIN/HR/MANAGER + HR_DIRECTOR.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Catalog ROLE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         varchar(32)  NOT NULL UNIQUE,
  name        varchar(120) NOT NULL,
  description text,
  is_system   boolean      NOT NULL DEFAULT false,
  is_active   boolean      NOT NULL DEFAULT true,
  sort_order  integer      NOT NULL DEFAULT 0,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS roles_key_uq ON roles (key);

-- 3 role hệ thống + HR_DIRECTOR (mục D trong PR). onConflictDoNothing -> không đè chỉnh sửa admin.
INSERT INTO roles (key, name, description, is_system, is_active, sort_order) VALUES
  ('ADMIN',         'Quản trị viên hệ thống', 'Toàn quyền hệ thống (bypass mọi kiểm tra quyền).', true, true, 1),
  ('HR_RECRUITER',  'Nhân sự tuyển dụng',     'Vận hành tuyển dụng: tiếp nhận/duyệt hồ sơ, DW Data, Hồ sơ Tập nghề, Planning, Nghỉ việc/Thuyên chuyển.', true, true, 2),
  ('DEPT_MANAGER',  'Quản lý bộ phận',        'Chỉ thao tác trong Data Scope được gán: xem hồ sơ APPROVED, tạo yêu cầu Planning (DRAFT), Nghỉ việc/Thuyên chuyển.', true, true, 3),
  ('HR_DIRECTOR',   'Giám đốc Nhân sự',       'Quyền nghiệp vụ cấp cao: xem hồ sơ/Planning/Nghỉ việc/Xuất Excel/Nhật ký — KHÔNG quản lý users/RBAC/Data Scope/Backup/Branding/Health.', false, true, 4)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) Catalog PERMISSION (~42 quyền / 15 nhóm — mục E, F trong PR)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         varchar(64)  NOT NULL UNIQUE,
  name        varchar(160) NOT NULL,
  group_name  varchar(40)  NOT NULL,
  description text,
  is_system   boolean      NOT NULL DEFAULT true,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS permissions_key_uq ON permissions (key);

INSERT INTO permissions (key, name, group_name, is_system) VALUES
  -- Tuyển dụng & Tiếp nhận
  ('registrations.view',     'Xem Daily Application',              'tuyendung', true),
  ('registrations.edit',     'Sửa Daily Application',              'tuyendung', true),
  ('registrations.approve',  'Duyệt / Từ chối hồ sơ',              'tuyendung', true),
  ('registrations.export',   'Xuất Excel',                         'tuyendung', true),
  -- Câu hỏi động
  ('questions.manage',       'Quản lý Câu hỏi động (Form Builder)','cau_hoi_dong', true),
  -- DW Data
  ('dw.view',                'Xem DW Data',                        'dw_data', true),
  ('dw.edit',                'Sửa DW Data',                        'dw_data', true),
  ('dw.delete',              'Xoá DW Data',                        'dw_data', true),
  -- Hồ sơ Tập nghề
  ('worker_profile.view',    'Xem Hồ sơ Tập nghề',                 'ho_so_tap_nghe', true),
  ('worker_profile.edit',    'Sửa Hồ sơ Tập nghề',                 'ho_so_tap_nghe', true),
  -- Cơ cấu tổ chức
  ('departments.manage',     'Quản lý Cơ cấu tổ chức',             'co_cau_to_chuc', true),
  -- Planning
  ('planning.view',          'Xem Planning',                       'planning', true),
  ('planning.request',       'Tạo yêu cầu Planning (DRAFT)',       'planning', true),
  ('planning.edit',          'Sửa Planning (revise)',              'planning', true),
  ('planning.activate',      'Kích hoạt Planning',                 'planning', true),
  -- Nghỉ việc / Thuyên chuyển
  ('workforce_movements.view',    'Xem yêu cầu Nghỉ việc / Thuyên chuyển', 'nghi_viec_thuyen_chuyen', true),
  ('workforce_movements.create',  'Tạo yêu cầu Nghỉ việc / Thuyên chuyển', 'nghi_viec_thuyen_chuyen', true),
  ('workforce_movements.manage',  'HR xử lý yêu cầu Nghỉ việc / Thuyên chuyển', 'nghi_viec_thuyen_chuyen', true),
  -- Lịch sử & Khôi phục
  ('history.view',           'Xem Lịch sử phiên bản',              'lich_su', true),
  ('history.restore',        'Khôi phục phiên bản cũ',             'lich_su', true),
  ('recycle_bin.manage',     'Quản lý Thùng rác',                  'lich_su', true),
  -- Nhập liệu & Metadata
  ('import.run',             'Nhập dữ liệu (Import)',              'du_lieu', true),
  ('field_definitions.manage','Quản lý Trường dữ liệu (Metadata)', 'du_lieu', true),
  -- Người dùng
  ('users.view',             'Xem danh sách người dùng',           'nguoi_dung', true),
  ('users.manage',           'Quản lý tài khoản (tạo/sửa/khoá)',   'nguoi_dung', true),
  -- Data Scope
  ('data_scope.view',        'Xem cấu hình Data Scope',            'data_scope', true),
  ('data_scope.manage',      'Gán / gỡ Data Scope',                'data_scope', true),
  -- Phân quyền & Nhật ký
  ('rbac.view',              'Xem cấu hình Phân quyền',            'rbac', true),
  ('rbac.manage',            'Quản lý Vai trò & Phân quyền',       'rbac', true),
  ('audit.view',             'Xem Nhật ký hệ thống (Audit Log)',   'rbac', true),
  -- Cấu hình & Vận hành
  ('workflow.manage',        'Quản lý Workflow',                   'cau_hinh_van_hanh', true),
  ('rules.manage',           'Quản lý Rule Engine',                'cau_hinh_van_hanh', true),
  ('notifications.manage',   'Quản lý hàng đợi Thông báo',         'cau_hinh_van_hanh', true),
  ('branding.manage',        'Quản lý Thương hiệu & Chủ đề năm',   'cau_hinh_van_hanh', true),
  ('system.view',            'Xem Health Monitor / Control Center','cau_hinh_van_hanh', true),
  ('backup.manage',          'Backup dữ liệu',                     'cau_hinh_van_hanh', true),
  -- Dashboard & Tìm kiếm
  ('dashboard.view',         'Xem Dashboard / Task Center',        'tong_quan', true),
  ('dashboard.manage',       'Quản lý widget Dashboard',           'tong_quan', true),
  ('global_search.use',      'Sử dụng Tìm kiếm toàn hệ thống',     'tong_quan', true),
  -- Quyền riêng tư (PII)
  ('privacy.view_cccd',      'Xem CCCD (Export / Tìm kiếm)',       'quyen_rieng_tu', true),
  ('privacy.view_phone',     'Xem SĐT (Export / Tìm kiếm)',        'quyen_rieng_tu', true),
  ('privacy.view_address',   'Xem Địa chỉ (Export)',               'quyen_rieng_tu', true)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3) Baseline role_permissions (mục D trong PR) — KHÔNG đè cấu hình admin đã có.
--    ADMIN: không cần liệt kê (bypass cứng trong code) nhưng vẫn seed đủ để ma trận hiển thị.
-- ---------------------------------------------------------------------------
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  -- ADMIN — toàn bộ catalog
  ('ADMIN', 'registrations.view', true), ('ADMIN', 'registrations.edit', true),
  ('ADMIN', 'registrations.approve', true), ('ADMIN', 'registrations.export', true),
  ('ADMIN', 'questions.manage', true),
  ('ADMIN', 'dw.view', true), ('ADMIN', 'dw.edit', true), ('ADMIN', 'dw.delete', true),
  ('ADMIN', 'worker_profile.view', true), ('ADMIN', 'worker_profile.edit', true),
  ('ADMIN', 'departments.manage', true),
  ('ADMIN', 'planning.view', true), ('ADMIN', 'planning.request', true),
  ('ADMIN', 'planning.edit', true), ('ADMIN', 'planning.activate', true),
  ('ADMIN', 'workforce_movements.view', true), ('ADMIN', 'workforce_movements.create', true),
  ('ADMIN', 'workforce_movements.manage', true),
  ('ADMIN', 'history.view', true), ('ADMIN', 'history.restore', true),
  ('ADMIN', 'recycle_bin.manage', true),
  ('ADMIN', 'import.run', true), ('ADMIN', 'field_definitions.manage', true),
  ('ADMIN', 'users.view', true), ('ADMIN', 'users.manage', true),
  ('ADMIN', 'data_scope.view', true), ('ADMIN', 'data_scope.manage', true),
  ('ADMIN', 'rbac.view', true), ('ADMIN', 'rbac.manage', true), ('ADMIN', 'audit.view', true),
  ('ADMIN', 'workflow.manage', true), ('ADMIN', 'rules.manage', true),
  ('ADMIN', 'notifications.manage', true), ('ADMIN', 'branding.manage', true),
  ('ADMIN', 'system.view', true), ('ADMIN', 'backup.manage', true),
  ('ADMIN', 'dashboard.view', true), ('ADMIN', 'dashboard.manage', true),
  ('ADMIN', 'global_search.use', true),
  ('ADMIN', 'privacy.view_cccd', true), ('ADMIN', 'privacy.view_phone', true),
  ('ADMIN', 'privacy.view_address', true),
  -- HR_RECRUITER
  ('HR_RECRUITER', 'registrations.view', true), ('HR_RECRUITER', 'registrations.edit', true),
  ('HR_RECRUITER', 'registrations.approve', true), ('HR_RECRUITER', 'registrations.export', true),
  ('HR_RECRUITER', 'questions.manage', true),
  ('HR_RECRUITER', 'dw.view', true), ('HR_RECRUITER', 'dw.edit', true),
  ('HR_RECRUITER', 'worker_profile.view', true),
  ('HR_RECRUITER', 'departments.manage', true),
  ('HR_RECRUITER', 'planning.view', true), ('HR_RECRUITER', 'planning.request', true),
  ('HR_RECRUITER', 'planning.edit', true), ('HR_RECRUITER', 'planning.activate', true),
  ('HR_RECRUITER', 'workforce_movements.view', true), ('HR_RECRUITER', 'workforce_movements.create', true),
  ('HR_RECRUITER', 'workforce_movements.manage', true),
  ('HR_RECRUITER', 'history.view', true), ('HR_RECRUITER', 'history.restore', true),
  ('HR_RECRUITER', 'notifications.manage', true),
  ('HR_RECRUITER', 'dashboard.view', true),
  ('HR_RECRUITER', 'global_search.use', true),
  ('HR_RECRUITER', 'privacy.view_cccd', true), ('HR_RECRUITER', 'privacy.view_phone', true),
  ('HR_RECRUITER', 'privacy.view_address', true),
  -- DEPT_MANAGER (mục I trong PR: planning.request DRAFT-only, scope-enforced)
  ('DEPT_MANAGER', 'registrations.view', true),
  ('DEPT_MANAGER', 'planning.view', true), ('DEPT_MANAGER', 'planning.request', true),
  ('DEPT_MANAGER', 'workforce_movements.view', true), ('DEPT_MANAGER', 'workforce_movements.create', true),
  ('DEPT_MANAGER', 'dashboard.view', true),
  ('DEPT_MANAGER', 'global_search.use', true),
  -- HR_DIRECTOR (mục G trong PR — business authority, không quản trị)
  ('HR_DIRECTOR', 'registrations.view', true), ('HR_DIRECTOR', 'registrations.export', true),
  ('HR_DIRECTOR', 'dw.view', true), ('HR_DIRECTOR', 'worker_profile.view', true),
  ('HR_DIRECTOR', 'planning.view', true),
  ('HR_DIRECTOR', 'workforce_movements.view', true),
  ('HR_DIRECTOR', 'history.view', true), ('HR_DIRECTOR', 'audit.view', true),
  ('HR_DIRECTOR', 'dashboard.view', true), ('HR_DIRECTOR', 'global_search.use', true),
  ('HR_DIRECTOR', 'privacy.view_cccd', true), ('HR_DIRECTOR', 'privacy.view_phone', true),
  ('HR_DIRECTOR', 'privacy.view_address', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4) Di trú key cũ -> key mới (mục I trong PR: tách quyền gộp).
--    Copy giá trị `allowed` của dòng cũ sang key mới để KHÔNG mất ý định khoá
--    quyền của admin đã cấu hình trước nâng cấp. Idempotent.
-- ---------------------------------------------------------------------------
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'dw.view', allowed FROM role_permissions WHERE permission_key = 'workers.view'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'worker_profile.view', allowed FROM role_permissions WHERE permission_key = 'workers.view'
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'dw.edit', allowed FROM role_permissions WHERE permission_key = 'workers.edit'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'worker_profile.edit', allowed FROM role_permissions WHERE permission_key = 'workers.edit'
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'history.view', allowed FROM role_permissions WHERE permission_key = 'history.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'history.restore', allowed FROM role_permissions WHERE permission_key = 'history.manage'
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'rbac.view', allowed FROM role_permissions WHERE permission_key = 'permissions.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'rbac.manage', allowed FROM role_permissions WHERE permission_key = 'permissions.manage'
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'data_scope.view', allowed FROM role_permissions WHERE permission_key = 'data_scopes.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'data_scope.manage', allowed FROM role_permissions WHERE permission_key = 'data_scopes.manage'
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'planning.edit', allowed FROM role_permissions WHERE permission_key = 'planning.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'planning.activate', allowed FROM role_permissions WHERE permission_key = 'planning.manage'
ON CONFLICT (role, permission_key) DO NOTHING;
INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'planning.request', allowed FROM role_permissions WHERE permission_key = 'planning.manage'
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO role_permissions (role, permission_key, allowed)
SELECT role, 'dashboard.view', allowed FROM role_permissions WHERE permission_key = 'dashboard.manage'
ON CONFLICT (role, permission_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5) Verification (chạy lại an toàn)
-- ---------------------------------------------------------------------------
SELECT key, name, is_system, is_active FROM roles ORDER BY sort_order;
SELECT count(*) AS permission_count FROM permissions;
