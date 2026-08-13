# Hướng dẫn từng file trong dự án Dalat Hasfarm HR

> Tài liệu này viết cho người **không rành code** — mỗi file được giải thích bằng
> ngôn ngữ thường, kèm ví dụ cụ thể "muốn sửa X thì vào đây, sửa dòng nào".
>
> **Quy ước ký hiệu:**
> - 🟢 = Bạn (không phải dev) có thể tự sửa nội dung/chữ ở đây, khá an toàn
> - 🟡 = Sửa được nhưng cần cẩn thận (dễ gây lỗi nếu gõ sai cú pháp)
> - 🔴 = Đây là phần "máy móc" chạy ngầm — **đừng tự sửa**, nhờ dev; nếu chỉ đọc
>   để hiểu hệ thống hoạt động ra sao thì không sao

---

## PHẦN A — Những nơi bạn sẽ sửa nhiều nhất (đọc phần này trước)

| Muốn sửa... | Vào file này |
|---|---|
| Chữ/tiêu đề/mô tả trên **trang chủ đăng ký** (hero, quy trình) | 🟢 `src/app/page.tsx` |
| Các **câu hỏi trong form đăng ký** (Giới tính, Dân tộc...) sau khi hệ thống **đã chạy rồi** | 🟢 Vào trang web `/admin/form-builder` (không sửa file, xem giải thích ở mục A-pages bên dưới) |
| Câu hỏi mặc định khi **cài đặt hệ thống lần đầu** (CSDL còn trống) | 🟡 `src/lib/seed.ts` |
| Màu sắc thương hiệu (xanh lá, vàng gold) | 🟡 `src/app/globals.css` |
| Logo, tên công ty cạnh logo | 🟢 `src/components/brand-logo.tsx` |
| Danh sách 71 bộ phận | 🟢 Vào trang web `/admin/departments` (không sửa file) |
| Số điện thoại hỗ trợ, giờ làm việc hiển thị trên trang chủ | 🟢 `src/app/page.tsx` (tìm dòng có số điện thoại) |
| Tài khoản đăng nhập mặc định (admin/hr/trưởng bộ phận) | 🔴 `src/lib/seed.ts` — **xem cảnh báo bảo mật ở mục A-seed** |

---

## PHẦN B — Cấu hình & tài liệu gốc (thư mục ngoài cùng)

### `package.json` / `package-lock.json` 🔴
Danh sách "nguyên liệu" (thư viện) mà dự án cần để chạy được, giống như danh sách
nguyên liệu của một công thức nấu ăn. `package-lock.json` ghi lại đúng phiên bản
từng nguyên liệu để đảm bảo lúc nào cài lại cũng ra kết quả giống hệt.
**Không tự sửa tay** — nếu cần thêm/bớt thư viện, nhờ dev chạy lệnh `npm install`.

### `tsconfig.json` 🔴
Cấu hình cho ngôn ngữ TypeScript (một "phiên bản chặt chẽ hơn" của JavaScript mà
dự án này dùng). Việc của dev, không liên quan tới nội dung bạn thấy trên web.

### `next.config.ts` 🔴
Cấu hình cho Next.js — framework (bộ khung) dựng nên toàn bộ website này. Ví dụ:
cho phép tải ảnh từ domain nào, bật/tắt tính năng nào của Next.js.

### `postcss.config.mjs` / `eslint.config.mjs` 🔴
File kỹ thuật thuần: một cái xử lý CSS (giao diện), một cái kiểm tra lỗi code lúc
viết. Không có nội dung nào bạn cần sửa ở đây.

### `drizzle.config.json` 🔴
Cấu hình cho công cụ quản lý cơ sở dữ liệu (Drizzle ORM) — nơi chứa toàn bộ dữ
liệu đăng ký, lao động, bộ phận... Chỉ dev cần đụng tới khi thay đổi cấu trúc bảng.

### `schema.sql` 🔴
Bản in ra "hình dạng" cơ sở dữ liệu (có những bảng gì, mỗi bảng có cột gì) dưới
dạng câu lệnh SQL thô. Dùng để dev đối chiếu/khởi tạo DB, không phải nơi sửa nội
dung hiển thị.

### `vercel.json` 🔴
Cấu hình cho việc **deploy** (đưa web lên internet) qua nền tảng Vercel — ví dụ
lịch chạy cron job tự động. Sửa sai có thể làm hệ thống ngừng chạy các tác vụ nền
(như xử lý import, gửi thông báo).

### `next-env.d.ts` 🔴
File Next.js tự sinh ra, không ai sửa tay file này bao giờ.

### `HUONG_DAN_HE_THONG.md` 🟢
Tài liệu vận hành hệ thống viết sẵn bằng tiếng Việt (dạng văn bản thuần, không phải
code) — bạn đọc/sửa thoải mái, không ảnh hưởng gì tới việc web chạy.

### `IMPORT_AUDIT_REPORT.md` 🟢
Một báo cáo (dạng văn bản) ghi lại kết quả rà soát dữ liệu cũ khi chuyển từ Google
Form sang hệ thống mới (vd. "79/488 đơn cũ thiếu CCCD"). Chỉ để đọc tham khảo,
sửa/xoá thoải mái vì không phải code.

---

## PHẦN C — Dữ liệu mẫu & tài liệu hướng dẫn import

### `data/daily_application.csv`, `data/department.csv`, `data/dw_data.csv` 🟡
Ba file Excel/CSV mẫu — dùng để dev test tính năng import hoặc để bạn xem "định
dạng file mình cần chuẩn bị khi import trông như thế nào" (tên cột phải đặt ra
sao). Có thể mở bằng Excel để tham khảo cấu trúc cột, nhưng **không phải dữ liệu
thật đang chạy trên web** — sửa file này không ảnh hưởng gì tới dữ liệu thật.

### `scripts/import-sheets.mjs` 🔴
Một đoạn script (không chạy trên web, chạy tay qua dòng lệnh) để nhập dữ liệu từ
Google Sheets vào cơ sở dữ liệu. Việc của dev khi cần đồng bộ dữ liệu hàng loạt.

### `public/help/import/IMPORT_FAQ.md`, `IMPORT_GUIDE.md`, `IMPORT_TROUBLESHOOTING.md` 🟢
Ba bài hướng dẫn (dạng văn bản thuần tiếng Việt) hiển thị cho HR khi họ vào trang
`/admin/import-data` và bấm nút trợ giúp — giải thích cách chuẩn bị file, câu hỏi
thường gặp, cách xử lý lỗi khi import. Đây là **văn bản hướng dẫn người dùng**,
bạn sửa câu chữ thoải mái, không phải code — sửa xong hiển thị lại ngay trên web.

---

## PHẦN D — Trang công khai (ứng viên / lao động xem, không cần đăng nhập)

### `src/app/page.tsx` 🟢 (file bạn đã sửa nhiều lần trong các buổi trước)
**Đây là trang chủ** — nơi ứng viên vào để đăng ký làm việc. Toàn bộ những gì bạn
thấy: banner xanh phía trên (hero), tiêu đề, logo, dòng chữ khuyến mãi lương/xe đưa
đón trên cùng, khối "Quy trình sau khi bạn đăng ký", 2 nút "Tra cứu trạng thái" /
"Hỗ trợ nhân sự", dòng bản quyền cuối trang — **tất cả nằm trong file này**.
- Muốn đổi số điện thoại hỗ trợ (`0263 3842777`) → tìm đúng chuỗi số đó trong file,
  sửa trực tiếp.
- Muốn đổi câu "Quy trình sau khi bạn đăng ký" → xem lại hướng dẫn mình đã đưa ở
  câu trả lời trước (dòng ~80-99).
- Muốn đổi câu quảng cáo "🌱 Thu nhập ~15 tháng lương/năm..." → sửa ngay dòng có
  chữ đó ở đầu file.
- Đừng xoá các dòng bắt đầu bằng `import` ở đầu file hay các cặp ngoặc `{ }` `< >`
  — chỉ sửa phần **chữ tiếng Việt nằm giữa các thẻ**, giữ nguyên phần code.

### `src/app/lookup/page.tsx` 🟢
Trang **"Tra cứu kết quả"** (bấm vào nút 🔎 trên trang chủ) — nơi lao động tự nhập
CCCD/SĐT để xem mình được xếp vào bộ phận nào, ai phụ trách. Muốn đổi câu chữ
hướng dẫn/label trên trang này thì sửa ở đây.

### `src/app/login/page.tsx` 🟢
Trang **đăng nhập nội bộ** (HR, trưởng bộ phận, admin bấm "Đăng nhập nội bộ" để
vào). Chỉ có form usename/password — muốn đổi chữ trên nút, tiêu đề trang thì sửa
ở đây. Logic kiểm tra mật khẩu đúng/sai nằm ở file khác (`src/lib/auth.ts`).

### `src/app/layout.tsx` 🟡
Khung bao ngoài áp dụng cho **mọi trang** trong toàn bộ web (kể cả trang nội bộ) —
khai báo font chữ, tiêu đề tab trình duyệt (title), favicon. Sửa được nhưng nhớ
đây ảnh hưởng toàn bộ site, không chỉ 1 trang.

### `src/app/globals.css` 🟡
File màu sắc + hiệu ứng dùng chung toàn site. Ví dụ đoạn:
```css
--color-hasfarm-700: #115830;   /* xanh lá thương hiệu */
--color-gold-500: #d9a327;      /* vàng gold thương hiệu */
```
Muốn đổi tông màu chủ đạo (xanh lá / vàng) của toàn bộ web → đổi các mã màu (mã
hex, dạng `#xxxxxx`) trong khối `@theme { ... }` ở đầu file này. Đổi 1 chỗ, áp
dụng lại cho tất cả các nút/card đang dùng tông màu đó.

### `src/components/applicant-portal.tsx` 🟡 (file mình đã sửa lỗi "Giới tính" ở buổi trước)
Đây là "bộ não" của **form đăng ký nhiều bước**: nhập CCCD → hệ thống tự nhận diện
lao động cũ/mới → xác nhận → thành công. Chữ hiển thị trên từng bước (label ô
nhập, chữ trên nút, thông báo lỗi...) đều nằm trong file này, ví dụ dòng
`"Tiếp Tục → Kiểm tra hồ sơ"` chính là chữ trên nút vàng ở bước 1. Sửa được chữ,
nhưng đây cũng là nơi xử lý **logic** (gọi API, kiểm tra hợp lệ) nên khi sửa, chỉ
nên sửa phần chữ nằm trong dấu ngoặc kép `"..."`, không đụng vào phần code xung
quanh.

### `src/components/cccd-qr-scanner.tsx` 🔴
Component xử lý việc **bật camera điện thoại quét mã QR trên thẻ CCCD** để tự
điền số CCCD thay vì gõ tay. Đây là logic kỹ thuật (điều khiển camera, đọc mã),
nên để dev chỉnh nếu cần đổi cách hoạt động.

### `src/components/brand-logo.tsx` 🟢 (file mình vừa thêm size "xl" ở buổi trước)
Component logo dùng ở nhiều nơi (trang chủ, trang đăng nhập, sidebar nội bộ...).
Muốn đổi ảnh logo → đổi đường dẫn ảnh trong biến `REAL_LOGO_URL`. Muốn đổi chữ
"DALAT HASFARM" / "Seasonal HR • Đà Lạt" → sửa trực tiếp 2 dòng chữ đó trong file.

---

## PHẦN E — Khu vực nội bộ (HR / Trưởng bộ phận / Admin đăng nhập mới thấy)

Mỗi mục dưới đây là **1 trang màn hình** khi đăng nhập vào hệ thống. Phần lớn nội
dung trên các trang này là **dữ liệu thật lấy từ cơ sở dữ liệu** (không phải chữ
cố định trong file), nên muốn đổi dữ liệu thì thao tác ngay trên giao diện web —
chỉ khi muốn đổi **nhãn/tiêu đề cố định** (vd. tên cột, tên nút) mới cần sửa file.

### `src/app/(internal)/layout.tsx` 🟡
Khung bao ngoài cho toàn bộ khu nội bộ — chứa thanh điều hướng bên trái (sidebar)
và logic kiểm tra "bạn đã đăng nhập chưa, có quyền vào trang này không".

### `src/app/(internal)/task-center/page.tsx` 🟢
Trang **"Trung tâm việc cần làm"** — nơi HR thấy danh sách việc cần xử lý hôm nay
(đơn mới chưa duyệt, job import bị lỗi...). Muốn đổi tên tiêu đề/nhãn trên trang
→ sửa ở đây.

### `src/app/(internal)/department/page.tsx` 🟢
Trang dành cho **trưởng bộ phận** — xem danh sách lao động được phân vào bộ phận
của mình.

### `src/app/(internal)/hr/registrations/page.tsx` 🟢
Trang HR **duyệt các đơn đăng ký trong ngày** — xác nhận lao động mới, xếp bộ
phận. Đây chính là màn hình HR dùng hàng ngày để xử lý các đơn từ trang chủ gửi
lên.

### `src/app/(internal)/hr/workers/page.tsx` 🟢
Trang HR **quản lý danh sách lao động** (tìm kiếm, xem hồ sơ, sửa thông tin).

### `src/app/(internal)/admin/dashboard/page.tsx` 🟢
Trang **tổng quan số liệu** cho admin — số đơn hôm nay, số lao động, v.v.

### `src/app/(internal)/admin/audit/page.tsx` 🟢
Trang xem **"nhật ký"** — ai đã đăng nhập/sửa gì, lúc nào (phục vụ truy vết khi có
sự cố).

### `src/app/(internal)/admin/data-scopes/page.tsx` 🟢
Trang phân quyền **"ai được xem dữ liệu của bộ phận nào"** — ví dụ trưởng bộ phận A
chỉ xem được lao động bộ phận A, không xem được bộ phận B.

### `src/app/(internal)/admin/departments/page.tsx` 🟢
Trang **quản lý danh sách 71 bộ phận** — thêm/sửa/xoá tên bộ phận trực tiếp trên
giao diện web (không cần sửa file, không cần dev).

### `src/app/(internal)/admin/field-definitions/page.tsx` 🟢
Trang định nghĩa **các cột dữ liệu** hệ thống hiểu được khi import file Excel (ví
dụ: cột "Họ tên" trong file Excel của bạn tương ứng với cột nào trong hệ thống).

### `src/app/(internal)/admin/form-builder/page.tsx` 🟢 ⭐ (rất quan trọng)
Đây chính là nơi **thêm/sửa/xoá các câu hỏi trên form đăng ký công khai** (Giới
tính, Dân tộc, Thời gian đăng ký, Kênh giới thiệu...) **mà không cần sửa code**.
Muốn đổi chữ câu hỏi "Giới tính" thành "Giới tính của bạn", thêm câu hỏi mới, đổi
câu nào bắt buộc/không bắt buộc → vào thẳng trang này khi đã deploy web, **không
sửa file `seed.ts`** (vì seed chỉ chạy 1 lần lúc CSDL còn trống, sửa file sau đó
sẽ không có tác dụng gì lên dữ liệu đang chạy thật).

### `src/app/(internal)/admin/import-data/page.tsx` 🟢
Trang admin **tải file Excel/CSV lên để nhập dữ liệu hàng loạt** (danh sách lao
động cũ, bộ phận...), theo dõi tiến trình từng job import.

### `src/app/(internal)/admin/notifications/page.tsx` 🟢
Trang quản lý **thông báo hệ thống** gửi cho người dùng nội bộ.

### `src/app/(internal)/admin/permissions/page.tsx` 🟢
Trang cấu hình **quyền hạn theo vai trò** (Admin làm được gì, HR làm được gì,
Trưởng bộ phận làm được gì).

### `src/app/(internal)/admin/planning/page.tsx` 🟢
Trang **lập kế hoạch tuyển dụng** — đặt chỉ tiêu số lượng lao động cần cho từng
bộ phận theo từng giai đoạn thời gian.

### `src/app/(internal)/admin/recycle-bin/page.tsx` 🟢
**"Thùng rác"** — dữ liệu bị xoá (đơn, lao động...) không mất hẳn ngay mà nằm ở
đây trước, admin có thể khôi phục lại nếu xoá nhầm.

### `src/app/(internal)/admin/rules/page.tsx` 🟢
Trang cấu hình các **"luật" tự động** của hệ thống — ví dụ luật "bắt buộc phải có
CCCD mới cho nộp đơn" mà bạn thấy nhắc ở trang chủ chính là 1 rule cấu hình được
ở đây (không phải cố định trong code).

### `src/app/(internal)/admin/system/page.tsx` 🟢
Trang xem **"sức khoẻ" hệ thống** — DB có đang chạy ổn không, job nền có bị kẹt
không.

### `src/app/(internal)/admin/users/page.tsx` 🟢 ⭐
Trang **quản lý tài khoản đăng nhập** — đổi mật khẩu, thêm tài khoản mới, xoá tài
khoản. Dùng trang này để tạo các tài khoản HR_RECRUITER/DEPT_MANAGER sau khi đã
đăng nhập bằng tài khoản ADMIN được bootstrap từ `INITIAL_ADMIN_USERNAME`/
`INITIAL_ADMIN_PASSWORD` (xem mục seed.ts bên dưới).

### `src/app/(internal)/admin/worker-profiles/page.tsx` 🟢
Trang xem **hồ sơ lao động đã đối chiếu với DW Data** (dữ liệu kho lao động cũ) —
biết ai là lao động cũ quay lại, ai là người hoàn toàn mới.

### `src/app/(internal)/admin/workflow/page.tsx` 🟢
Trang cấu hình các **giai đoạn xử lý 1 đơn đăng ký** đi qua (vd: Mới nộp → Đã
xác nhận → Đã xếp việc...) — đổi tên/thêm bớt giai đoạn tại đây.

### `src/app/(internal)/admin/workforce-movements/page.tsx` 🟢
Trang theo dõi **biến động nhân sự** — ai chuyển bộ phận, ai nghỉ việc, ai quay
lại làm.

### `src/components/sidebar.tsx` 🟢
Thanh menu bên trái trong toàn bộ khu nội bộ — chứa các link tới từng trang admin
kể trên. Muốn đổi tên hiển thị của 1 mục trong menu (vd. đổi "Bộ phận" thành
"Phòng ban") thì sửa chữ trong file này.

### `src/components/registrations-grid.tsx` 🟢
Bảng dữ liệu dạng lưới (giống Excel) hiển thị danh sách đơn đăng ký cho HR thao
tác duyệt/sửa — dùng trong trang `hr/registrations`.

---

## PHẦN F — Các "route API" (phần xử lý phía server) 🔴

Tất cả các file nằm trong `src/app/api/.../route.ts` **không phải là giao diện
bạn nhìn thấy** — đây là phần "hậu trường": khi bạn bấm 1 nút trên web (vd. "Xác
nhận đăng ký"), trình duyệt sẽ gửi yêu cầu tới đúng 1 trong các file này, file đó
xử lý (lưu vào cơ sở dữ liệu, kiểm tra hợp lệ...) rồi trả kết quả lại cho web hiển
thị. **Bạn không cần và không nên tự sửa các file này** — sửa sai có thể làm cả
tính năng ngừng hoạt động (như đã thấy ở lỗi "Giới tính" trước đó, phải nhờ dev
sửa đúng logic). Dưới đây là bảng tra "file này phục vụ tính năng nào", để khi có
lỗi bạn biết mô tả đúng chỗ cho dev:

**Đăng ký / công khai:**
- `api/registrations/route.ts` — nhận đơn đăng ký mới
- `api/registrations/check/route.ts` — kiểm tra CCCD đã đăng ký hôm nay chưa, có
  phải lao động cũ không
- `api/registrations/[id]/route.ts` — sửa/xoá 1 đơn cụ thể
- `api/lookup/route.ts` — phục vụ trang "Tra cứu kết quả"
- `api/questions/route.ts` — lấy danh sách câu hỏi form đang bật
- `api/departments/route.ts` — lấy danh sách bộ phận cho dropdown
- `api/health/route.ts` — kiểm tra hệ thống còn sống không

**Xác thực:**
- `api/auth/login/route.ts`, `api/auth/logout/route.ts` — đăng nhập/đăng xuất

**Nghiệp vụ nội bộ:**
- `api/workers/route.ts`, `api/worker-profiles/[cccd]/route.ts` — dữ liệu lao động
- `api/workforce-movements/route.ts`, `api/workforce-movements/[id]/route.ts` —
  biến động nhân sự
- `api/workflow-stages/route.ts` — các giai đoạn xử lý đơn
- `api/planning/route.ts`, `api/planning/[id]/route.ts`,
  `api/planning/[id]/allocate/route.ts`, `api/planning/unplanned/route.ts` — kế
  hoạch tuyển dụng
- `api/task-center/route.ts` — dữ liệu trang việc cần làm
- `api/export/route.ts` — xuất dữ liệu ra Excel/CSV
- `api/bulk-import/route.ts` — import nhanh (bản cũ, đơn giản)
- `api/users/route.ts` — quản lý tài khoản

**Quản trị (admin):**
- `api/admin/dashboard/route.ts`, `api/admin/system-stats/route.ts` — số liệu
- `api/admin/backup/route.ts` — sao lưu dữ liệu
- `api/admin/history/route.ts` — lịch sử thao tác
- `api/admin/recycle-bin/route.ts` — thùng rác
- `api/admin/rules/route.ts` — luật tự động
- `api/admin/workflow/route.ts` — cấu hình giai đoạn
- `api/admin/permissions/route.ts` — phân quyền vai trò
- `api/admin/data-scopes/route.ts` — phân quyền theo bộ phận
- `api/admin/notifications/route.ts` — thông báo
- `api/admin/field-definitions/route.ts`,
  `api/admin/field-definitions/template/route.ts` — định nghĩa cột dữ liệu + file
  mẫu tải về
- `api/admin/worker-profiles/backfill/route.ts` — chạy lại việc đối chiếu hồ sơ
  hàng loạt

**Import dữ liệu (nhập file Excel hàng loạt):**
- `api/admin/import-data/route.ts` — khởi tạo job import
- `api/import/upload/route.ts` — nhận file bạn tải lên
- `api/import/worker/route.ts` — xử lý từng bước của job (đọc → kiểm tra → ghi vào
  hệ thống)
- `api/import/jobs/route.ts`, `api/import/job/[id]/route.ts`,
  `api/import/job/[id]/log/route.ts` — danh sách/chi tiết/nhật ký từng job
- `api/import/job/[id]/retry/route.ts`, `api/import/job/[id]/cancel/route.ts` —
  chạy lại / huỷ job lỗi
- `api/cron/run/route.ts` — "đồng hồ báo thức" tự động gọi định kỳ để hệ thống tự
  chạy tiếp các job đang dở, gửi thông báo tồn đọng, v.v — **không tắt/xoá file
  này** nếu không muốn các tác vụ tự động ngừng chạy

---

## PHẦN G — Tầng dữ liệu (kết nối cơ sở dữ liệu) 🔴

### `src/db/index.ts`
Nơi thiết lập **kết nối** tới cơ sở dữ liệu (địa chỉ server DB, mật khẩu kết nối
DB — khác với mật khẩu đăng nhập web). Sai 1 ký tự ở đây = cả web không load được
gì, vì mọi trang đều cần lấy dữ liệu qua đây.

### `src/db/schema.ts`
Bản thiết kế **"tủ hồ sơ"** — khai báo có những bảng nào (đơn đăng ký, lao động,
bộ phận, tài khoản...), mỗi bảng có những ngăn/cột nào, kiểu dữ liệu gì. Đây là
"xương sống" toàn hệ thống — sửa sai có thể làm mất dữ liệu, tuyệt đối cần dev.

---

## PHẦN H — Logic nghiệp vụ lõi (`src/lib`) 🔴

Các file trong thư mục này là nơi chứa **"luật chơi"** thật sự của hệ thống — ví
dụ tại sao lao động cũ không cần trả lời lại câu hỏi, tại sao CCCD trùng thì báo
lỗi... Đây là phần **kỹ thuật nhất** trong toàn dự án. Bạn nên đọc để hiểu hệ
thống hoạt động ra sao (biết mô tả đúng vấn đề cho dev), nhưng việc sửa nên để dev
đảm nhiệm vì 1 dòng sai có thể gây lỗi dây chuyền cho nhiều tính năng cùng lúc
(giống lỗi "thiếu Giới tính" đã gặp — do đúng 1 điều kiện `if` sai trong
`api/registrations/route.ts`, khiến toàn bộ lao động cũ không đăng ký được).

| File | "Luật chơi" nó phụ trách |
|---|---|
| `auth.ts` | Mã hoá mật khẩu, kiểm tra đăng nhập đúng/sai, hết hạn phiên đăng nhập |
| `helpers.ts` | Vài hàm nhỏ dùng chung, vd. lấy đúng ngày giờ Việt Nam |
| `validators.ts` | Quy định định dạng hợp lệ: CCCD bắt buộc đúng 12 chữ số, SĐT đúng định dạng VN... |
| `date-parser.ts` | Đọc hiểu các kiểu ngày tháng khác nhau khi import file Excel cũ (vd `13/08/2024` lẫn `2024-08-13`) |
| `file-parser.ts` | Đọc nội dung file Excel/CSV bạn tải lên |
| `csv-client.ts` | Đọc CSV ngay trên trình duyệt (không cần gửi lên server trước) |
| `metadata.ts` | Biết "cột nào trong Excel của bạn tương ứng với cột nào trong hệ thống" |
| `matching.ts` | So khớp người đăng ký với dữ liệu DW Data cũ — quyết định ai là "lao động cũ" |
| `rule-engine.ts` | Chạy các luật cấu hình được ở trang `/admin/rules` |
| `workflow.ts` | Điều khiển đơn đi qua các giai đoạn (Mới → Đã xếp việc...) |
| `workforce-movements.ts` | Ghi nhận khi 1 lao động chuyển bộ phận/nghỉ việc |
| `planning.ts` | Tính toán, kiểm tra chỉ tiêu kế hoạch tuyển dụng không bị chồng chéo |
| `notifications.ts` | Hàng đợi gửi thông báo (ai cần được báo tin gì) |
| `providers/types.ts`, `providers/registry.ts` | Cho phép sau này đổi nơi gửi thông báo (vd. thêm gửi Zalo/SMS thật) mà không phải viết lại toàn bộ hệ thống |
| `scheduler.ts` | "Người quản lý" chạy các việc nền định kỳ (job import bị kẹt, hàng đợi thông báo) |
| `import-engine.ts`, `import-jobs.ts` | Toàn bộ quy trình xử lý 1 file Excel bạn tải lên: đọc → kiểm tra từng dòng → ghi vào hệ thống |
| `dashboard.ts` | Tính số liệu hiển thị ở trang Dashboard, theo đúng quyền xem của từng người |
| `seed.ts` ⭐ | **Dữ liệu khởi tạo lần đầu** khi CSDL còn trống: 5 câu hỏi form mặc định, các giai đoạn workflow mặc định... KHÔNG còn tài khoản mẫu hardcode nào trong file này. Tài khoản ADMIN đầu tiên chỉ được tạo nếu bạn đặt sẵn 2 biến môi trường `INITIAL_ADMIN_USERNAME`/`INITIAL_ADMIN_PASSWORD` trên Vercel (xem mục 5, Bước 3 ở `HUONG_DAN_HE_THONG.md`) — nếu không đặt, hệ thống không tự tạo tài khoản nào. ⚠️ Toàn bộ hàm `ensureSeed()` **chỉ chạy khi bảng tương ứng còn rỗng** — sửa file này sau khi hệ thống đã có dữ liệu sẽ **không** thay đổi gì trên web thật, phải thao tác qua giao diện admin. |

---

## PHẦN I — Thư viện giao diện dùng chung

### `src/components/ui.tsx` 🟡
File chứa các "khối Lego" giao diện tái sử dụng khắp nơi trong web: `Button` (nút
bấm), `Card` (khung thẻ bo góc), `Input` (ô nhập liệu), `Label` (nhãn), `Badge`
(nhãn nhỏ tròn), `SearchableSelect` (dropdown có tìm kiếm), `Modal` (hộp thoại nổi
lên giữa màn hình), `Toaster`/`toast()` (thông báo nhỏ góc màn hình — chính là cái
banner đỏ "Thiếu câu trả lời bắt buộc" bạn từng thấy). Muốn đổi **kiểu dáng chung**
của tất cả nút/thẻ trong toàn site (bo góc nhiều hơn, đổ bóng đậm hơn...) thì sửa
ở đây — nhưng vì nó dùng ở hàng chục trang khác nhau, sửa gì cũng nên test kỹ vì
ảnh hưởng đồng loạt.

---

## Tóm tắt nhanh: 3 câu hỏi bạn nên tự trả lời trước khi sửa 1 file

1. **File có nằm trong `src/app/page.tsx`, `(internal)/.../page.tsx`,
   `brand-logo.tsx`, hay các file `.md` không?** → Thường là chữ hiển thị, sửa
   tương đối an toàn (🟢).
2. **File có nằm trong `src/lib/` hoặc `src/app/api/`, hoặc là `schema.ts`/
   `db/index.ts` không?** → Đây là logic/kết nối hệ thống (🔴) — nhờ dev.
3. **Nội dung mình muốn đổi có thể sửa ngay trên giao diện web đã đăng nhập
   không** (câu hỏi form, bộ phận, tài khoản, workflow, rule...)? → Nếu có, **luôn
   ưu tiên sửa trên web**, không sửa file — vì sửa file `seed.ts` chỉ có tác dụng
   lúc CSDL còn trống, không áp dụng lên dữ liệu đang chạy thật.
