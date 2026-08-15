-- Emergency recovery for the accidentally deactivated primary admin account.
-- Idempotent: only changes the row while it is inactive.
-- Does not change password, role, department, or any other user data.

UPDATE users
SET is_active = true,
    session_version = session_version + 1
WHERE lower(username) = 'anvuong'
  AND role = 'ADMIN'
  AND is_active = false;

-- Expected after running: one row with is_active = true.
SELECT username, role, is_active
FROM users
WHERE lower(username) = 'anvuong';
