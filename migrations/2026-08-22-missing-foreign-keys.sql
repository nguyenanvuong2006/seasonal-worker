-- ============================================================
-- MISSING FOREIGN KEYS — Production Recovery audit (DB integrity)
-- ------------------------------------------------------------
-- employment_sessions.worker_id/dept_id, workforce_movements.worker_id/
-- from_dept_id/to_dept_id, và planning_periods.department_id đều là cột
-- tham chiếu THẬT (worker/department cụ thể) nhưng KHÔNG có FK ở DB —
-- Postgres chấp nhận insert 1 worker_id/dept_id không tồn tại mà không
-- báo lỗi, âm thầm làm hỏng invariant "worker_profiles là nguồn duy nhất"
-- mà toàn bộ thiết kế "Digital Worker File" dựa vào.
--
-- NGUYÊN TẮC AN TOÀN (giống 2026-08-16-employment-lifecycle.sql):
--   - KHÔNG áp đặt FK nếu đang có dữ liệu orphan (bẩn) — chỉ RAISE NOTICE
--     và bỏ qua, để Admin đối soát dữ liệu trước rồi chạy lại migration.
--   - Idempotent: chạy lại nhiều lần không lỗi (kiểm tra pg_constraint).
--   - ON DELETE RESTRICT (không CASCADE, không SET NULL) — đây là bảng
--     lịch sử/audit (employment_sessions, workforce_movements) hoặc kế
--     hoạch (planning_periods); xoá 1 worker_profiles/departments đang
--     được tham chiếu phải bị CHẶN rõ ràng, không được âm thầm xoá dây
--     chuyền hay để lại NULL vô nghĩa trong lịch sử.
--   - KHÔNG destructive: không có DROP/DELETE/UPDATE dữ liệu nào ở đây.
-- ============================================================

DO $$
DECLARE
  dirty integer;
BEGIN
  -- employment_sessions.worker_id -> worker_profiles.id
  SELECT count(*) INTO dirty
  FROM employment_sessions es
  WHERE NOT EXISTS (SELECT 1 FROM worker_profiles wp WHERE wp.id = es.worker_id);
  IF dirty > 0 THEN
    RAISE NOTICE 'MISSING FK: % employment_sessions.worker_id orphan (không khớp worker_profiles.id) — KHÔNG tạo FK employment_sessions_worker_id_fkey. Đối soát dữ liệu rồi chạy lại migration này.', dirty;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_sessions_worker_id_fkey') THEN
    ALTER TABLE employment_sessions
      ADD CONSTRAINT employment_sessions_worker_id_fkey
      FOREIGN KEY (worker_id) REFERENCES worker_profiles(id) ON DELETE RESTRICT;
  END IF;

  -- employment_sessions.dept_id -> departments.id (nullable — chỉ check hàng có giá trị)
  SELECT count(*) INTO dirty
  FROM employment_sessions es
  WHERE es.dept_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = es.dept_id);
  IF dirty > 0 THEN
    RAISE NOTICE 'MISSING FK: % employment_sessions.dept_id orphan (không khớp departments.id) — KHÔNG tạo FK employment_sessions_dept_id_fkey.', dirty;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_sessions_dept_id_fkey') THEN
    ALTER TABLE employment_sessions
      ADD CONSTRAINT employment_sessions_dept_id_fkey
      FOREIGN KEY (dept_id) REFERENCES departments(id) ON DELETE RESTRICT;
  END IF;

  -- workforce_movements.worker_id -> worker_profiles.id
  SELECT count(*) INTO dirty
  FROM workforce_movements wm
  WHERE NOT EXISTS (SELECT 1 FROM worker_profiles wp WHERE wp.id = wm.worker_id);
  IF dirty > 0 THEN
    RAISE NOTICE 'MISSING FK: % workforce_movements.worker_id orphan — KHÔNG tạo FK workforce_movements_worker_id_fkey.', dirty;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workforce_movements_worker_id_fkey') THEN
    ALTER TABLE workforce_movements
      ADD CONSTRAINT workforce_movements_worker_id_fkey
      FOREIGN KEY (worker_id) REFERENCES worker_profiles(id) ON DELETE RESTRICT;
  END IF;

  -- workforce_movements.from_dept_id -> departments.id (nullable)
  SELECT count(*) INTO dirty
  FROM workforce_movements wm
  WHERE wm.from_dept_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = wm.from_dept_id);
  IF dirty > 0 THEN
    RAISE NOTICE 'MISSING FK: % workforce_movements.from_dept_id orphan — KHÔNG tạo FK workforce_movements_from_dept_id_fkey.', dirty;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workforce_movements_from_dept_id_fkey') THEN
    ALTER TABLE workforce_movements
      ADD CONSTRAINT workforce_movements_from_dept_id_fkey
      FOREIGN KEY (from_dept_id) REFERENCES departments(id) ON DELETE RESTRICT;
  END IF;

  -- workforce_movements.to_dept_id -> departments.id (nullable — NULL khi RESIGNATION)
  SELECT count(*) INTO dirty
  FROM workforce_movements wm
  WHERE wm.to_dept_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = wm.to_dept_id);
  IF dirty > 0 THEN
    RAISE NOTICE 'MISSING FK: % workforce_movements.to_dept_id orphan — KHÔNG tạo FK workforce_movements_to_dept_id_fkey.', dirty;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workforce_movements_to_dept_id_fkey') THEN
    ALTER TABLE workforce_movements
      ADD CONSTRAINT workforce_movements_to_dept_id_fkey
      FOREIGN KEY (to_dept_id) REFERENCES departments(id) ON DELETE RESTRICT;
  END IF;

  -- planning_periods.department_id -> departments.id
  SELECT count(*) INTO dirty
  FROM planning_periods pp
  WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = pp.department_id);
  IF dirty > 0 THEN
    RAISE NOTICE 'MISSING FK: % planning_periods.department_id orphan — KHÔNG tạo FK planning_periods_department_id_fkey.', dirty;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planning_periods_department_id_fkey') THEN
    ALTER TABLE planning_periods
      ADD CONSTRAINT planning_periods_department_id_fkey
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT;
  END IF;
END $$;
