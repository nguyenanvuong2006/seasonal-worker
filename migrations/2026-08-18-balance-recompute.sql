-- ============================================================
-- 2026-08-18 — BALANCE RECOMPUTE (PHASE 6 v2 — source-of-truth fix)
-- ------------------------------------------------------------
-- Công thức Balance MỚI (canonical, xem AUDIT_REPORT.md mục E1):
--   Male Balance   = max(0, Male Rq  − Male Current Workforce)
--   Female Balance = max(0, Female Rq − Female Current Workforce)
--   Total Balance  = Male Balance + Female Balance
--
-- Source-of-truth = số worker CÓ:
--   request_allocations.status = 'ACTIVE'  (lớp Request)
--   employment_sessions.status = 'APPROVED' (lớp Employment)
--   employment_sessions.end_date IS NULL
--   worker_profiles.deleted_at IS NULL
-- phân tách giới tính theo worker_profiles.gender.
--
-- Công thức CŨ (v1) dùng Rq − Recruited hoặc Rq − Recruited + Quit:
--   * Rq − Recruited           SAI — Recruited là historical KPI,
--                                KHÔNG phải Current Workforce.
--   * Rq − Recruited + Quit    SAI — double-count (Quit đã được loại
--                                khỏi ACTIVE session khi nghỉ).
-- Cả 2 công thức cũ đều bị loại bỏ hoàn toàn khỏi code & migration.
--
-- Mục đích migration này:
--   1. Recompute `male_balance`, `female_balance`, `total_balance`
--      trên recruitment_requests từ SOURCE OF TRUTH (CTE).
--   2. KHÔNG xoá dữ liệu. KHÔNG đổi schema. Idempotent (chạy lại OK).
--   3. KHÔNG dùng `male_recruited/female_recruited` làm đầu vào.
--   4. KHÔNG cộng `male_quit/female_quit` vào Balance.
--   5. Cột {male,female,total}_balance được ghi nhận là CACHE dẫn xuất
--      từ request_allocations ∩ employment_sessions. Runtime code
--      (workforce-request.ts:batchComputeRequestKpis) TÍNH LẠI từ
--      source-of-truth khi cần ra quyết định — migration này chỉ đồng
--      bộ cache để list/filter UI nhìn ra cùng số với runtime.
-- ============================================================

BEGIN;

-- 1) Recompute từng bản ghi từ CTE nguồn thật.
--    CTE đếm ACTIVE request_allocations có ACTIVE employment session,
--    phân nhóm theo request_id + gender (đọc từ worker_profiles).
WITH active_workforce AS (
  SELECT
    ra.request_id AS request_id,
    CASE
      WHEN lower(coalesce(wp.gender, '')) IN ('nữ', 'nu', 'female', 'f') THEN 'female'
      WHEN lower(coalesce(wp.gender, '')) IN ('nam', 'male', 'm')        THEN 'male'
      ELSE 'unknown'
    END AS gender_bucket,
    COUNT(*) AS active_count
  FROM request_allocations ra
  INNER JOIN employment_sessions es
    ON es.id = ra.employment_session_id
  INNER JOIN worker_profiles wp
    ON wp.id = ra.worker_id
  WHERE ra.status = 'ACTIVE'
    AND es.status = 'APPROVED'
    AND es.end_date IS NULL
    AND wp.deleted_at IS NULL
  GROUP BY ra.request_id, gender_bucket
),
pivoted AS (
  SELECT
    request_id,
    COALESCE(SUM(CASE WHEN gender_bucket = 'male'   THEN active_count END), 0) AS male_current,
    COALESCE(SUM(CASE WHEN gender_bucket = 'female' THEN active_count END), 0) AS female_current,
    COALESCE(SUM(active_count), 0) AS total_current
  FROM active_workforce
  GROUP BY request_id
)
UPDATE recruitment_requests rr
   SET male_balance   = GREATEST(0, COALESCE(rr.male_rq, 0)   - COALESCE(p.male_current, 0)),
       female_balance = GREATEST(0, COALESCE(rr.female_rq, 0) - COALESCE(p.female_current, 0)),
       total_balance  = GREATEST(0, COALESCE(rr.male_rq, 0)   - COALESCE(p.male_current, 0))
                     + GREATEST(0, COALESCE(rr.female_rq, 0) - COALESCE(p.female_current, 0)),
       updated_at = NOW()
  FROM pivoted p
 WHERE p.request_id = rr.id
   AND rr.deleted_at IS NULL;

-- 2) Với các yêu cầu KHÔNG có row trong pivoted (chưa có allocation nào)
--    thì CTE trên không chạm tới — set về Rq (Current = 0 cho từng giới tính).
UPDATE recruitment_requests
   SET male_balance   = GREATEST(0, COALESCE(male_rq, 0)),
       female_balance = GREATEST(0, COALESCE(female_rq, 0)),
       total_balance  = GREATEST(0, COALESCE(male_rq, 0))
                     + GREATEST(0, COALESCE(female_rq, 0)),
       updated_at = NOW()
 WHERE deleted_at IS NULL
   AND id NOT IN (SELECT request_id FROM pivoted);

-- 3) Log migration (audit, idempotent) — ghi rõ formula mới + nguồn.
INSERT INTO audit_logs (user_id, username, action, target_type, category, details)
VALUES (
  NULL,
  'SYSTEM',
  'MIGRATION_RECOMPUTE_BALANCE',
  'recruitment_requests',
  'SYSTEM',
  jsonb_build_object(
    'migration', '2026-08-18-balance-recompute.sql',
    'formula_old', 'Rq - Recruited (V1 — SAI, dùng historical KPI làm Current)',
    'formula_new', 'max(0, Rq - Current Workforce) từ request_allocations + employment_sessions ACTIVE + worker_profiles.gender',
    'source_of_truth', 'request_allocations ∩ employment_sessions (APPROVED + end_date IS NULL) ∩ worker_profiles',
    'forbidden_inputs', 'male_recruited, female_recruited, male_quit, female_quit',
    'phase', 'PHASE 6 v2 — source-of-truth fix',
    'cache_role', 'male_balance/female_balance/total_balance là CACHE dẫn xuất — runtime tính lại từ source-of-truth (lib/workforce-request.ts:batchComputeRequestKpis)'
  )
);

COMMIT;

-- ============================================================
-- VERIFY (chạy thủ công sau migration):
--   -- Tổng số row cập nhật:
--   SELECT COUNT(*) FROM recruitment_requests WHERE deleted_at IS NULL;
--
--   -- Một vài mẫu trước/sau để spot-check (chạy TRƯỚC migration để so sánh):
--   SELECT id, request_code, male_rq, female_rq, male_balance, female_balance, total_balance
--     FROM recruitment_requests
--    WHERE deleted_at IS NULL
--    ORDER BY created_at DESC
--    LIMIT 10;
--
--   -- Số yêu cầu còn "Current < Rq" (còn thiếu người):
--   SELECT COUNT(*) FROM recruitment_requests
--    WHERE deleted_at IS NULL AND total_balance > 0;
-- ============================================================

-- ROLLBACK (chỉ chạy thủ công nếu cần quay lui — KHÔNG tự động):
--   Xoá cache, để code runtime tự fill lại qua recomputeRequestKpiCache():
--   UPDATE recruitment_requests
--      SET male_balance = 0,
--          female_balance = 0,
--          total_balance = 0
--    WHERE deleted_at IS NULL;
--   Sau đó gọi /api/cron/run (jobKey = 'recompute-request-kpi-cache') để dựng lại.
