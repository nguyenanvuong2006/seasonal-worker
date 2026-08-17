-- ============================================================
-- 2026-08-17 — ORGANIZATION UNITS: CÂY TỔ CHỨC ĐỘ SÂU TUỲ Ý (Phase Org-Tree Step 1)
-- ------------------------------------------------------------
-- Mục tiêu: thay giả định "Location > Division > Department > Section >
-- Group" cố định 5 tầng (các cột free-text trên `departments`) bằng 1
-- cây tổ chức thật, không giới hạn độ sâu, dùng Postgres `ltree`
-- (materialized path, GiST index — đã verify trên Postgres 16.13 thật:
-- descendant/ancestor query dùng đúng Bitmap Index Scan trên GiST, không
-- sequential scan).
--
-- KHÔNG đổi/xoá `departments` — mỗi dòng (kể cả đã soft-delete, để lịch
-- sử vẫn resolve được) được migrate CƠ HỌC 1-1 thành đúng 1
-- organization_units con của 1 root COMPANY duy nhất, qua cột
-- `legacy_department_id`. KHÔNG suy diễn Location/Division/Section
-- thành các tầng trung gian tự động — dữ liệu text hiện tại không đủ
-- tin cậy để làm việc đó an toàn (đề bài mục 19: "không tự bịa"). Việc
-- sắp xếp lại (Move) các node phẳng này vào đúng cây thật là thao tác
-- CỦA ADMIN qua UI /admin/organization ở PR sau, không phải migration.
--
-- An toàn:
--   * Idempotent — CREATE ... IF NOT EXISTS / INSERT ... ON CONFLICT / WHERE NOT EXISTS.
--   * KHÔNG DROP bảng/cột nào, KHÔNG DELETE dữ liệu nghiệp vụ.
--   * `departments` tiếp tục được đọc/ghi y nguyên bởi toàn bộ code hiện có —
--     bảng mới này KHÔNG được bất kỳ route nào đọc ở migration này (PR1
--     thuần nền tảng, chưa nối vào Data Scope/KPI/Recruitment Request).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- PHẦN 1 — EXTENSION + BẢNG + INDEX
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE IF NOT EXISTS organization_units (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  varchar(64) NOT NULL,
  name                  varchar(160) NOT NULL,
  unit_type             varchar(24) NOT NULL DEFAULT 'OTHER',
  parent_id             uuid REFERENCES organization_units(id) ON DELETE RESTRICT,
  path                  ltree NOT NULL,
  depth                 integer NOT NULL DEFAULT 0,
  sort_order            integer NOT NULL DEFAULT 0,
  is_active             boolean NOT NULL DEFAULT true,
  legacy_department_id  uuid REFERENCES departments(id),
  valid_from            date,
  valid_to              date,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            varchar(64),
  updated_by            varchar(64)
);

COMMENT ON TABLE organization_units IS
  'Cây tổ chức độ sâu tuỳ ý (Org Tree). path = materialized path kiểu ltree — mọi INSERT/UPDATE đụng cột path PHẢI cast rõ ràng ::ltree (Postgres không implicit-cast text->ltree khi bind tham số). Xem src/lib/organization-units.ts.';
COMMENT ON COLUMN organization_units.unit_type IS
  'Chỉ là metadata mô tả (icon/nhãn hiển thị) — KHÔNG được dùng để ép số tầng hay giới hạn độ sâu cây.';
COMMENT ON COLUMN organization_units.legacy_department_id IS
  'Cầu nối tương thích ngược sang departments.id — cho phép getUserScope() và mọi route deptId-based hiện có tiếp tục hoạt động không đổi trong giai đoạn chuyển đổi.';

CREATE UNIQUE INDEX IF NOT EXISTS org_units_code_uq ON organization_units (code) WHERE is_active;
CREATE INDEX IF NOT EXISTS org_units_path_gist_idx ON organization_units USING GIST (path);
CREATE INDEX IF NOT EXISTS org_units_parent_idx ON organization_units (parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS org_units_legacy_dept_uq ON organization_units (legacy_department_id) WHERE legacy_department_id IS NOT NULL;

-- ------------------------------------------------------------
-- PHẦN 2 — ROOT NODE (COMPANY) — đúng 1 dòng, idempotent
-- ------------------------------------------------------------
INSERT INTO organization_units (code, name, unit_type, parent_id, path, depth, sort_order, created_by, updated_by)
SELECT 'root', 'Dalat Hasfarm', 'COMPANY', NULL, 'root'::ltree, 0, 0, 'SYSTEM_MIGRATION', 'SYSTEM_MIGRATION'
WHERE NOT EXISTS (SELECT 1 FROM organization_units WHERE code = 'root' AND parent_id IS NULL);

-- ------------------------------------------------------------
-- PHẦN 3 — BACKFILL CƠ HỌC 1-1 TỪ departments (KHÔNG suy diễn tầng trung gian)
-- ------------------------------------------------------------
-- Bao gồm CẢ department đã soft-delete (deleted_at IS NOT NULL) — lịch sử các
-- bản ghi cũ (daily_applications/employment_sessions/workforce_movements đã
-- trỏ tới dept đó) vẫn phải resolve được qua legacy_department_id, không chỉ
-- department đang hoạt động.
INSERT INTO organization_units (
  code, name, unit_type, parent_id, path, depth, sort_order, is_active,
  legacy_department_id, created_by, updated_by
)
SELECT
  'legacy-' || d.id::text,
  d.dept_name || CASE WHEN coalesce(nullif(trim(d.group_name), ''), '') <> '' THEN ' — ' || d.group_name ELSE '' END,
  'DEPARTMENT',
  r.id,
  r.path || ('legacy_' || replace(d.id::text, '-', '_'))::ltree,
  1,
  coalesce(d.stt, 0),
  (d.is_active AND d.deleted_at IS NULL),
  d.id,
  'SYSTEM_MIGRATION',
  'SYSTEM_MIGRATION'
FROM departments d
CROSS JOIN (SELECT id, path FROM organization_units WHERE code = 'root' AND parent_id IS NULL LIMIT 1) r
WHERE NOT EXISTS (
  SELECT 1 FROM organization_units ou WHERE ou.legacy_department_id = d.id
);

-- ------------------------------------------------------------
-- PHẦN 4 — AUDIT LOG
-- ------------------------------------------------------------
INSERT INTO audit_logs (user_id, username, action, target_type, category, details)
SELECT
  NULL,
  'SYSTEM',
  'MIGRATION_ORGANIZATION_UNITS',
  'organization_units',
  'SYSTEM',
  jsonb_build_object(
    'migration', '2026-08-17-organization-units.sql',
    'new_tables', jsonb_build_array('organization_units'),
    'root_units', 1,
    'legacy_departments_mapped', (SELECT count(*) FROM organization_units WHERE legacy_department_id IS NOT NULL)
  )
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs WHERE action = 'MIGRATION_ORGANIZATION_UNITS'
);

COMMIT;

-- VERIFY sau migration:
-- SELECT count(*) FROM organization_units;  -- 1 (root) + count(departments) kể cả soft-deleted
-- SELECT ou.name, d.dept_name, d.group_name FROM organization_units ou JOIN departments d ON d.id = ou.legacy_department_id LIMIT 20;
-- EXPLAIN SELECT * FROM organization_units WHERE path <@ (SELECT path FROM organization_units WHERE code='root' AND parent_id IS NULL);  -- phải dùng org_units_path_gist_idx

-- ============================================================
-- ROLLBACK (chạy thủ công nếu cần quay lui — bảng này CHƯA được route nào
-- đọc ở PR1, nên rollback không ảnh hưởng dữ liệu nghiệp vụ nào khác)
-- ------------------------------------------------------------
-- BEGIN;
--   DELETE FROM audit_logs WHERE action = 'MIGRATION_ORGANIZATION_UNITS';
--   DROP TABLE IF EXISTS organization_units;
--   -- KHÔNG DROP EXTENSION ltree nếu PR sau (worker_assignments) đã dùng tới.
-- COMMIT;
-- ============================================================
