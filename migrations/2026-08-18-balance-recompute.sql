-- ============================================================
-- 2026-08-18 — BALANCE RECOMPUTE (PHASE 6 v2 — source-of-truth fix)
-- ------------------------------------------------------------
-- Canonical formula:
--   Male Balance   = max(0, Male Rq   - Male Current Workforce)
--   Female Balance = max(0, Female Rq - Female Current Workforce)
--   Total Balance  = Male Balance + Female Balance
--
-- Current Workforce source-of-truth:
--   request_allocations.status = 'ACTIVE'
--   employment_sessions.status = 'APPROVED'
--   employment_sessions.end_date IS NULL
--   worker_profiles.deleted_at IS NULL
--
-- Recruited và Quit là historical KPI, KHÔNG tham gia công thức Balance.
-- Migration không đổi schema, không xoá dữ liệu, có thể chạy lại an toàn.
-- ============================================================

BEGIN;

-- Recompute TẤT CẢ request trong MỘT statement.
-- Quan trọng: CTE chỉ tồn tại trong statement ngay sau WITH, vì vậy cả request
-- có allocation và request chưa có allocation đều được xử lý ở UPDATE này.
WITH active_workforce AS (
  SELECT
    ra.request_id,
    CASE
      WHEN lower(coalesce(wp.gender, '')) IN ('nữ', 'nu', 'female', 'f') THEN 'female'
      WHEN lower(coalesce(wp.gender, '')) IN ('nam', 'male', 'm')        THEN 'male'
      ELSE 'unknown'
    END AS gender_bucket,
    COUNT(*)::integer AS active_count
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
    COALESCE(SUM(CASE WHEN gender_bucket = 'male'   THEN active_count ELSE 0 END), 0)::integer AS male_current,
    COALESCE(SUM(CASE WHEN gender_bucket = 'female' THEN active_count ELSE 0 END), 0)::integer AS female_current
  FROM active_workforce
  GROUP BY request_id
)
UPDATE recruitment_requests rr
   SET male_balance = GREATEST(
         0,
         COALESCE(rr.male_rq, 0) - COALESCE((SELECT p.male_current FROM pivoted p WHERE p.request_id = rr.id), 0)
       ),
       female_balance = GREATEST(
         0,
         COALESCE(rr.female_rq, 0) - COALESCE((SELECT p.female_current FROM pivoted p WHERE p.request_id = rr.id), 0)
       ),
       total_balance = GREATEST(
         0,
         COALESCE(rr.male_rq, 0) - COALESCE((SELECT p.male_current FROM pivoted p WHERE p.request_id = rr.id), 0)
       ) + GREATEST(
         0,
         COALESCE(rr.female_rq, 0) - COALESCE((SELECT p.female_current FROM pivoted p WHERE p.request_id = rr.id), 0)
       ),
       updated_at = NOW()
 WHERE rr.deleted_at IS NULL;

INSERT INTO audit_logs (user_id, username, action, target_type, category, details)
VALUES (
  NULL,
  'SYSTEM',
  'MIGRATION_RECOMPUTE_BALANCE',
  'recruitment_requests',
  'SYSTEM',
  jsonb_build_object(
    'migration', '2026-08-18-balance-recompute.sql',
    'formula_new', 'max(0, Rq - Current Workforce)',
    'source_of_truth', 'request_allocations ACTIVE ∩ employment_sessions APPROVED/open ∩ worker_profiles',
    'forbidden_inputs', 'male_recruited, female_recruited, male_quit, female_quit',
    'phase', 'PHASE 6 v2 — source-of-truth fix'
  )
);

COMMIT;

-- VERIFY sau migration:
-- SELECT COUNT(*) AS request_count
-- FROM recruitment_requests
-- WHERE deleted_at IS NULL;
--
-- SELECT id, request_code, male_rq, female_rq,
--        male_balance, female_balance, total_balance
-- FROM recruitment_requests
-- WHERE deleted_at IS NULL
-- ORDER BY created_at DESC
-- LIMIT 10;
--
-- SELECT COUNT(*) AS requests_still_needing_people
-- FROM recruitment_requests
-- WHERE deleted_at IS NULL AND total_balance > 0;
