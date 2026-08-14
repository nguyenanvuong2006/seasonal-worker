-- One-time recovery for the accidentally deactivated production admin account.
-- Safe scope: only re-activates username 'anvuong' when it is already an ADMIN.
-- Does NOT create a user, change a password, or promote another role to ADMIN.

UPDATE users
SET is_active = true,
    session_version = session_version + 1
WHERE username = 'anvuong'
  AND role = 'ADMIN'
  AND is_active = false;

-- Verification: expected one row with role ADMIN and is_active = true.
SELECT username, role, is_active
FROM users
WHERE username = 'anvuong';
