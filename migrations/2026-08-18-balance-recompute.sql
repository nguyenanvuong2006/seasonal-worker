-- ============================================================
-- 2026-08-18 — BALANCE RECOMPUTE (PHASE 6 double-count fix)
-- ------------------------------------------------------------
-- Công thức Balance CŨ: Rq − Recruited/Allocated + Quit
-- Công thức Balance MỚI: max(0, Rq − Recruited/Allocated)
-- (xem AUDIT_REPORT.md mục E1 + src/lib/planning-recruitment-core.ts)
--
-- Mục đích migration này:
--   1. Recompute `male_balance`, `female_balance`, `total_balance`
--      trên recruitment_requests bằng công thức mới.
--   2. KHÔNG xoá dữ liệu. KHÔNG đổi schema. Idempotent (chạy lại OK).
--
-- Áp dụng SAU khi deploy code mới. Trước khi chạy, verify:
--   SELECT id, request_code, male_rq, male_recruited, male_quit, male_balance
--     FROM recruitment_requests
--    WHERE male_rq - male_recruited + male_quit <> male_balance
--    LIMIT 5;
-- Sau khi chạy, verify tương tự phải trả 0 dòng.
-- ============================================================

BEGIN;

-- 1) Recompute trên mỗi bản ghi — bảo toàn maleQuit/femaleQuit (vẫn là historical KPI).
-- GREATEST(0, ...) clamp về 0, giống code.
UPDATE recruitment_requests
   SET male_balance = GREATEST(0, COALESCE(male_rq, 0) - COALESCE(male_recruited, 0)),
       female_balance = GREATEST(0, COALESCE(female_rq, 0) - COALESCE(female_recruited, 0)),
       total_balance = GREATEST(0, COALESCE(male_rq, 0) - COALESCE(male_recruited, 0))
                    + GREATEST(0, COALESCE(female_rq, 0) - COALESCE(female_recruited, 0)),
       updated_at = NOW()
 WHERE deleted_at IS NULL;

-- 2) Log migration (audit, idempotent)
INSERT INTO audit_logs (user_id, username, action, target_type, category, details)
VALUES (
  NULL,
  'SYSTEM',
  'MIGRATION_RECOMPUTE_BALANCE',
  'recruitment_requests',
  'SYSTEM',
  jsonb_build_object(
    'migration', '2026-08-18-balance-recompute.sql',
    'formula_old', 'Rq - Recruited + Quit',
    'formula_new', 'max(0, Rq - Recruited)',
    'phase', 'PHASE 6 double-count fix'
  )
);

COMMIT;

-- ROLLBACK (chỉ chạy thủ công nếu cần quay lui — KHÔNG tự động):
--   Tính lại balance CŨ từ Rq / Recruited / Quit hiện tại:
--   UPDATE recruitment_requests
--      SET male_balance = GREATEST(0, COALESCE(male_rq,0) - COALESCE(male_recruited,0) + COALESCE(male_quit,0)),
--          female_balance = GREATEST(0, COALESCE(female_rq,0) - COALESCE(female_recruited,0) + COALESCE(female_quit,0)),
--          total_balance = GREATEST(0, COALESCE(male_rq,0) - COALESCE(male_recruited,0) + COALESCE(male_quit,0))
--                       + GREATEST(0, COALESCE(female_rq,0) - COALESCE(female_recruited,0) + COALESCE(female_quit,0));
