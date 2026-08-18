# Organization Mapping Coverage Audit (PR1 — Organization Canonicalization Foundation)

## Mục đích

`organization_units` được nhắm làm **canonical organization master** cho tích hợp
xuyên hệ thống (approval-system.ver3, và các hệ thống khác sau này). Trước khi công
bố điều đó, phải **chứng minh bằng dữ liệu** — không giả định — rằng cầu nối
`organization_units.legacy_department_id → departments.id` đủ tin cậy và
`organization_units.code` đủ ổn định để làm business key. Tài liệu này giải thích
cách chạy audit, ý nghĩa từng hạng mục, và tiêu chí chấp nhận để tiến lên PR2.

`departments` (legacy, 5 cột free-text location/division/dept_name/section/group_name)
**không bị xoá hay đổi** ở PR này và vẫn tiếp tục là bảng mọi FK hiện tại (`dept_id`)
trỏ vào — PR1 chỉ xây thêm nền tảng, không rewrite hệ thống.

## Cách chạy

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname node scripts/audit-organization-mapping.mjs
```

- **Read-only tuyệt đối**: toàn bộ script chạy trong 1 transaction `BEGIN READ ONLY`
  rồi `ROLLBACK` — không có write path nào, kể cả do lỗi lập trình.
- Không hard-code URL — bắt buộc truyền qua `DATABASE_URL` (biến môi trường hoặc
  `.env.local`), giống quy ước `scripts/audit-employment-data.mjs` đã có trong repo.
- Output: console (người đọc, rút gọn tối đa 20 dòng/hạng mục) + file JSON đầy đủ tại
  `artifacts/organization-mapping-audit.json` (thư mục `artifacts/` đã thêm vào
  `.gitignore` — **không commit** vì có thể chứa dữ liệu department thật).
- Exit code: `0` = sạch, `2` = có vấn đề cần đối soát thủ công (không tự sửa), `1` =
  script tự thất bại (vd thiếu `DATABASE_URL`, mất kết nối DB).

Script đã được test end-to-end trên Postgres 16.13 tại chỗ: nạp `schema.sql` +
`migrations/2026-08-17-organization-units.sql` thật vào 1 DB trống, sau đó tiêm 6
tình huống lỗi thủ công (department tạo sau migration, duplicate legacy mapping,
duplicate code giữa các dòng inactive, status drift, invalid code, orphan unit) — script
phát hiện đúng cả 6, và tự tay xác nhận `org_units_legacy_dept_uq` **từ chối thật** một
insert trùng ở tầng DB (không chỉ ở tầng khai báo Drizzle).

## Ý nghĩa từng hạng mục

| Hạng mục | Định nghĩa | Có phải lỗi không? |
|---|---|---|
| `MAPPED_DEPARTMENTS` | Department có **đúng 1** `organization_units` với `legacy_department_id = departments.id`. Tuyệt đối KHÔNG dùng tên/location/division/section/group để tự khẳng định — chỉ cột `legacy_department_id` (mục VII đề bài). | — |
| `UNMAPPED_DEPARTMENTS` | Department không có bất kỳ `organization_units` nào trỏ tới. Kèm `candidates` (SUGGESTION ONLY theo tên — không bao giờ tự ghi DB) và cờ `ambiguous` nếu ≥2 ứng viên. | Có — đặc biệt nếu `is_active=true` (xem `unmapped_active` trong summary). |
| `ORPHAN_ORGANIZATION_UNITS` | `organization_units` không có `legacy_department_id` và không phải root. | Không tự động — có thể là node hợp lệ do admin tạo mới thuần trên cây (PR2+). Chỉ để con người xem xét. |
| `DUPLICATE_LEGACY_MAPPINGS` | ≥2 `organization_units` cùng `legacy_department_id`. | **Có, nghiêm trọng** — vi phạm bất biến `org_units_legacy_dept_uq`. Phải luôn = 0. |
| `INACTIVE_DEPARTMENT_MAPPINGS` | Department inactive/soft-deleted nhưng unit tương ứng vẫn `is_active=true`. | Có, mức trung bình — trạng thái 2 phía bị lệch theo thời gian (mục XXI). |
| `INACTIVE_ORG_UNIT_MAPPINGS` | Department active nhưng unit tương ứng đã bị deactivate. | Có, mức trung bình — cùng lý do trên, chiều ngược lại. |
| `INVALID_CODES` | `code` không khớp `ORG_UNIT_CODE_PATTERN` (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64 ký tự) hiện hành. | Có, mức trung bình — không phải bất biến DB, chỉ là quy ước ứng dụng bị vi phạm (dữ liệu chèn thủ công/import ngoài luồng). |
| `DUPLICATE_CODES` | ≥2 dòng (kể cả inactive) cùng `code`. | **Có, nghiêm trọng** — phá vỡ lời hứa "code là business key ổn định" (mục XI). |
| `HISTORICAL_MAPPING` | Department đã soft-delete nhưng mapping vẫn resolve được. | **Không phải lỗi** — đây là hành vi ĐÚNG mong muốn (mục XXII: lịch sử vẫn phải resolve được), chỉ báo cáo để biết. |

## Code governance

### Vòng đời `organization_units.code`

1. **Tạo (POST /api/organization-units)** — nếu client không truyền `code`, hệ thống
   tự sinh từ `name` qua `slugifyCode()` (`src/lib/organization-tree.ts`): bỏ dấu, viết
   thường, chỉ giữ `[a-z0-9-]`, ≤64 ký tự. Nếu trùng với **bất kỳ dòng nào đã tồn tại
   (active hay inactive)**, tự thêm hậu tố `-2`, `-3`... cho tới khi tìm được mã trống
   (`src/lib/organization-units.ts::createOrganizationUnit`).
2. **Sửa (PATCH /api/organization-units/[id])** — chỉ nhận `name`/`unitType`/`sortOrder`/
   `action` (DEACTIVATE/REACTIVATE). **Không có tham số `code` nào được chấp nhận hay
   forward xuống tầng service**, kể cả nếu client cố tình gửi kèm (khoá bằng test
   `PR1 — CODE GOVERNANCE` trong `id-detail-route.test.ts`).
3. **Không route/hàm nào khác trong repo ghi vào `organization_units`** — verify bằng
   `grep -rn "organizationUnits" src/ scripts/` chỉ trả về `organization-units.ts` +
   `schema.ts` + các file test.

=> **Code bất biến sau khi tạo (Option A — Application-enforced immutable, đúng như đề
bài mục XIII đề xuất khi chưa có nhu cầu nghiệp vụ đổi code)**. Không cần Option B
(Controlled Rename với reason/changed_by) ở PR1.

### Thay đổi PR1 thực hiện (governance hardening)

Trước PR1, `createOrganizationUnit()` chỉ kiểm tra trùng `code` với các dòng **đang
active** (`AND is_active = true`). Điều này để lộ 1 lỗ hổng: nếu 1 unit bị deactivate,
`code` của nó trở thành "trống" trong mắt hệ thống — 1 unit MỚI được tạo sau đó với tên
trùng có thể **vô tình thừa kế đúng `code` đã nghỉ hưu** đó. Với vai trò cross-system
business key, điều này vi phạm thẳng yêu cầu STABLE (mục XI): 1 external system từng
resolve `code` X ra unit A, sau đó cùng `code` X lại resolve ra unit B hoàn toàn khác.

**Đã sửa**: kiểm tra trùng lặp khi tạo mới giờ xét **toàn bộ dòng, không phân biệt
active/inactive**. Đây là thay đổi hành vi CHẶT HƠN (chỉ ngăn thêm những case trước đây
lẽ ra không nên được phép), không có case hợp lệ nào trước đây bị chặn oan. Unique index
DB `org_units_code_uq` (chỉ áp cho dòng active — lưới chốt cho race giữa 2 unit ACTIVE
cùng lúc) **giữ nguyên không đổi** — mục đích khác, không xung đột.

### Helper tra cứu canonical (điểm truy vấn DUY NHẤT cho PR2+)

`src/lib/organization-units.ts` export 3 hàm mới — **PR2 (approval-system integration)
phải dùng lại các hàm này, không tự viết query mapping riêng** (mục XVI đề bài):

- `findOrganizationUnitByCode(code)` — exact match, không fallback tên, không fuzzy.
  Ưu tiên trả dòng active nếu có; nếu mơ hồ (≥2 active cùng code, hoặc 0 active nhưng
  ≥2 inactive cùng code) → ném `OrgTreeError` (`CODE_AMBIGUOUS_ACTIVE` /
  `CODE_AMBIGUOUS_INACTIVE`), không đoán.
- `findOrganizationUnitByLegacyDepartmentId(departmentId)` — exact match qua bridge;
  ném `OrgTreeError("LEGACY_MAPPING_DUPLICATE")` nếu dữ liệu vi phạm bất biến (không
  nên xảy ra nhờ `org_units_legacy_dept_uq`, nhưng hàm không im lặng đoán nếu vẫn xảy ra).
- `getLegacyDepartmentIdForUnit(organizationUnitId)` — chiều ngược lại; trả `null` nếu
  unit không tồn tại HOẶC tồn tại nhưng chưa gắn legacy bridge — không bao giờ throw
  cho 2 case này (mục XVII đề bài).

## Tiêu chí "Canonical Ready" (mục XXVIII đề bài)

`organization_units` chỉ được coi là canonical ready khi **TẤT CẢ** đúng, dựa trên số
liệu THẬT của lần chạy audit gần nhất trên production (không tự đặt threshold tuỳ ý —
đọc report thật):

1. `DUPLICATE_LEGACY_MAPPINGS = 0`.
2. `DUPLICATE_CODES = 0`.
3. `org_units_code_uq_present = true` VÀ `org_units_legacy_dept_uq_present = true` VÀ
   `legacy_department_id_fk_present = true` VÀ `circular_parent_trigger_present = true`
   (verify trực tiếp DB catalog, không suy từ khai báo Drizzle).
4. `unmapped_active = 0`, hoặc nếu > 0 thì mỗi dòng đã được đối soát thủ công (không tự
   backfill bằng suggestion theo tên).
5. `INVALID_CODES` đã được rà soát (không nhất thiết = 0 ngay, nhưng phải có kế hoạch
   xử lý rõ, không được là "unknown").
6. `status_mismatches` đã được rà soát — không nhất thiết = 0 (drift có thể là chủ ý,
   ví dụ admin deactivate 1 unit trước khi deactivate department tương ứng), nhưng phải
   được xem xét, không bỏ qua.

`DUPLICATE_LEGACY_MAPPINGS` và `DUPLICATE_CODES` là **hard blocker** (script tự thoát
`exit 2` kèm `hard_blockers_present: true` trong JSON) — mọi hạng mục khác là cần đối
soát nhưng không tự động chặn.

## Đã biết: rủi ro drift đang tiếp diễn (không phải bug 1 lần)

Migration `2026-08-17-organization-units.sql` backfill **cơ học 1-1** cho toàn bộ
department đang tồn tại TẠI THỜI ĐIỂM chạy migration — bao gồm cả department đã
soft-delete (để lịch sử vẫn resolve được). Nhưng `POST /api/departments` (tạo
department mới) **không tự động tạo `organization_units` tương ứng** — xác nhận bằng
đọc trực tiếp `src/app/api/departments/route.ts`, không có bất kỳ lệnh ghi nào vào
`organization_units` trong luồng tạo department. Nghĩa là: **coverage 100% tại thời
điểm migration chạy KHÔNG tự động đảm bảo coverage vẫn 100% mãi mãi** — mỗi department
mới tạo sau đó sẽ mặc định UNMAPPED cho tới khi được bridge.

**Đã verify trên Postgres 16 thật (không chỉ đọc code)**: migration này KHÔNG chỉ
idempotent theo nghĩa "chạy lại không lỗi" — nó còn **tự phục hồi (self-healing)** khi
chạy lại: `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM organization_units ou WHERE
ou.legacy_department_id = d.id)` ở Phần 3 sẽ tự bridge cho bất kỳ department nào ĐANG
thiếu mapping tại thời điểm chạy — kể cả department tạo sau lần chạy trước — mà KHÔNG
đụng tới bất kỳ mapping nào đã có (verify bằng cách seed 1 department mới sau lần chạy
đầu, chạy lại migration, xác nhận: (a) department mới được bridge đúng, (b) không phát
sinh `DUPLICATE_LEGACY_MAPPINGS` nào, (c) `root` vẫn đúng 1 dòng).

=> Rủi ro drift ở trên **có sẵn cách khắc phục an toàn ngay bây giờ, không cần chờ PR
mới**: chạy lại `migrations/2026-08-17-organization-units.sql` (an toàn, additive,
không đụng dữ liệu đã đúng) bất cứ khi nào audit phát hiện `unmapped_active > 0`. Việc
này KHÔNG thay thế nhu cầu 1 giải pháp auto-sync thời gian thực ở PR sau (department mới
vẫn UNMAPPED cho tới khi ai đó chủ động chạy lại migration/audit) — nhưng nghĩa là gap
này có quy trình vận hành rõ ràng ngay từ PR1, không phải "known bug chưa có lối ra".
