-- ============================================================
-- MIGRATION — 2026-08-12 — Production Hardening Audit Fix (PR #4)
-- ============================================================
-- Chạy file này TRỰC TIẾP trên Neon SQL Editor (hoặc `psql -f`) trước khi deploy code của PR #4
-- lên Vercel. KHÔNG cần chạy lại toàn bộ schema.sql — file này chỉ chứa ĐÚNG 3 thay đổi schema
-- mới của PR #4, tách riêng để review/audit độc lập với phần còn lại của schema.
--
-- An toàn:
--   * Idempotent — chạy lại nhiều lần không lỗi, không đổi kết quả (ADD COLUMN IF NOT EXISTS /
--     CREATE INDEX IF NOT EXISTS).
--   * KHÔNG DROP bảng nào.
--   * KHÔNG DROP index nào khác (kể cả index cũ không liên quan).
--   * KHÔNG DELETE / KHÔNG UPDATE bất kỳ dòng dữ liệu nghiệp vụ nào — chỉ ADD COLUMN (có
--     DEFAULT, Postgres tự backfill giá trị mặc định cho toàn bộ dòng hiện có) và CREATE INDEX.
--   * Không phụ thuộc việc chạy lại schema.sql — độc lập hoàn toàn, chỉ cần các bảng
--     `users` / `planning_targets` / `workforce_movements` đã tồn tại (đã có từ trước PR #4).
--
-- Thứ tự chạy: từ trên xuống dưới, nguyên khối. 2 khối CREATE UNIQUE INDEX có kèm câu SELECT
-- kiểm tra NGAY PHÍA TRÊN — bắt buộc chạy câu SELECT đó trước, xác nhận trả về 0 dòng, rồi mới
-- chạy CREATE UNIQUE INDEX ngay bên dưới. Nếu SELECT kiểm tra trả về >0 dòng (dữ liệu trùng lặp
-- có sẵn), DỪNG LẠI — xử lý dữ liệu trùng đó thủ công trước (migration này không tự xoá/sửa gì),
-- rồi mới chạy lại CREATE UNIQUE INDEX.
-- ============================================================

-- ----------------------------------------------------------------
-- 1) P0-6 (Session Revocation) — users.session_version
-- ----------------------------------------------------------------
-- Cột mới, NOT NULL với DEFAULT 1 — Postgres tự gán giá trị 1 cho MỌI dòng users hiện có, không
-- cần UPDATE thủ công. Không ảnh hưởng session đang đăng nhập theo cách phá hỏng: JWT ký từ
-- trước PR #4 không có claim `sessionVersion` → getSession() so `undefined !== 1` → coi như hết
-- hạn → người dùng chỉ cần đăng nhập lại 1 lần sau khi deploy, không mất dữ liệu tài khoản.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;

-- ----------------------------------------------------------------
-- 2) Phase 6 — planning_target_period_uq (1 target / 1 planning period)
-- ----------------------------------------------------------------
-- Kiểm tra TRƯỚC — kỳ vọng 0 dòng. Nếu có dòng nào trả về nghĩa là đã có sẵn dữ liệu trùng lặp
-- (nhiều target cho cùng 1 planning_period_id) — DỪNG, xử lý thủ công trước khi tạo unique index.
SELECT planning_period_id, count(*) AS dup_count
FROM planning_targets
GROUP BY planning_period_id
HAVING count(*) > 1;

-- Chỉ chạy nếu câu SELECT ở trên trả về 0 dòng:
CREATE UNIQUE INDEX IF NOT EXISTS planning_target_period_uq ON planning_targets (planning_period_id);

-- ----------------------------------------------------------------
-- 3) P1-2 — workforce_movement_spawn_resignation_uq (chống spawn resignation trùng)
-- ----------------------------------------------------------------
-- Kiểm tra TRƯỚC — kỳ vọng 0 dòng. Nếu có dòng nào trả về nghĩa là đã có sẵn resignation trùng
-- lặp được sinh từ cùng 1 related_movement_id (từ trước khi có lưới an toàn ở PR #4) — DỪNG,
-- xử lý thủ công trước khi tạo unique index.
SELECT related_movement_id, count(*) AS dup_count
FROM workforce_movements
WHERE movement_type = 'resignation' AND related_movement_id IS NOT NULL
GROUP BY related_movement_id
HAVING count(*) > 1;

-- Chỉ chạy nếu câu SELECT ở trên trả về 0 dòng:
CREATE UNIQUE INDEX IF NOT EXISTS workforce_movement_spawn_resignation_uq ON workforce_movements (related_movement_id)
  WHERE movement_type = 'resignation' AND related_movement_id IS NOT NULL;

-- ============================================================
-- Xong. Xác nhận migration:
--   \d users                                     -- phải thấy cột session_version
--   \di planning_target_period_uq                -- phải thấy index
--   \di workforce_movement_spawn_resignation_uq   -- phải thấy index
-- Sau khi migration chạy thành công, deploy code của PR #4 lên Vercel như bình thường.
-- ============================================================
