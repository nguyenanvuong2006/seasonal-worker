-- ============================================================
-- 2026-08-19 — RECRUITMENT REQUEST SNAPSHOT + KPI RECONCILIATION
-- ------------------------------------------------------------
-- Mục tiêu: tách bạch HAI KPI khác nhau đã bị gộp làm một trong migration
-- 2026-08-18 (Balance = Rq - Current REALTIME):
--
--   Recruitment Balance = max(0, Rq - Current Workforce AT REQUEST START + Quit
--                          During Request)
--   Realtime Gap         = max(0, Rq - Current Workforce NOW)
--
-- Balance PHẢI dùng snapshot cố định tại thời điểm Request được mở — không
-- được recompute lại từ Current REALTIME mỗi lần đọc (đó là định nghĩa của
-- Realtime Gap, một KPI khác). Migration này:
--   1) Thêm 4 cột SNAPSHOT (additive, NULLable/DEFAULT — an toàn ngược).
--   2) Backfill snapshot cho các Request hiện có (snapshot_at IS NULL) bằng
--      Current Workforce theo Department NGAY TẠI THỜI ĐIỂM CHẠY MIGRATION —
--      đây là xấp xỉ tốt nhất có thể cho lịch sử đã qua (không có bản ghi
--      snapshot gốc), được đánh dấu rõ trong audit log.
--   3) Recompute male_balance/female_balance/total_balance theo công thức
--      Balance MỚI (snapshot + quit during request), THAY THẾ công thức
--      "Rq - Current realtime" của migration 2026-08-18.
--
-- Migration idempotent — chạy lại nhiều lần an toàn (ADD COLUMN IF NOT
-- EXISTS, backfill chỉ áp dụng cho snapshot_at IS NULL). KHÔNG DROP / DELETE
-- dữ liệu nghiệp vụ. KHÔNG chạy lại schema.sql.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- PHẦN 1 — CỘT SNAPSHOT MỚI (Yêu cầu #C)
-- ------------------------------------------------------------
ALTER TABLE recruitment_requests
  ADD COLUMN IF NOT EXISTS male_current_at_start   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS female_current_at_start integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_current_at_start  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snapshot_at             timestamptz;

COMMENT ON COLUMN recruitment_requests.male_current_at_start IS
  'Snapshot CỐ ĐỊNH: số worker Nam ACTIVE tại Department vào thời điểm Request được mở. KHÔNG recompute lại — chỉ Admin explicit correction mới được sửa.';
COMMENT ON COLUMN recruitment_requests.female_current_at_start IS
  'Snapshot CỐ ĐỊNH: số worker Nữ ACTIVE tại Department vào thời điểm Request được mở.';
COMMENT ON COLUMN recruitment_requests.total_current_at_start IS
  'Snapshot CỐ ĐỊNH: tổng worker ACTIVE tại Department vào thời điểm Request được mở.';
COMMENT ON COLUMN recruitment_requests.snapshot_at IS
  'Thời điểm snapshot được chụp. NULL = chưa từng snapshot (request tạo trước migration này, hoặc chưa khớp được department_id).';

-- ------------------------------------------------------------
-- PHẦN 2 — BACKFILL SNAPSHOT CHO REQUEST HIỆN CÓ
-- ------------------------------------------------------------
-- Chỉ áp dụng cho request CHƯA từng có snapshot (snapshot_at IS NULL) và đã
-- khớp được department_id. Dùng Current Workforce THEO DEPARTMENT tại thời
-- điểm chạy migration làm xấp xỉ — lịch sử chính xác tại thời điểm mở Request
-- gốc không thể khôi phục lại được vì chưa từng lưu.
WITH dept_active AS (
  SELECT
    es.dept_id,
    COUNT(*) FILTER (
      WHERE lower(coalesce(wp.gender, '')) IN ('nam', 'male', 'm')
        OR lower(coalesce(wp.gender, '')) LIKE '%nam%'
    )::integer AS male_count,
    COUNT(*) FILTER (
      WHERE lower(coalesce(wp.gender, '')) IN ('nữ', 'nu', 'female', 'f')
        OR lower(coalesce(wp.gender, '')) LIKE '%nữ%'
        OR lower(coalesce(wp.gender, '')) LIKE '%nu%'
    )::integer AS female_count,
    COUNT(*)::integer AS total_count
  FROM employment_sessions es
  JOIN worker_profiles wp ON wp.id = es.worker_id
  WHERE es.status = 'APPROVED'
    AND es.end_date IS NULL
    AND wp.deleted_at IS NULL
  GROUP BY es.dept_id
)
UPDATE recruitment_requests rr
   SET male_current_at_start   = COALESCE(da.male_count, 0),
       female_current_at_start = COALESCE(da.female_count, 0),
       total_current_at_start  = COALESCE(da.total_count, 0),
       snapshot_at             = now()
  FROM dept_active da
 WHERE rr.deleted_at IS NULL
   AND rr.snapshot_at IS NULL
   AND rr.department_id IS NOT NULL
   AND da.dept_id = rr.department_id;

-- Request chưa khớp department_id: snapshot = 0/0/0 nhưng đánh dấu đã "chụp"
-- (snapshot_at) để tránh vòng lặp backfill chạy lại vô ích mỗi lần migration
-- này được áp dụng lại; giá trị 0 khớp với hành vi cũ (Balance = Rq).
UPDATE recruitment_requests rr
   SET snapshot_at = now()
 WHERE rr.deleted_at IS NULL
   AND rr.snapshot_at IS NULL
   AND rr.department_id IS NULL;

-- ------------------------------------------------------------
-- PHẦN 3 — RECOMPUTE BALANCE THEO CÔNG THỨC MỚI (snapshot + quit)
-- ------------------------------------------------------------
-- Male Balance   = max(0, Male Rq   - Male Current At Start   + Male Quit During Request)
-- Female Balance = max(0, Female Rq - Female Current At Start + Female Quit During Request)
--
-- Cửa sổ "During Request": [starting_date ?? expected_date ?? requested_date, end_date ?? CURRENT_DATE]
-- Quit = workforce_movements RESIGNATION đã xác nhận (status = 'INACTIVE'),
-- khớp Department qua employment_sessions.dept_id (session bị đóng bởi movement đó).
WITH window_bounds AS (
  SELECT
    rr.id AS request_id,
    COALESCE(rr.starting_date, rr.expected_date, rr.requested_date, rr.created_at::date) AS win_start,
    COALESCE(rr.end_date, CURRENT_DATE) AS win_end
  FROM recruitment_requests rr
  WHERE rr.deleted_at IS NULL
),
quit_counts AS (
  SELECT
    wb.request_id,
    COUNT(*) FILTER (
      WHERE lower(coalesce(wp.gender, '')) IN ('nam', 'male', 'm')
        OR lower(coalesce(wp.gender, '')) LIKE '%nam%'
    )::integer AS male_quit,
    COUNT(*) FILTER (
      WHERE lower(coalesce(wp.gender, '')) IN ('nữ', 'nu', 'female', 'f')
        OR lower(coalesce(wp.gender, '')) LIKE '%nữ%'
        OR lower(coalesce(wp.gender, '')) LIKE '%nu%'
    )::integer AS female_quit
  FROM window_bounds wb
  JOIN recruitment_requests rr ON rr.id = wb.request_id
  JOIN employment_sessions es ON es.dept_id = rr.department_id
  JOIN workforce_movements wm ON wm.employment_session_id = es.id
  JOIN worker_profiles wp ON wp.id = wm.worker_id
  WHERE rr.department_id IS NOT NULL
    AND lower(wm.movement_type) = 'resignation'
    AND wm.status = 'INACTIVE'
    AND wm.effective_date >= wb.win_start
    AND wm.effective_date <= wb.win_end
  GROUP BY wb.request_id
)
UPDATE recruitment_requests rr
   SET male_balance = GREATEST(
         0,
         COALESCE(rr.male_rq, 0) - rr.male_current_at_start
           + COALESCE((SELECT qc.male_quit FROM quit_counts qc WHERE qc.request_id = rr.id), 0)
       ),
       female_balance = GREATEST(
         0,
         COALESCE(rr.female_rq, 0) - rr.female_current_at_start
           + COALESCE((SELECT qc.female_quit FROM quit_counts qc WHERE qc.request_id = rr.id), 0)
       ),
       total_balance = GREATEST(
         0,
         COALESCE(rr.male_rq, 0) - rr.male_current_at_start
           + COALESCE((SELECT qc.male_quit FROM quit_counts qc WHERE qc.request_id = rr.id), 0)
       ) + GREATEST(
         0,
         COALESCE(rr.female_rq, 0) - rr.female_current_at_start
           + COALESCE((SELECT qc.female_quit FROM quit_counts qc WHERE qc.request_id = rr.id), 0)
       ),
       updated_at = NOW()
 WHERE rr.deleted_at IS NULL;

INSERT INTO audit_logs (user_id, username, action, target_type, category, details)
VALUES (
  NULL,
  'SYSTEM',
  'MIGRATION_SNAPSHOT_RECONCILIATION',
  'recruitment_requests',
  'SYSTEM',
  jsonb_build_object(
    'migration', '2026-08-19-recruitment-snapshot-reconciliation.sql',
    'formula_new', 'Balance = max(0, Rq - CurrentAtStart + QuitDuringRequest); RealtimeGap = max(0, Rq - CurrentNow) [computed live, not persisted]',
    'formula_replaced', 'Balance = max(0, Rq - Current realtime) [migration 2026-08-18 — now repurposed as Realtime Gap, computed live]',
    'backfill_note', 'Snapshot cho request đã tồn tại được xấp xỉ bằng Current Workforce theo Department TẠI THỜI ĐIỂM CHẠY MIGRATION (lịch sử gốc không được lưu trước đây)',
    'forbidden_inputs', 'male_recruited, female_recruited đọc riêng — không tham gia công thức Balance; Quit KHÔNG được cộng chồng lên Current realtime (double-count)'
  )
);

COMMIT;

-- VERIFY sau migration:
-- SELECT id, request_code, male_rq, female_rq,
--        male_current_at_start, female_current_at_start, snapshot_at,
--        male_balance, female_balance, total_balance
-- FROM recruitment_requests
-- WHERE deleted_at IS NULL
-- ORDER BY created_at DESC
-- LIMIT 20;
--
-- Đối chiếu Balance vs Realtime Gap cho 1 request (thay :id):
-- SELECT rr.male_rq, rr.male_current_at_start, rr.male_balance,
--        (SELECT COUNT(*) FROM employment_sessions es2 JOIN worker_profiles wp2 ON wp2.id = es2.worker_id
--          WHERE es2.dept_id = rr.department_id AND es2.status = 'APPROVED' AND es2.end_date IS NULL
--            AND wp2.deleted_at IS NULL
--            AND (lower(coalesce(wp2.gender,'')) IN ('nam','male','m') OR lower(coalesce(wp2.gender,'')) LIKE '%nam%')
--        ) AS male_current_now
-- FROM recruitment_requests rr WHERE rr.id = :id;

-- ============================================================
-- ROLLBACK (chạy thủ công nếu cần quay lui — KHÔNG xoá dữ liệu nghiệp vụ)
-- ------------------------------------------------------------
-- BEGIN;
--   -- Cột mới đều NULLable/DEFAULT: có thể GIỮ LẠI an toàn (khuyến nghị).
--   -- Chỉ xoá nếu chắc chắn không cần snapshot nữa:
--   -- ALTER TABLE recruitment_requests
--   --   DROP COLUMN IF EXISTS male_current_at_start,
--   --   DROP COLUMN IF EXISTS female_current_at_start,
--   --   DROP COLUMN IF EXISTS total_current_at_start,
--   --   DROP COLUMN IF EXISTS snapshot_at;
--   -- Quay lại công thức Balance cũ (Rq - Current realtime) nếu cần:
--   -- (dùng lại migrations/2026-08-18-balance-recompute.sql)
-- COMMIT;
-- ============================================================
