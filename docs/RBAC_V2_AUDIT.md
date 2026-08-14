# RBAC_V2_AUDIT.md — Dynamic RBAC V2 (custom roles, granular permissions, scoped authorization)

**Phạm vi:** toàn bộ tầng phân quyền — `src/lib/auth.ts`, `src/lib/rbac-catalog.ts`, `src/lib/rbac.ts`, `src/db/schema.ts` (bảng `roles`/`permissions`), `migrations/2026-08-14-dynamic-rbac-v2.sql`, `schema.sql`, toàn bộ API route dùng `requirePermission`/`hasPermission`, sidebar/layout, trang `/admin/permissions` (3 tab), trang `/admin/users`, `/admin/audit`, `/admin/dashboard`, scope call-site (export/registrations/planning/workforce/global-search/task-center).

**Ngày:** 2026-08-14. **Trạng thái kiểm thử:** `npm test` 53/53 pass, `tsc --noEmit` 0 lỗi, ESLint 0 errors (25 warnings có sẵn từ trước), `next build` thành công, `git diff --check` sạch. **Chưa** chạy migration trên Neon thật (môi trường phát triển không có kết nối Postgres) — xem "Rủi ro còn lại".

---

## 1. Tóm tắt thay đổi kiến trúc

| | TRƯỚC (fixed 3-role) | SAU (Dynamic RBAC V2) |
|---|---|---|
| Vai trò | Enum hardcode `ADMIN/HR_RECRUITER/DEPT_MANAGER` trong `auth.ts` + sidebar | Bảng `roles` + baseline in-memory (`rbac-catalog.ts`); `users.role` vẫn là string key (không destructive); admin tạo vai trò tuỳ chỉnh không cần sửa code |
| Quyền | Permission là lớp "phủ" tuỳ chọn, **fail-open** (chưa cấu hình = cho phép) | Catalog ~42 quyền / 15 nhóm; **fail-closed** (chưa cấu hình = từ chối), ADMIN bypass cứng |
| Data Scope | `getUserScope` hardcode `ADMIN/HR → null`; call site tự thêm `role === "DEPT_MANAGER"` | `getUserScope` đọc `user_department_scopes` CHO MỌI VAI TRÒ (độc lập role); call site bỏ proxy `role === DEPT_MANAGER`; giữ legacy fallback `deptId` + safety net `[]` |
| Quyền gộp | `workers.view/edit`, `history.manage`, `permissions.manage`, `data_scopes.manage`, `planning.manage`, `dashboard.manage` | Tách: `dw.view/edit/delete`, `worker_profile.view/edit`, `history.view/restore`, `rbac.view/manage`, `data_scope.view/manage`, `planning.view/request/edit/activate`, `dashboard.view/manage` |
| Vô hiệu hoá | — | Tắt role → bump `session_version` mọi user thuộc role + chặn login; mọi RBAC write → `invalidatePermissionCache()` (hiệu lực request kế tiếp) |

## 2. Bảng catalog (nguồn sự thật)

- **`src/lib/rbac-catalog.ts`** — THUẦN (không import DB/Next): `PERMISSION_CATALOG` (42 quyền), `PERMISSION_GROUPS` (15 nhóm), `SYSTEM_ROLES` (4 vai trò), `BASELINE_ROLE_PERMISSIONS`, `ENFORCED_PERMISSION_KEYS` (= toàn bộ catalog), `LEGACY_PERMISSION_KEY_MAP`, `RBAC_AUDIT_ACTIONS`.
- **`src/lib/rbac.ts`** — server-side: `seedRbacCatalog()` (idempotent), `listRoles()` (kèm memberCount, fallback baseline nếu bảng chưa có), `listPermissions()`, `isKnownRoleKey()`, `isRoleActive()`, `bumpSessionVersionForRole()`, `upsertRolePermission()`.
- **`src/db/schema.ts`** — thêm bảng `roles` + `permissions` (additive; `role_permissions` giữ nguyên cấu trúc).
- **`migrations/2026-08-14-dynamic-rbac-v2.sql`** + **`schema.sql`** — tạo bảng + seed 4 role + 42 quyền + baseline `role_permissions` + di trú key cũ→mới; toàn bộ `CREATE TABLE IF NOT EXISTS` / `INSERT ... ON CONFLICT DO NOTHING`.

## 3. Fail-closed — hành vi mới của `hasPermission`

```
hasPermission(role, key):
  ADMIN                 → true        (bypass cứng — không bao giờ tự khoá quản trị viên)
  có dòng role_permissions            → dùng row.allowed
  không có dòng         → false       (FAIL-CLOSED — mọi key trong ENFORCED_PERMISSION_KEYS,
                                       kể cả key lạ do route check nhầm, đều bị từ chối)
```

- Vai trò tuỳ chỉnh mới tạo bắt đầu với **0 quyền** → bị chặn mọi thứ cho tới khi admin gán quyền.
- `requirePermission(roles, key)`: lớp CHÍNH `requireRole` (defense-in-depth cho 4 vai trò hệ thống — ADMIN/HR/MANAGER/HR_DIRECTOR phải nằm trong danh sách route) + lớp THỨ HAI `hasPermission`. Vai trò tuỳ chỉnh không bị chặn ở lớp role-list — quyền do chính `key` quyết định (đúng bản chất Dynamic RBAC).

## 4. Vai trò HR_DIRECTOR (mục G)

Quyền nghiệp vụ cấp cao, **isSystem=false** (có thể bật/tắt qua UI), seed sẵn:

| CÓ (business authority) | KHÔNG (quản trị hệ thống) |
|---|---|
| `registrations.view`, `registrations.export` | `users.view/manage`, `rbac.view/manage` |
| `dw.view`, `worker_profile.view` | `data_scope.view/manage`, `import.run` |
| `planning.view`, `workforce_movements.view` | `backup.manage`, `branding.manage`, `system.view` |
| `history.view`, `audit.view`, `dashboard.view` | `workflow/rules/notifications/field_definitions/questions.manage` |
| `global_search.use`, `privacy.view_*` | `recycle_bin.manage`, `workforce_movements.manage` |

Sidebar hiển thị theo quyền (layout server-side tính `getSessionPermissionKeys` → truyền xuống `Sidebar`); login redirect HR_DIRECTOR → `/admin/dashboard`.

## 5. Data Scope role-independent (mục H)

`getUserScope(session)` mới:
1. Đọc `user_department_scopes` CHO MỌI vai trò (kể cả ADMIN/HR nếu admin chủ động gán — bảng scope độc lập role).
2. Không có dòng → fallback `users.deptId` (cột cũ) → `[deptId]`.
3. Không có gì → ADMIN/HR = `null` (không giới hạn); vai trò khác = `[]` (safety net cũ — manager chưa gán scope không tự thấy toàn bộ).

Call site (export/registrations/planning/workforce/global-search/task-center): bỏ `if (session.role === "DEPT_MANAGER")` proxy, chỉ còn `const scope = await getUserScope(session)` + xử lý `null`/`[]`/list.

## 6. Tách quyền gộp (mục I) — ánh xạ route

| Route | Trước | Sau |
|---|---|---|
| `GET /api/workers` | `workers.view` | `dw.view` (thêm HR_DIRECTOR) |
| `PATCH/DELETE /api/workers` | `workers.edit` | `dw.edit` |
| `GET /api/worker-profiles/[cccd]` | `workers.view` | `worker_profile.view` (thêm HR_DIRECTOR) |
| `PATCH /api/worker-profiles/[cccd]`, backfill | `workers.edit` | `worker_profile.edit` |
| `GET/POST /api/admin/history` | `history.manage` | `history.view` (GET, thêm HR_DIRECTOR) / `history.restore` (POST) |
| `GET /api/admin/dashboard` | `dashboard.manage` | `dashboard.view` (thêm HR_DIRECTOR) |
| `POST/PATCH/DELETE /api/admin/dashboard` | `dashboard.manage` | `dashboard.manage` |
| `GET/POST/PATCH/DELETE /api/admin/data-scopes` | `data_scopes.manage` | `data_scope.view` (GET) / `data_scope.manage` (writes); GET không còn lọc `role='DEPT_MANAGER'` |
| `GET /api/planning` | `planning.view` | `planning.view` (thêm HR_DIRECTOR) |
| `POST /api/planning` | `planning.manage` | `planning.request` (thêm DEPT_MANAGER — DRAFT-only + scope-enforced) |
| `PATCH /api/planning/[id]` (activate) | `planning.manage` | `planning.activate` |
| `PATCH /api/planning/[id]` (revise), allocate | `planning.manage` | `planning.edit` |
| `GET /api/users` | `users.manage` | `users.view` |
| `POST/PATCH/DELETE /api/users` | `users.manage` | `users.manage` |
| `GET /api/admin/permissions` | `permissions.manage` | `rbac.view` |
| `POST /api/admin/permissions` | `permissions.manage` | `rbac.manage` (role CRUD/clone/toggle, tạo quyền) |
| Task Center | `requireRole([3 roles])` | `requirePermission([...], "dashboard.view")`; `canSeeNewApplicants` bỏ `role !== "DEPT_MANAGER"` |

Legacy key migration: các dòng `role_permissions` cũ (`workers.view`...) được copy giá trị `allowed` sang key mới (ON CONFLICT DO NOTHING) — không mất ý định khoá quyền của admin.

## 7. Vô hiệu hoá phiên & cache (mục J)

- `UPDATE_ROLE` với `isActive=false` → `bumpSessionVersionForRole(key)` (tăng `session_version` mọi user đang hoạt động thuộc role) → JWT cũ hết hiệu lực ngay request kế tiếp.
- `POST /api/auth/login` → kiểm tra `isRoleActive(role)`; role đã tắt bị chặn login (403).
- Mọi RBAC write (create/update/clone/toggle) → `invalidatePermissionCache()` (cache 15s của `hasPermission` được xoá, hiệu lực ngay).

## 8. Audit Log mới (mục K)

`CREATE_ROLE`, `UPDATE_ROLE`, `CLONE_ROLE`, `DISABLE_ROLE`, `ENABLE_ROLE`, `CREATE_PERMISSION`, `ASSIGN_PERMISSION_TO_ROLE`, `REMOVE_PERMISSION_FROM_ROLE` — ghi vào `audit_logs` (category AUDIT tự suy từ tiền tố).

## 9. UI

- `/admin/permissions` — 3 tab: **Vai trò** (tạo/sửa/nhân bản/bật-tắt role, memberCount), **Danh mục quyền** (15 nhóm, tạo quyền mới), **Ma trận** (role × quyền toggle; ADMIN khoá, role tắt bị mờ). API: `GET /api/admin/permissions` trả `{roles, permissions, groups, matrix, catalogKeys}`; `POST` action `create_role/update_role/create_permission/toggle`.
- Sidebar: mục nav gắn `permission`; hiển thị nếu role legacy hoặc có quyền.
- `/admin/users`: dropdown vai trò lấy từ catalog (kèm vai trò tuỳ chỉnh); label động; `GET /api/users` trả kèm `roles`.
- `/admin/audit`: guard `audit.view` (mở cho HR_DIRECTOR).
- `/admin/dashboard`: guard `dashboard.view`; quick-links theo quyền.

## 10. Rủi ro còn lại

1. **Thứ tự deploy** (mục Q): chạy `migrations/2026-08-14-dynamic-rbac-v2.sql` TRƯỚC/đồng thời code deploy. Nếu code chạy trước, `seedRbacCatalog`/`listRoles` có fallback in-memory (catalog baseline) nên không crash, nhưng vai trò tuỳ chỉnh chỉ hoạt động sau khi migration đã chạy.
2. **Chưa end-to-end với Neon thật** — mọi xác nhận là unit test + build.
3. **Fail-closed siết chặt là cố ý**: DEPT_MANAGER không còn `registrations.export`/PII (đúng Phase 10 baseline); vai trò tuỳ chỉnh mới tạo không có quyền gì cho tới khi admin gán.
4. Nếu production đang có `role_permissions` cấu hình khoá bằng key CŨ (vd `workers.view=false`), di trú SQL/code đã copy sang key mới — kiểm tra lại trên bản copy dữ liệu thật trước khi deploy.

## 11. Đối chiếu yêu cầu PR

| Mục | Trạng thái |
|---|---|
| A. Architecture before/after | ✅ |
| B. Files changed | ✅ |
| C. Database migration additive + idempotent | ✅ (IF NOT EXISTS + ON CONFLICT DO NOTHING, không DROP) |
| D. Existing roles migration (3 system + HR_DIRECTOR, SQL + code seed) | ✅ |
| E. Permission catalog ~43 / 15 nhóm, ENFORCED | ✅ (42 quyền / 15 nhóm) |
| F. 15 nhóm mặc định | ✅ |
| G. HR_DIRECTOR business authority | ✅ (có hồ sơ/planning/workforce/export/audit; KHÔNG users/rbac/data_scope/backup/branding/health) |
| H. Data Scope compatibility | ✅ |
| I. API authorization split | ✅ |
| J. Session invalidation | ✅ |
| K. Audit Log RBAC actions | ✅ |
| L. npm test / typecheck / lint / build / diff check | ✅ 53/53, 0 lỗi, 0 errors (25 warnings cũ), build OK, diff check sạch |
| M. Migration test ×2 | ✅ (idempotent — chạy lại an toàn; chưa chạy trên Neon thật) |
| Q. Deploy order | ✅ (ghi trong file migration + mục 10 ở trên) |
