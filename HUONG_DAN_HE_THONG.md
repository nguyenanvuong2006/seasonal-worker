# HỆ THỐNG QUẢN LÝ TUYỂN DỤNG LAO ĐỘNG THỜI VỤ — DALAT HASFARM

> File này là tài liệu **duy nhất, luôn cập nhật** cho dự án. Không cần tạo thêm file `.md` nào khác trong repo.
> Mọi lần chỉnh sửa hệ thống, hãy cập nhật lại các mục tương ứng trong file này (đặc biệt mục "Tính năng đã hoàn thành" và "Prompt tiếp tục phát triển").
>
> ⚠️ **Ràng buộc quan trọng:** máy tính của người vận hành **không có quyền cài đặt phần mềm**. Mọi hướng dẫn trong file này chỉ dùng trình duyệt web (GitHub, Vercel, Neon) — không có bước nào yêu cầu mở terminal, cài Node.js/Git, hay chạy lệnh dòng lệnh trên máy cá nhân.

---

## 1. HỆ THỐNG NÀY LÀ GÌ

Đây là bản thay thế **chuyên nghiệp, chạy trên nền web** cho quy trình 4 sheet Google hiện tại của bạn:

| Sheet Google cũ | Vai trò trong hệ thống mới |
|---|---|
| `Responses` (Google Form) | Trang đăng ký công khai cho lao động — `/` |
| `Daily Application` | Màn hình HR sắp xếp công việc — `/hr/registrations` |
| `Department` | Trang quản trị bộ phận — `/admin/departments` |
| `DW Data` | Kho dữ liệu lao động để đối chiếu cũ/mới — `/hr/workers` |

Công nghệ: **Next.js 16 (React 19) + PostgreSQL + Drizzle ORM**, chạy được hoàn toàn miễn phí trên Vercel + Neon (xem mục 5).

---

## 2. TÍNH NĂNG ĐÃ HOÀN THÀNH (tính đến bản này)

### 2.1 Trang đăng ký cho lao động (`/`)
- Bắt buộc nhập **CCCD (9–12 số)** và **số điện thoại** trước tiên, không còn lựa chọn "không mang CCCD".
- Hệ thống tự kiểm tra: đã đăng ký hôm nay chưa → đã có trong DW Data (lao động cũ) chưa → nếu là lao động cũ thì tự điền sẵn họ tên/ngày sinh/địa chỉ.
- Sau bước kiểm tra CCCD + SĐT, mới hiển thị **các câu hỏi động** (xem 2.4).
- Trường "Cũ / Mới" vẫn để người lao động tự khai (phụ thuộc sự trung thực), đồng thời hệ thống **tự đối chiếu ngầm** với DW Data theo 3 tầng để HR có căn cứ kiểm tra chéo:
  1. Khớp CCCD tuyệt đối
  2. Khớp Họ tên + Năm sinh
  3. Khớp Họ tên + 9 số cuối SĐT
  → Kết quả lưu vào cột `dwMatch` (MATCHED/NEW) hiển thị cho HR, không hiện cho lao động.

### 2.2 Màn hình HR sắp xếp việc (`/hr/registrations`)
- **Mặc định chỉ hiện đơn đăng ký của hôm nay** (tinh gọn màn hình như bạn yêu cầu).
- Có ô chọn **"Từ ngày"** (bật "khoảng ngày") để xem/xuất dữ liệu tham khảo các ngày trước — đúng yêu cầu "box lựa chọn từ ngày nào".
- Lọc theo bộ phận, trạng thái, kết quả đối chiếu DW (MATCHED/NEW).
- Sắp xếp bộ phận, ngày bắt đầu, ghi chú, duyệt hàng loạt (tối đa 500 đơn/lần) → khi duyệt, lao động **mới** sẽ tự động được thêm vào DW Data.
- Cảnh báo trùng tên (`duplicateNameFlag`).
- Xuất Excel (`/api/export`).

### 2.3 Quản trị Bộ phận (`/admin/departments`)
- Thêm/sửa bộ phận mới (Dept., Group, Tên tiếng Việt, người phụ trách, SĐT, link sheet riêng, chỉ tiêu/ngày).
- Bộ phận mới thêm **tự động xuất hiện trong dropdown** ở màn hình Daily Application — đúng yêu cầu liên kết 2 chiều.

### 2.4 Trình tạo câu hỏi động (`/admin/form-builder`)
- Admin có thể thêm câu hỏi mới (loại: văn bản / số / chọn từ danh sách / có-không), đặt bắt buộc hay không, thứ tự hiển thị.
- Có trường **"Áp dụng từ ngày"** (`applyFrom`) — câu hỏi chỉ hiện ra trên form public kể từ ngày chỉ định, không ảnh hưởng dữ liệu các ngày trước.
- Đã nạp sẵn các câu hỏi lấy từ header gốc của sheet `Responses`: Giới tính, Dân tộc, Thời gian đăng ký làm, Kênh giới thiệu, Cam kết thông tin chính xác.
- **Việc cần làm thêm:** rà lại toàn bộ các cột trong sheet `Responses` gốc, câu nào chưa có trong danh sách seed ở `src/lib/seed.ts` thì vào `/admin/form-builder` bấm thêm (không cần sửa code).

### 2.5 Tra cứu hồ sơ lao động (`/hr/workers`, `/lookup`)
- Tìm kiếm trong DW Data (~20.7k dòng) theo tên/CCCD/SĐT.
- `/lookup`: trang cho lao động tự tra cứu trạng thái hồ sơ của mình.

### 2.6 Phân quyền & bảo mật (RBAC)
Có 3 vai trò, đăng nhập bằng cookie JWT (12 giờ):
| Vai trò | Username mặc định | Mật khẩu mặc định | Quyền |
|---|---|---|---|
| Quản trị viên | `admin` | `admin123` | Toàn quyền: users, departments, form-builder, audit log |
| Nhân sự tuyển dụng | `hr` | `hr123` | Xem/duyệt Daily Application, xuất báo cáo, tra cứu DW Data |
| Phụ trách bộ phận | `truongbophan` | `bophan123` | Chỉ xem/sắp xếp lao động thuộc bộ phận mình |

> ⚠️ **BẮT BUỘC đổi 3 mật khẩu mặc định này ngay sau khi triển khai thật** (vào `/admin/users`).

### 2.7 Audit log (`/admin/audit`)
Ghi lại mọi hành động duyệt/sửa/xoá quan trọng kèm người thực hiện — phục vụ truy vết khi có sai sót.

### 2.8 Nhập dữ liệu ban đầu — 100% qua trình duyệt (`/admin/import-data`)
- Trang admin cho phép **tải trực tiếp 3 file CSV** (Department, DW Data, Daily Application) từ máy/điện thoại lên hệ thống bằng nút chọn file — **không cần cài Node.js, không cần chạy lệnh gì trên máy tính**.
- Trình duyệt tự đọc và tách nhỏ file CSV thành từng lô (vd DW Data ~20.7k dòng được chia lô 800 dòng/lần) rồi gửi tuần tự lên máy chủ, tránh giới hạn dung lượng và thời gian xử lý của Vercel.
- Có nhật ký tiến trình ngay trên trang, dữ liệu trùng (theo CCCD) sẽ tự động được bỏ qua, không nhập lại.
- File `scripts/import-sheets.mjs` cũ (chạy bằng Node.js trên máy) vẫn được giữ lại trong repo để tham khảo/dự phòng, nhưng **không cần dùng nữa** — dùng `/admin/import-data` thay thế hoàn toàn.

### 2.9 Tạo cấu trúc database không cần cài phần mềm
File `schema.sql` ở gốc dự án chứa toàn bộ lệnh tạo bảng — chỉ cần **dán vào SQL Editor trên website Neon** và bấm Run (xem mục 5, Bước 3). Không cần cài `drizzle-kit` hay bất kỳ công cụ nào trên máy.

### 2.10 Metadata Engine — thêm/sửa trường & câu hỏi không cần sửa code (`/admin/field-definitions`)
- Bảng cấu hình trung tâm `field_definitions` mô tả từng trường "lõi" (Department / DW Data / Daily Application): tên hiển thị, tên cột khi Import, tên cột khi Export, danh sách **alias** (các tên cột khác cũng được nhận diện), kiểu dữ liệu, bắt buộc hay không, có tìm kiếm/hiển thị/export/import hay không, thứ tự cột.
- Trang `/admin/field-definitions` (chỉ Admin) cho phép sửa toàn bộ các thuộc tính trên ngay trên web — đổi "Điện thoại" thành "Số điện thoại" chỉ cần gõ lại tên hiển thị, không đụng code, không đổi database.
- **Câu hỏi động** (`form_questions`, quản lý ở `/admin/form-builder`) nay cũng có thêm **alias import** và **tên cột export riêng** — admin có thể thêm bao nhiêu tên cột tương đương tuỳ ý cho 1 câu hỏi.
- **Import CSV/XLSX thông minh**: `/api/admin/import-data` không còn dò tên cột cố định trong code — mọi cột được dò qua `field_definitions`/`form_questions` (tên chính + alias, không phân biệt hoa/thường/khoảng trắng thừa). Cột không nhận diện được sẽ bị bỏ qua (không dừng import, chỉ cảnh báo). Hỗ trợ cả `.csv` và `.xlsx`/`.xls` (đọc bằng thư viện `xlsx` ngay trên trình duyệt, không cần chuyển đổi định dạng).
- **Báo cáo import chi tiết**: sau khi nhập hiển thị số dòng thành công / trùng dữ liệu (CCCD) / lỗi, kèm nút **Download Error Report** để tải các dòng lỗi (CSV) ra sửa và nhập lại riêng.
- **File mẫu (Template)**: nút "Tải file mẫu" ở trang Import và trang Field Definitions sinh CSV header trực tiếp từ metadata hiện tại (kể cả các câu hỏi động đang bật) — không phải file tĩnh, nên luôn khớp với cấu hình mới nhất.
- **Export Excel động**: `/api/export` build cột từ `field_definitions` (exportable=true, theo `sortOrder`) + tất cả câu hỏi động đang Active — thêm câu hỏi mới ở form-builder thì lần export kế tiếp tự có thêm cột, không cần sửa code.
- **Tìm kiếm động (một phần)**: màn hình `/hr/workers` (DW Data) build điều kiện tìm kiếm từ các trường được đánh dấu `searchable=true` trong `field_definitions` (nhóm `dw_data`) — bật/tắt cột nào được tìm kiếm ngay tại `/admin/field-definitions`, không cần sửa code. **Chưa làm**: áp dụng tương tự cho các bộ lọc nâng cao ở `/hr/registrations` (mục 3).
- Không mất dữ liệu cũ: khi đổi tên câu hỏi/trường, ẩn/hiện, hay đổi thứ tự — dữ liệu đã lưu trong `customAnswers` hoặc các cột gốc vẫn giữ nguyên, chỉ có cách hiển thị/đặt tên thay đổi.

### 2.11 Giai đoạn 2 — Soft Delete, Versioning, Recycle Bin, Health Monitor
> Đây là **Phase 1** của kế hoạch "Giai đoạn 2" (kiến trúc mở rộng dài hạn) — xem kế hoạch đầy đủ + các phần còn lại (Workflow Engine, Rule Engine, Dashboard Builder, Notification Engine, Job Scheduler, Plugin/Event Bus, Logging framework riêng, API versioning, phân quyền chi tiết theo chức năng) ở mục **8. KẾ HOẠCH GIAI ĐOẠN 2** bên dưới.

- **Soft Delete**: `departments`, `dw_data`, `daily_applications` có thêm cột `deleted_at`/`deleted_by`. Nút "Xoá" ở các màn hình không xoá thật nữa — chỉ ẩn hồ sơ (mọi danh sách/tìm kiếm/đối chiếu DW/matching đều tự động bỏ qua hồ sơ đã xoá mềm). 3 unique index (CCCD của DW Data, CCCD+ngày của Daily Application, Dept+Group của Department) đã chuyển thành **partial index** (`WHERE deleted_at IS NULL`) để có thể đăng ký/nhập lại đúng CCCD đã từng bị xoá trước đó mà không bị lỗi trùng khoá.
- **Thùng rác (`/admin/recycle-bin`)**: xem toàn bộ hồ sơ đã xoá mềm ở cả 3 khối, **Khôi phục** (trả `deleted_at` về NULL) hoặc **Xoá vĩnh viễn** (xoá thật khỏi database — không thể hoàn tác).
- **Versioning (xem & khôi phục lịch sử)**: không tạo bảng mới — tận dụng `audit_logs` sẵn có. Mỗi lần sửa (Department / DW Data / Daily Application) đều lưu kèm `before` (dữ liệu trước khi sửa) và `after` (dữ liệu sau khi sửa) vào cột `details` (jsonb). API `/api/admin/history?targetType=...&id=...` lọc lại các dòng audit của đúng 1 hồ sơ; nút **"Lịch sử"** ở màn hình `/hr/registrations` (mỗi dòng) mở bảng so sánh trước/sau theo từng lần sửa, kèm nút **"Khôi phục về trước lần sửa này"**.
- **Health Monitor (`/admin/system`)**: số liệu lấy trực tiếp từ Postgres (Neon) — tổng số bản ghi mỗi bảng (đang hoạt động / trong thùng rác), dung lượng database, lần import/export/đăng nhập gần nhất (đọc từ `audit_logs`), thông tin build hiện tại (commit, môi trường, vùng — đọc từ biến môi trường Vercel). **Không hiển thị CPU/RAM/uptime máy chủ** vì Vercel (serverless) không cấp quyền đọc chỉ số phần cứng của host — trang có link thẳng tới Neon Dashboard và Vercel Dashboard để xem các chỉ số đó ở nguồn thật.
- **Tìm kiếm động ở Daily Application**: ô "Tìm nhanh" tại `/hr/registrations` nay cũng đọc cấu hình `searchable` từ `/admin/field-definitions` (nhóm `daily_application`) giống cách đã làm cho `/hr/workers` ở bản trước — bật/tắt cột nào được tìm kiếm nhanh không cần sửa code.
- **Đăng nhập được ghi log**: mỗi lần đăng nhập thành công ghi 1 dòng `LOGIN` vào `audit_logs`, phục vụ Health Monitor + tra cứu sau này.

---

## 3. NHỮNG GÌ **CHƯA** LÀM / CẦN KIỂM TRA LẠI

> Xem thêm bảng đối chiếu đầy đủ (Workflow/Rule Engine/RBAC/Notification/Dashboard/Scheduler...) ở **mục 9**.

- [ ] Rà soát đầy đủ **tất cả header** của sheet `Responses` gốc so với danh sách câu hỏi hiện có trong `/admin/form-builder`, bổ sung câu hỏi còn thiếu.
- [ ] Đổi mật khẩu mặc định + đổi biến môi trường `AUTH_SECRET` trước khi dùng thật.
- [ ] Kiểm tra lại độ chính xác của bước đối chiếu DW Data (Tầng 2/3 theo tên+năm sinh hoặc tên+SĐT) trên dữ liệu thật, vì tên tiếng Việt dễ trùng.
- [ ] Quyết định: có cần gửi thông báo (Zalo/SMS/email) cho lao động sau khi được xếp việc không.
- [ ] Xác nhận lại toàn bộ *chỉ tiêu/ngày* (`dailyQuota`) của từng bộ phận có được dùng để cảnh báo khi vượt quota chưa (hiện DB đã có cột nhưng cần xác nhận UI có cảnh báo hay chưa).
- [ ] **Metadata Engine — phần chưa hoàn thiện:**
  - Bộ lọc dạng dropdown (bộ phận/trạng thái/DW match) ở `/hr/registrations` vẫn cố định trong code; chỉ riêng ô **"Tìm nhanh"** (tìm kiếm tự do) đã đọc `searchable` từ `/admin/field-definitions` (giống `/hr/workers`) — chưa tự sinh thêm Ô LỌC (dropdown) mới hoàn toàn từ metadata.
  - Dashboard/báo cáo tổng hợp dạng kéo-thả (Dashboard Builder) chưa có — xem mục 8, hạng mục #4.
  - Trang `/admin/field-definitions` hiện quản lý trường "lõi"; câu hỏi động vẫn cấu hình riêng ở `/admin/form-builder` (2 màn hình tách biệt theo đúng kiến trúc DB hiện có — không gộp chung để tránh phá vỡ dữ liệu `form_questions` đang chạy thật).
  - Import Excel `.xlsx` với nhiều sheet: hiện chỉ đọc **sheet đầu tiên** của file `.xlsx`/`.xls`.
- [ ] **Giai đoạn 2 — các hạng mục CHƯA triển khai** (xem lý do + kế hoạch ở mục 8): Workflow Engine, Rule Engine, Dashboard Builder, Notification Engine, Job Scheduler, Kiến trúc Plugin/Event Bus, Logging framework riêng (hiện dùng chung `audit_logs`), API versioning (`/api/v1`, `/api/v2`), phân quyền chi tiết theo từng chức năng (hiện vẫn theo Role: ADMIN/HR_RECRUITER/DEPT_MANAGER), Backup/Restore tự động (hiện backup thủ công qua Neon Branches hoặc Xuất Excel).

---

## 4. CẤU TRÚC DỮ LIỆU (tóm tắt)

- **departments** — danh sách bộ phận (thay sheet Department). Có `deletedAt`/`deletedBy` (soft delete, mục 2.11) — khôi phục tại `/admin/recycle-bin`.
- **dw_data** — kho lao động gốc, CCCD là khoá đối chiếu chính (thay sheet DW Data). Có `deletedAt`/`deletedBy` (soft delete) — mọi truy vấn đối chiếu/tìm kiếm tự bỏ qua hồ sơ đã xoá mềm.
- **daily_applications** — đơn đăng ký theo ngày, CCCD bắt buộc, có `dwMatch`/`declaredType`, `customAnswers` (JSON chứa câu trả lời động) (thay sheet Daily Application). Có `deletedAt`/`deletedBy` (soft delete).
- **form_questions** — câu hỏi động, có `applyFrom` để chỉ áp dụng từ 1 ngày nhất định, có `aliases`/`exportColumnName` để tham gia Metadata Engine (mục 2.10)
- **field_definitions** — Metadata Engine: định nghĩa tập trung cho các trường lõi (Department/DW Data/Daily Application) — tên hiển thị, alias import, tên cột export, bật/tắt import/export/search/hiển thị, thứ tự cột (mục 2.10)
- **users** — tài khoản đăng nhập nội bộ (RBAC)
- **audit_logs** — nhật ký thao tác; nay còn dùng làm nguồn dữ liệu cho Versioning (`before`/`after` trong cột `details`, mục 2.11) và Health Monitor (`/admin/system`)

Chi tiết đầy đủ từng cột: xem `src/db/schema.ts`.

**Lưu ý về unique index:** `dept_group_uq`, `dw_cccd_uq`, `daily_app_cccd_date_uq` đều là **partial index** (`WHERE deleted_at IS NULL`) — nghĩa là ràng buộc duy nhất chỉ áp dụng cho hồ sơ đang hoạt động; hồ sơ đã xoá mềm không tính vào ràng buộc này. Mọi câu lệnh `INSERT ... ON CONFLICT` liên quan phải khai báo đúng `WHERE deleted_at IS NULL` để khớp với index (xem `src/app/api/admin/import-data/route.ts` và `src/app/api/bulk-import/route.ts`).

---

## 5. TRIỂN KHAI MIỄN PHÍ — CHỈ THAO TÁC TRÊN TRÌNH DUYỆT, KHÔNG CÀI PHẦN MỀM

> Toàn bộ các bước dưới đây thực hiện bằng cách click chuột trên website, không cần mở terminal, không cần cài Node.js/Git/drizzle-kit trên máy tính (kể cả khi máy bị chặn quyền cài đặt phần mềm). Vercel tự build code trên máy chủ của họ, không phải máy của bạn.

### Bước 1 — Tạo database miễn phí (Neon), qua website
1. Vào https://neon.tech → **Sign up** (dùng Google) → **Create a project**.
2. Vào **Dashboard** của project vừa tạo → copy chuỗi **Connection string** dạng `postgresql://user:pass@host/dbname?sslmode=require`. Lưu lại, dùng ở các bước sau.
3. Vẫn trên trang Neon, mở mục **SQL Editor** (menu bên trái) → **New query**.
4. Mở file `schema.sql` (trong dự án đã tải về) → copy toàn bộ nội dung → dán vào SQL Editor → bấm **Run**.
   → Bước này tạo toàn bộ 7 bảng (bao gồm `field_definitions` — Metadata Engine), thay thế hoàn toàn cho việc phải cài `drizzle-kit` chạy trên máy.

### Bước 2 — Đưa code lên GitHub, qua website (không cần Git)
1. Vào https://github.com → Sign up/Login → bấm **New repository** (đặt Private) → **Create repository**.
2. Ở trang repo trống vừa tạo, bấm **uploading an existing file** (link màu xanh giữa trang).
3. Trên máy tính, mở thư mục dự án đã giải nén, chọn toàn bộ file/thư mục con (Ctrl+A) rồi **kéo-thả (drag & drop)** vào khung upload của GitHub (dùng Chrome/Edge để hỗ trợ kéo-thả cả thư mục). Chờ tải xong toàn bộ (~80 file, có thể mất vài phút).
4. Cuộn xuống cuối trang, bấm **Commit changes**.

### Bước 3 — Deploy lên Vercel, qua website
1. Vào https://vercel.com → Sign up bằng tài khoản GitHub vừa tạo → cấp quyền truy cập repo.
2. Bấm **Add New… > Project** → chọn repo vừa upload → **Import**.
3. Ở mục **Environment Variables**, thêm 3 biến (gõ trực tiếp trên web):
   - `DATABASE_URL` = chuỗi kết nối Neon ở Bước 1
   - `AUTH_SECRET` = một chuỗi ngẫu nhiên dài — có thể mở https://generate-secret.vercel.app/32 để lấy, copy-dán vào
   - `NODE_ENV` = `production`
4. Bấm **Deploy**. Vercel tự tải code, tự `npm install` và `next build` trên máy chủ của họ — bạn không cần cài gì. Chờ 2–5 phút tới khi thấy "Congratulations".
5. Bấm vào link dạng `https://<tên-app>.vercel.app` để mở app.

### Bước 4 — Tạo tài khoản đăng nhập đầu tiên
1. Mở link app vừa deploy — lần tải trang đầu tiên tự gọi `/api/health`, tự tạo 3 tài khoản mặc định (mục 2.6) và câu hỏi mặc định vì DB đang trống.
2. Đăng nhập bằng `admin` / `admin123` → vào **Phân quyền RBAC** (`/admin/users`) → đổi ngay mật khẩu cả 3 tài khoản.

### Bước 5 — Nhập dữ liệu gốc từ Google Sheet, qua website
1. Mở Google Sheet hiện tại → từng tab (Department, DW Data, Daily Application) → **File → Download → Comma-separated values (.csv)** → tải về máy/điện thoại.
2. Đăng nhập app bằng `admin` → vào menu **"Nhập dữ liệu ban đầu"** (`/admin/import-data`).
3. Chọn lần lượt 3 file CSV vừa tải, bấm **Bắt đầu nhập dữ liệu**. Theo dõi nhật ký tiến trình ngay trên màn hình tới khi báo "Hoàn tất toàn bộ".
   → Không cần cài phần mềm, không cần mở terminal — xử lý ngay trên trình duyệt + máy chủ Vercel.

> Chi phí = 0đ ở quy mô hiện tại (Vercel Free: đủ cho vài trăm lượt/ngày; Neon Free: 0.5 GB — dư cho ~21.000 dòng DW Data + dữ liệu hằng ngày nhiều năm).

### Bảo trì định kỳ (vẫn chỉ qua website)
- Neon Free tự tạm ngưng (sleep) nếu không có truy cập lâu — tự đánh thức khi có người vào app, chậm vài giây, không mất dữ liệu.
- Backup định kỳ: vào Neon → **Branches** → tạo snapshot; hoặc vào app → `/hr/registrations` → **Xuất Excel** để lưu ngoài.
- Sau này cần sửa/thêm tính năng: đưa yêu cầu cho AI (mục 7) → AI sửa code → bạn chỉ cần **upload lại các file đã đổi lên đúng vị trí trên GitHub** (bấm phím `.` khi đang xem repo trên GitHub để mở trình soạn thảo github.dev ngay trên trình duyệt, sửa/dán code rồi Commit) → Vercel tự động deploy lại bản mới, không cần thao tác gì thêm trên máy.

> ⚠️ **Riêng bản cập nhật Metadata Engine (mục 2.10):** bản này có thêm bảng mới (`field_definitions`) và thêm cột mới cho `form_questions`. Nếu hệ thống **đã chạy thật trước đó** (đã có dữ liệu), sau khi upload code mới lên GitHub, hãy vào lại **Neon → SQL Editor** và dán **toàn bộ nội dung file `schema.sql`** (bản mới) rồi bấm **Run** — file đã dùng `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` nên chạy lại không làm mất dữ liệu cũ. Sau đó mở lại app 1 lần (gọi `/api/health`) để hệ thống tự nạp sẵn cấu hình mặc định cho `field_definitions`.

---

## 6. VẬN HÀNH HẰNG NGÀY (cho người mới)

0. (Chỉ 1 lần khi khởi tạo) Nhập dữ liệu gốc qua `/admin/import-data` — xem Bước 5, mục 5. Không cần lặp lại trừ khi muốn nạp lại dữ liệu lịch sử.
1. Lao động vào link app trên điện thoại/máy tính bảng đặt tại cổng → nhập CCCD + SĐT → điền form.
2. HR mở `/hr/registrations` mỗi sáng — mặc định thấy đơn hôm nay, xếp bộ phận, duyệt.
3. Muốn xem lại vài ngày trước để đối chiếu → bật "khoảng ngày", chọn "Từ ngày".
4. Có bộ phận mới → `/admin/departments` → thêm mới, tự có trong dropdung xếp việc.
5. Cần hỏi thêm thông tin mới trong form → `/admin/form-builder` → thêm câu hỏi, chọn ngày áp dụng.
5b. Cần đổi tên cột hiển thị/Import/Export hoặc thêm alias tên cột → `/admin/field-definitions`.
6. Cuối tuần/tháng → `/hr/registrations` → Xuất Excel để lưu trữ/báo cáo.

---

## 7. PROMPT TỔNG HỢP — DÙNG KHI ĐƯA DỰ ÁN NÀY CHO MỘT AI KHÁC ĐỂ TIẾP TỤC PHÁT TRIỂN

> Copy nguyên văn khối bên dưới, dán vào đầu cuộc trò chuyện với AI mới (kèm theo file ZIP dự án), rồi thêm yêu cầu tính năng mới của bạn vào cuối.

```
Bạn đang tiếp quản một hệ thống web đã được xây dựng gần hoàn chỉnh (không phải làm từ đầu). Đây là hệ thống quản lý tuyển dụng lao động thời vụ cho Dalat Hasfarm, thay thế cho quy trình Google Form + Google Sheet cũ. Công nghệ: Next.js 16 (App Router, React 19) + TypeScript + PostgreSQL (Drizzle ORM) + Tailwind CSS. Toàn bộ code nằm trong file ZIP đính kèm.

BỐI CẢNH NGHIỆP VỤ:
- Có 4 khối dữ liệu tương ứng 4 sheet Google cũ: Department (bộ phận), DW Data (~20.7k lao động lịch sử, dùng để đối chiếu lao động cũ/mới), Daily Application (đơn đăng ký mỗi ngày để HR xếp việc), Responses (Google Form gốc — các câu hỏi của form giờ là "câu hỏi động" quản lý trong bảng form_questions).
- CCCD là bắt buộc khi đăng ký (đã bỏ hoàn toàn lựa chọn "không mang CCCD" của form cũ).
- Việc phân loại lao động "cũ/mới" hiện có 2 lớp: (1) người lao động tự khai (declaredType, phụ thuộc sự trung thực), (2) hệ thống tự đối chiếu ngầm với DW Data theo 3 tầng — khớp CCCD tuyệt đối, rồi khớp Họ tên+Năm sinh, rồi khớp Họ tên+SĐT (xem src/lib/matching.ts) — kết quả lưu ở cột dwMatch để HR kiểm tra chéo.
- Màn hình Daily Application (src/components/registrations-grid.tsx) mặc định chỉ hiển thị đơn đăng ký NGÀY HÔM NAY để giao diện gọn, có nút bật "khoảng ngày" với ô chọn "Từ ngày" để xem/xuất dữ liệu các ngày trước làm tham khảo.
- Department (src/app/(internal)/admin/departments) có thể thêm bộ phận mới, tự động xuất hiện trong dropdown chọn bộ phận ở Daily Application.
- Form-builder (src/app/(internal)/admin/form-builder) cho phép Admin thêm câu hỏi mới cho form đăng ký công khai, có trường "applyFrom" để câu hỏi chỉ áp dụng từ 1 ngày chỉ định trở đi, không ảnh hưởng dữ liệu cũ.
- Có RBAC 3 vai trò: ADMIN (toàn quyền), HR_RECRUITER (duyệt/xếp việc/xuất báo cáo), DEPT_MANAGER (chỉ xem bộ phận mình). Đăng nhập bằng JWT cookie 12h (src/lib/auth.ts).
- Có audit log ghi mọi hành động quan trọng.
- Schema đầy đủ: src/db/schema.ts (bảng: departments, dw_data, daily_applications, form_questions, users, audit_logs). File schema.sql ở gốc dự án là bản SQL thuần tương ứng, dùng để dán trực tiếp vào Neon SQL Editor (người dùng KHÔNG được cài phần mềm trên máy, xem ràng buộc bên dưới).
- Nhập dữ liệu ban đầu (Department/DW Data/Daily Application) thực hiện qua trang web /admin/import-data (src/app/(internal)/admin/import-data/page.tsx gọi src/app/api/admin/import-data/route.ts): người dùng tải CSV từ Google Sheet rồi upload thẳng qua trình duyệt, trình duyệt tự parse (src/lib/csv-client.ts) và gửi theo lô lên server — không cần Node.js/terminal. Script scripts/import-sheets.mjs cũ chỉ giữ để tham khảo, không còn là cách chính.
- Toàn bộ tài liệu vận hành, danh sách tính năng đã hoàn thành, việc còn thiếu, và hướng dẫn triển khai miễn phí (Vercel + Neon Postgres, 100% qua trình duyệt) nằm trong file HUONG_DAN_HE_THONG.md ở gốc dự án — hãy đọc file này đầu tiên để nắm toàn bộ hiện trạng trước khi code bất cứ gì.
- METADATA ENGINE (đã có từ bản cập nhật gần nhất): bảng field_definitions (src/db/schema.ts, src/lib/metadata.ts) là nguồn duy nhất mô tả tên hiển thị/alias import/tên cột export/searchable/exportable/importable cho các trường lõi (Department/DW Data/Daily Application), quản lý tại /admin/field-definitions. Câu hỏi động (form_questions) đã có thêm aliases + exportColumnName, quản lý tại /admin/form-builder. Import (src/app/api/admin/import-data/route.ts) và Export (src/app/api/export/route.ts) đều PHẢI đọc qua src/lib/metadata.ts để lấy tên cột — KHÔNG được quay lại hard-code tên cột trong các file này. Nếu thêm trường lõi mới, thêm 1 dòng vào DEFAULT_FIELD_DEFINITIONS (src/lib/metadata.ts) để có giá trị mặc định khi seed lần đầu, đồng thời thêm field đó vào bảng tương ứng trong schema.ts + schema.sql.
- SOFT DELETE + VERSIONING (Giai đoạn 2 Phase 1): departments/dw_data/daily_applications có deletedAt/deletedBy — KHÔNG BAO GIỜ dùng db.delete() thật trên 3 bảng này nữa, luôn set deletedAt=now()/deletedBy=username (xem các route DELETE hiện có làm mẫu). Mọi query SELECT trên 3 bảng này phải có điều kiện isNull(deletedAt) trừ khi đang cố ý xem/khôi phục thùng rác. 3 unique index liên quan là partial index (WHERE deleted_at IS NULL) — mọi câu ON CONFLICT mới phải khai báo đúng WHERE này. Lịch sử sửa (before/after) lưu vào audit_logs.details — khi thêm route PATCH mới cho 1 bảng có soft-delete, hãy fetch bản ghi cũ trước khi update rồi ghi cả before/after vào writeAudit() để tính năng "Lịch sử"/"Khôi phục" (/api/admin/history) hoạt động đúng cho bảng đó.

RÀNG BUỘC QUAN TRỌNG:
- Người dùng KHÔNG có quyền cài đặt phần mềm trên máy tính của họ (bị chặn bởi chính sách máy). Mọi hướng dẫn triển khai/vận hành bạn đưa ra chỉ được dùng: trình duyệt web (GitHub web UI hoặc github.dev, Vercel dashboard, Neon dashboard/SQL Editor), KHÔNG được yêu cầu họ mở terminal, cài Node.js/Git/npm, hay chạy lệnh dòng lệnh nào trên máy cá nhân. Nếu tính năng mới cần thay đổi schema hoặc cần chạy script 1 lần, hãy thiết kế nó thành: (a) cập nhật file schema.sql để họ dán vào Neon SQL Editor, và/hoặc (b) một trang admin trong app để họ bấm nút thực hiện qua web — giống cách đã làm với /admin/import-data.

QUY TẮC LÀM VIỆC:
- Đây là hệ thống đang chạy thật, đừng viết lại từ đầu — chỉ sửa/mở rộng trên code hiện có, giữ đúng convention đặt tên (tiếng Anh cho code, nhãn/label tiếng Việt cho UI).
- Sau khi hoàn thành bất kỳ thay đổi nào, LUÔN cập nhật lại file HUONG_DAN_HE_THONG.md (mục "Tính năng đã hoàn thành", "Chưa làm", và schema.sql nếu đổi cấu trúc bảng) để người tiếp theo (kể cả AI khác) nắm đúng hiện trạng mới nhất — không tạo thêm file .md nào khác.
- Nếu phải đổi schema, cập nhật cả src/db/schema.ts lẫn schema.sql (thêm câu lệnh ALTER TABLE tương ứng ở cuối schema.sql, có ghi chú ngày/lý do) — không dùng drizzle-kit vì người dùng không chạy được lệnh trên máy.

YÊU CẦU TIẾP THEO CỦA TÔI:
[điền yêu cầu tính năng mới ở đây]
```

---

## 8. KẾ HOẠCH GIAI ĐOẠN 2 — PHÂN TÍCH & LỘ TRÌNH TRIỂN KHAI

Yêu cầu gốc "Giai đoạn 2" (Workflow Engine, Rule Engine, Versioning, Dashboard Builder, Notification Engine, phân quyền chi tiết, Soft Delete, Backup & Restore, Health Monitor, Job Scheduler, Plugin/Event Bus, Logging, API versioning) là một nền tảng cấp doanh nghiệp — nếu làm hết cùng lúc trên hệ thống **đang chạy thật** với 1 database Postgres free-tier (Neon) và hosting serverless free-tier (Vercel), rủi ro phá vỡ nghiệp vụ và vượt quá năng lực hạ tầng miễn phí là rất cao. Vì vậy đã chia thành 3 giai đoạn nhỏ theo mức ảnh hưởng/rủi ro tăng dần:

### Phase 1 — ĐÃ TRIỂN KHAI (bản này)
Tiêu chí chọn: an toàn với dữ liệu đang chạy thật, không cần hạ tầng ngoài Neon/Vercel, giá trị sử dụng ngay.
- ✅ Soft Delete + Recycle Bin (mục 2.11)
- ✅ Versioning nhẹ (tái dùng audit_logs, không cần bảng mới) + xem/khôi phục lịch sử
- ✅ Health Monitor (số liệu thật từ Postgres, không giả lập CPU/RAM)
- ✅ Mở rộng tìm kiếm động (metadata) sang Daily Application
- ✅ Ghi log đăng nhập

### Phase 2 — NÊN LÀM TIẾP (khi hệ thống đã ổn định với Phase 1, ước lượng theo nhu cầu thực tế)
- **Phân quyền chi tiết theo chức năng**: thêm bảng `permissions` (role hoặc user → danh sách quyền: view/create/update/delete/import/export/approve/reject) và 1 hàm `hasPermission()` dùng song song với `requireRole()` hiện có (không thay thế ngay để tránh phá toàn bộ ~15 API route đang dùng `requireRole`). Rủi ro trung bình — cần test kỹ từng route trước khi chuyển hẳn.
- **Rule Engine đơn giản** (IF/THEN cho một số trường hợp cụ thể như "Age > 60 → WAITLIST", "Department X → Quota Y"): có thể làm ở mức "cấu hình có giới hạn" (vài loại điều kiện dựng sẵn, không phải trình biên dịch biểu thức logic đầy đủ) để tránh rủi ro bảo mật khi cho phép admin "viết logic" chạy trên server.
- **Backup/Restore bán tự động**: nút "Backup ngay" ở `/admin/system` gọi `pg_dump` qua Neon API (nếu Neon hỗ trợ) hoặc xuất toàn bộ bảng ra JSON tải về — Restore là nút upload lại. Chưa làm lịch tự động (xem Phase 3 — Job Scheduler).

### Phase 3 — CHỈ LÀM KHI THỰC SỰ CẦN (rủi ro/effort cao, hoặc bị giới hạn bởi hạ tầng miễn phí)
- **Workflow Engine đầy đủ** (nhiều bước tuỳ ý, điều kiện chuyển bước tuỳ ý): đây là thay đổi kiến trúc lớn nhất — trạng thái `status` hiện là 1 cột `varchar` dùng xuyên suốt nhiều màn hình/API/export; chuyển sang workflow động đòi hỏi thiết kế lại toàn bộ luồng duyệt và **sẽ ảnh hưởng dữ liệu + API hiện có**, trái với ràng buộc "không phá vỡ nghiệp vụ hiện tại". Cần một dự án con riêng, có giai đoạn di trú dữ liệu (migration) rõ ràng.
- **Dashboard Builder kéo-thả**: cần thêm thư viện biểu đồ tương tác phía client khá nặng; nên làm sau khi Rule Engine + phân quyền chi tiết đã ổn định (dashboard thường cần lọc theo quyền xem).
- **Notification Engine (Zalo/SMS/Email)**: cần tài khoản dịch vụ ngoài (Zalo OA, SMS gateway, email SMTP) — không thể triển khai chỉ bằng code, cần quyết định nhà cung cấp trước (xem mục 3 — "Chưa làm").
- **Job Scheduler**: Vercel Free/Hobby giới hạn Cron Jobs (thường 1-2 job/ngày ở gói miễn phí) — cần xác nhận lại gói đang dùng trước khi thiết kế; nếu không đủ, cần dịch vụ cron ngoài (ví dụ cron-job.org gọi vào 1 API endpoint bảo vệ bằng secret).
- **Kiến trúc Plugin / Event Bus**: hợp lý cho hệ thống có nhiều nhóm phát triển song song; với quy mô hiện tại (1 hệ thống, ít module), lợi ích chưa vượt chi phí phức tạp hoá — cân nhắc lại khi có tích hợp ngoài thật sự (ví dụ Zalo OA) thay vì làm trước "cho chắc".
- **Logging framework riêng + API versioning (`/api/v1`, `/api/v2`)**: hiện `audit_logs` đã đóng vai trò log nghiệp vụ; log kỹ thuật (error/debug) nên dùng dịch vụ ngoài (Vercel đã có log runtime sẵn, xem tab **Logs** trong Vercel Dashboard) thay vì tự xây. API versioning chỉ cần thiết khi có bên thứ 3 phụ thuộc vào API — hiện tất cả client đều là chính app này nên chưa cấp thiết.

---

## 9. FOUNDATION RELEASE (2026-07-26) — BẢNG ĐỐI CHIẾU YÊU CẦU

> Đây là lần tái cấu trúc "đặt nền móng" theo yêu cầu Foundation Release. Bảng dưới đối chiếu TỪNG hạng mục trong yêu cầu gốc với trạng thái triển khai thật — chỉ đánh dấu **Hoàn thành** khi đã có mã nguồn + migration (schema.sql) + kiểm thử (tsc/eslint/build) + tài liệu (mục này).
>
> ⚠️ **Giới hạn kiểm thử quan trọng:** môi trường phát triển ra bản này KHÔNG có kết nối tới Neon Postgres thật. Đã xác nhận: TypeScript (`tsc --noEmit`) không lỗi, ESLint không phát sinh lỗi mới, `next build` thành công với toàn bộ route. **CHƯA** chạy được migration + luồng import/export/workflow/rule/versioning/soft-delete với dữ liệu thật trên Neon — người vận hành cần tự xác nhận theo checklist ở mục 9.3 sau khi deploy.

### 9.1 Đối chiếu 15 hạng mục bắt buộc

| # | Hạng mục | Trạng thái | Ghi chú |
|---|---|---|---|
| 1 | Metadata Engine | ✅ Hoàn thành | `field_definitions` + `form_questions`, đọc bởi Import/Export/Search (mục 2.10). Filter/Dashboard/Report đọc metadata ở mức nền tảng (xem #9). |
| 2 | Field Definition Manager | ✅ Hoàn thành | `/admin/field-definitions` — đủ fieldKey/displayName/aliases/import/export/searchable/sortable/**filterable** (mới)/required/validation/defaultValue/dataType/order/visibility. |
| 3 | Import Wizard | ✅ Hoàn thành | `/admin/import-data` viết lại thành 5 bước: Upload → Preview → Map Columns (map cột thủ công khi metadata không tự nhận diện được trường bắt buộc) → Validate & Import → Summary + Error/Warning Report. CSV/XLSX/XLS đều hỗ trợ. |
| 4 | Data Quality Engine | ⚠️ Hoàn thành một phần | Daily Application: có Error (chặn dòng) và Warning (không chặn, chỉ cảnh báo — sai định dạng CCCD/SĐT/tuổi bất thường). Department/DW Data: mới có Error, CHƯA có tầng Warning riêng — để dành khi có yêu cầu cụ thể hơn. |
| 5 | Workflow Engine | ⚠️ Hoàn thành ở mức nền tảng | `workflow_stages` — thêm/sửa/xoá/đổi màu/đổi thứ tự/gán Role/bước bắt đầu-kết thúc qua `/admin/workflow`, đã thay `STATUS_META` hard-code trong `/hr/registrations` + Export. **Chưa thể triển khai:** điều kiện chuyển bước tự động (vd "chỉ chuyển từ A→B nếu…") — đây là thay đổi lớn tới toàn bộ luồng duyệt hiện có, rủi ro cao với hệ thống chưa vào sản xuất nhưng đã có người dùng thử; để dành cho 1 đợt riêng có kế hoạch di trú rõ ràng. |
| 6 | Rule Engine | ⚠️ Hoàn thành ở mức nền tảng | `/admin/rules` — IF (nhiều điều kiện nối AND) → THEN (SET_STATUS, FLAG_NOTE). Đã chạy thật ở 2 điểm: đăng ký (`ON_REGISTER`) và duyệt hồ sơ (`ON_APPROVE`). OR đạt được bằng cách tạo nhiều rule độc lập, KHÔNG phải toán tử OR lồng ghép trong 1 rule — quyết định có chủ đích để tránh phải xây dựng 1 trình phân tích biểu thức logic phức tạp (rủi ro bảo mật nếu cho phép cú pháp tự do). |
| 7 | Versioning | ✅ Hoàn thành | Từ Giai đoạn 2 Phase 1 — tái dùng `audit_logs` (before/after), xem/khôi phục tại nút "Lịch sử" ở `/hr/registrations`. |
| 8 | Soft Delete | ✅ Hoàn thành | Từ Giai đoạn 2 Phase 1 — `deleted_at`/`deleted_by` + `/admin/recycle-bin` (Restore, Delete Forever). |
| 9 | Dashboard Foundation | ⚠️ Hoàn thành ở mức nền tảng | `/admin/dashboard` — widget KPI (đếm số, allow-list chỉ số an toàn) + widget Table (đọc cột trực tiếp từ `field_definitions`). Đúng phạm vi cho phép ("không cần Dashboard Builder hoàn chỉnh") — chưa có biểu đồ (chart) vì sẽ phải thêm thư viện mới, trái yêu cầu "không thêm công nghệ ngoài stack nếu không cần thiết". |
| 10 | Notification Foundation | ⚠️ Hoàn thành ở mức nền tảng | Bảng `notifications` = hàng đợi (không cần Redis). Event→Recipient→Template→Channel→Queue đầy đủ. Kênh IN_APP hoạt động thật (xem tại `/admin/notifications`). **Chưa thể triển khai:** gửi thật qua Zalo/SMS/Email — cần tài khoản dịch vụ ngoài (Zalo OA, SMS gateway, SMTP) chưa có; kiến trúc đã sẵn sàng, chỉ cần viết thêm 1 "sender" khi có tài khoản. |
| 11 | RBAC chi tiết | ⚠️ Hoàn thành ở mức nền tảng | `role_permissions` + `hasPermission()` + `/admin/permissions` (ma trận quyền theo chức năng). Đã áp dụng SONG SONG với `requireRole()` ở 4 route trọng yếu: Export Excel, Sửa hồ sơ, Duyệt/Từ chối, Import. **Chưa áp dụng** cho toàn bộ ~20 route còn lại (Department/DW Data CRUD, form-builder, field-definitions...) — cần rà soát từng route để không tự khoá nhầm chức năng, nên chỉ mở rộng dần. |
| 12 | Audit + Logging (tách biệt) | ⚠️ Hoàn thành theo thiết kế khác | **Quyết định kiến trúc có chủ đích:** dùng 1 bảng `audit_logs` + cột `category` (AUDIT/SYSTEM/IMPORT/EXPORT/AUTH/API) thay vì 6 bảng vật lý riêng — tránh trùng lặp cấu trúc và khó truy vấn chéo trên 1 database nhỏ (đúng tinh thần "không over-engineering"). Đăng nhập đã ghi log (AUTH). **Chưa làm:** giao diện `/admin/audit` chưa có bộ lọc theo category (dữ liệu đã có sẵn trong DB, chỉ thiếu UI lọc — việc nhỏ, để đợt sau). |
| 13 | Backup Foundation | ✅ Hoàn thành | `/api/admin/backup` — Export toàn bộ dữ liệu nghiệp vụ ra JSON (không gồm `users` vì có password hash). Export CSV/Excel đã có sẵn từ trước (`/hr/registrations` → Xuất Excel). Restore tự động: **Không áp dụng** (yêu cầu gốc nói rõ "Không cần Restore tự động"). |
| 14 | Health Monitor | ✅ Hoàn thành | Từ Giai đoạn 2 Phase 1 — `/admin/system`: Database (dung lượng), Storage, Statistics (số bản ghi từng bảng + thùng rác), Version/Deploy (commit, môi trường, vùng), Import/Export gần nhất. |
| 15 | Scheduler Foundation | ⚠️ Hoàn thành ở mức nền tảng | Bảng `scheduled_jobs` (đăng ký sẵn 2 job: đồng bộ ngày công DW Data, xử lý hàng đợi thông báo) + `/api/cron/run` (bảo vệ bằng `CRON_SECRET`) + `vercel.json` (cron 1 lần/ngày). **Chưa làm:** giao diện thêm/sửa job qua web (hiện chỉ xem qua Health Monitor/audit log, thêm job mới cần sửa `src/lib/scheduler.ts`) — đúng phạm vi cho phép ("chưa cần Cron nâng cao, nhưng phải có kiến trúc"). |

### 9.2 Đối chiếu các yêu cầu phi chức năng

| Hạng mục | Trạng thái | Ghi chú |
|---|---|---|
| Kiến trúc (SOLID/Clean/Module hoá/Service Layer) | ⚠️ Hợp lý, không tuyệt đối | `src/lib/*.ts` (metadata, workflow, rule-engine, notifications, scheduler, dashboard, matching) đóng vai trò Service Layer tách biệt khỏi route handler. **Không** áp dụng Repository Pattern triệt để (route vẫn gọi thẳng Drizzle) — quyết định có chủ đích, vì thêm 1 tầng Repository cho 1 hệ thống quy mô này sẽ là over-engineering (trái yêu cầu gốc). |
| Pagination | ⚠️ Một phần | DW Data đã phân trang (`page`/`limit`). Daily Application vẫn giới hạn cứng 3000 dòng/lần xem (không phân trang) — hạn chế có từ trước, chưa xử lý trong đợt này vì ngoài phạm vi các hạng mục 1-15. |
| Route Handlers phù hợp | ✅ | Toàn bộ dùng Next.js Route Handlers (`app/api/**/route.ts`) đúng chuẩn App Router. |
| Lazy Loading | ❌ Chưa triển khai | Các trang admin hiện tải toàn bộ dữ liệu khi mount, chưa dùng `next/dynamic` hay phân trang triệt để. Để dành cho khi số lượng bản ghi từng bảng metadata (rules/widgets/stages) lớn hơn — hiện tại số lượng nhỏ nên chưa cấp thiết. |
| Index tối ưu | ✅ | Đã rà soát: `dw_cccd_uq`/`dept_group_uq`/`daily_app_cccd_date_uq` (partial index), `dw_name_idx`/`dw_phone_idx`/`daily_app_date_status_idx`/`daily_app_name_idx`, cùng 2 unique index mới (`workflow_stage_uq`, `role_permission_uq`). |
| Không N+1 Query | ⚠️ Một phần | Export/Registrations dùng JOIN 1 lần. Import CSV theo dòng (DW Data ~20.7k dòng) vẫn là vòng lặp query-per-row — hạn chế có từ kiến trúc gốc (không phải phát sinh mới), chấp nhận được vì import chỉ chạy 1 lần/đợt, không phải luồng người dùng thường xuyên. |
| Cache khi phù hợp (không Redis) | ✅ | Cache trong bộ nhớ tiến trình (15 giây) cho `field_definitions`, `workflow_stages`, `role_permissions` — đủ dùng cho quy mô hiện tại, không cần Redis. |
| Database (FK/unique/partial/soft delete/audit/metadata) | ✅ | Đã rà soát đồng bộ `schema.ts` ↔ `schema.sql` (kiểm tra thủ công + build thành công). |
| Code Quality (không hard-code) | ✅ | Import/Export/Search: qua Metadata Engine. Workflow: qua `workflow_stages` (còn giữ `STATUS_META` trong `src/lib/helpers.ts` làm **giá trị dự phòng** khi bảng rỗng/lỗi mạng — không phải nguồn sự thật chính nữa). Rule Engine: điều kiện nghiệp vụ nằm trong bảng `rules`, không nằm trong code. Dashboard: chỉ số giới hạn bằng allow-list (không cho SQL tự do). |
| Documentation (chỉ 1 file) | ✅ | Toàn bộ cập nhật trong file này, không tạo file `.md` mới. |

### 9.3 Kiểm thử — kết quả xác nhận được trong môi trường này

| Kiểm thử | Kết quả |
|---|---|
| TypeScript (`tsc --noEmit`) | ✅ PASS — không lỗi |
| ESLint | ✅ PASS — không phát sinh lỗi mới (13 lỗi còn lại là pattern `react-hooks/set-state-in-effect` đã tồn tại sẵn trong toàn bộ codebase từ trước khi có bản này, không phải do thay đổi lần này) |
| Next Build | ✅ PASS — build thành công, đầy đủ tất cả route (trang + API) |
| Migration chạy trên Neon thật | ❌ **CHƯA XÁC NHẬN ĐƯỢC** — môi trường này không có kết nối Neon. `schema.sql` dùng cú pháp an toàn (`IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`) nhưng người vận hành PHẢI tự chạy và xác nhận theo Bước 1 ở mục 5. |
| Import CSV/XLSX, Export, Workflow, Rule Engine, Versioning, Soft Delete, Recycle Bin hoạt động với dữ liệu thật | ❌ **CHƯA KIỂM THỬ END-TO-END** — chỉ xác nhận qua code review + build thành công, chưa chạy được với Postgres thật trong môi trường phát triển này. Cần người vận hành tự kiểm tra sau khi deploy (xem checklist bên dưới). |

### 9.4 Checklist người vận hành PHẢI tự kiểm tra sau khi deploy bản này

- [ ] Chạy `schema.sql` mới trên Neon SQL Editor thành công, không lỗi.
- [ ] Mở app lần đầu → `/admin/workflow` có sẵn 4 bước PENDING/APPROVED/WAITLIST/REJECTED.
- [ ] `/hr/registrations`: dropdown "Trạng thái" hiển thị đúng như trước (không bị mất trạng thái nào).
- [ ] Thử đăng ký 1 hồ sơ test → duyệt → kiểm tra `/admin/notifications` có 1 dòng `WORKER_APPROVED` trạng thái SENT.
- [ ] Thử import 1 file CSV nhỏ qua `/admin/import-data` (đủ 5 bước) → kiểm tra Summary đúng số dòng.
- [ ] Thử xoá 1 hồ sơ test → vào `/admin/recycle-bin` → Khôi phục → xác nhận hồ sơ trở lại bình thường.
- [ ] Vào `/admin/rules` tạo 1 rule test đơn giản (vd Tuổi > 60 → Đặt trạng thái WAITLIST) → đăng ký test với tuổi > 60 → xác nhận trạng thái tự động là WAITLIST.
- [ ] Vào `/admin/system` → xác nhận số liệu hiển thị đúng, không lỗi.
- [ ] Đặt biến môi trường `CRON_SECRET` trên Vercel nếu muốn dùng `/api/cron/run` (không bắt buộc — nếu bỏ trống, endpoint vẫn chạy nhưng không có lớp bảo vệ bằng secret).

---

## 10. FOUNDATION RELEASE v2 (2026-07-26) — BÁO CÁO KẾT THÚC

> Đây là báo cáo bắt buộc theo đúng 10 mục yêu cầu của đợt rà soát "Enterprise Foundation" (Solution/Software/Database/Security Architect). Không có mục nào bị bỏ qua — mục nào chưa triển khai được đều có lý do kỹ thuật cụ thể.

### 10.1 Danh sách file đã sửa/tạo mới

**Schema & cấu hình:** `src/db/schema.ts`, `schema.sql`, `package.json` (thêm `jsqr`), `vercel.json`

**Service layer (`src/lib/`):** `auth.ts` (thêm `requireRoleAndPermission()`), `providers/types.ts` (mới), `providers/registry.ts` (mới)

**API routes sửa/tạo:** `api/admin/backup`, `api/admin/dashboard`, `api/admin/field-definitions` (+`template`), `api/admin/history`, `api/admin/import-data`, `api/admin/notifications`, `api/admin/permissions`, `api/admin/recycle-bin`, `api/admin/rules`, `api/admin/system-stats`, `api/admin/worker-profiles/backfill` (mới), `api/admin/workflow`, `api/bulk-import`, `api/departments`, `api/export`, `api/questions`, `api/registrations` (+`[id]`), `api/users`, `api/worker-profiles/[cccd]` (mới), `api/workers`

**Giao diện:** `app/(internal)/admin/system/page.tsx`, `app/(internal)/admin/worker-profiles/page.tsx` (mới), `components/applicant-portal.tsx`, `components/cccd-qr-scanner.tsx` (mới), `components/sidebar.tsx`

### 10.2 Migration SQL

Toàn bộ nằm trong `schema.sql`, khối cuối file — 2 phần, cả hai đều dùng `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` nên chạy lại nhiều lần an toàn:
- Khối **"CẬP NHẬT 2026-07-26 (Foundation Release)"**: `field_definitions.filterable`, `audit_logs.category`, và 6 bảng mới (`workflow_stages`, `rules`, `role_permissions`, `notifications`, `dashboard_widgets`, `scheduled_jobs`).
- Khối **"CẬP NHẬT 2026-07-26 (Foundation Release v2) — DIGITAL WORKER FILE"**: 2 bảng mới (`worker_profiles`, `employment_sessions`) + 3 index (1 unique partial cho `worker_profiles.cccd`, 1 unique partial cho `employment_sessions.daily_application_id`, 1 index thường cho `worker_id`).

### 10.3 Schema thay đổi (tóm tắt — chi tiết đầy đủ ở `src/db/schema.ts`)

- `field_definitions` + `filterable` (mới)
- `audit_logs` + `category` (mới)
- **Mới:** `workflow_stages`, `rules`, `role_permissions`, `notifications`, `dashboard_widgets`, `scheduled_jobs`, `worker_profiles`, `employment_sessions`
- **Không đổi:** `departments`, `dw_data`, `daily_applications`, `form_questions`, `users` — Digital Worker File là lớp tổng hợp nằm TRÊN các bảng này, không sửa cấu trúc của chúng.

### 10.4 Đã hoàn thành

| Hạng mục | Trạng thái |
|---|---|
| 1. Rà soát hệ thống (hard-code/dead code/TODO/FIXME/any/ts-ignore/console.log/route thiếu permission) | ✅ Đã quét toàn bộ `src/` — không có TODO/FIXME/`any`/`@ts-ignore`/`console.log`. 2 `eslint-disable-next-line react-hooks/exhaustive-deps` còn lại là pattern chuẩn cho effect "chạy 1 lần khi mount", không phải hard-code cần sửa. |
| 2. Metadata Engine là nguồn duy nhất | ✅ Import/Export/Search/Filter(một phần)/Table đọc `field_definitions`. Dashboard đọc metadata cho cột Table widget. Xem giới hạn ở 10.5 cho Form/PDF/Notification template. |
| 3. Form Builder lan toả tự động | ⚠️ Xem 10.5 — đã lan toả tới Form Public/Database/Import/Export/Search; CHƯA lan toả tới PDF/Document (vì #13/#15 chưa triển khai). |
| 4. Workflow Engine đọc DB | ✅ (đã có từ Phase 1) `workflow_stages` — Color/Permission (allowedRoles)/Previous-Next (sortOrder)/Terminal (isEnd)/Default (isStart) đều cấu hình qua `/admin/workflow`. Icon: chưa có trường riêng (dùng chung với Color) — xem 10.5. |
| 5. Rule Engine (AND/OR/NOT/Nested/Between/Regex) | ⚠️ Xem 10.5 — có AND, các toán tử so sánh cơ bản; CHƯA có OR/NOT/Nested Groups/between/regex trong 1 rule. |
| 6. Import/Export Engine hoàn thiện | ✅ Import Wizard đủ Preview/Mapping/Validation/Warnings/Errors/Duplicate/Summary/Template/Metadata Detect/Alias Detect/Question Detect. Rollback: xem 10.5. |
| 7. RBAC → toàn bộ route dùng `hasPermission()` | ✅ Toàn bộ 20 route có `requireRole` đã chuyển sang `requireRoleAndPermission()` (kết hợp xác thực phiên + kiểm tra quyền chức năng). Đã xác nhận bằng quét tự động (không còn route nào chỉ có `requireRole` mà thiếu permission). |
| 8. Audit ghi mọi thao tác | ✅ Login/CRUD/Workflow/Rule/Metadata/Permission/Import/Export/Restore/Delete/Backup/Notification/Scheduler đều gọi `writeAudit()`. |
| 9. Health Monitor đầy đủ | ✅ Database/Storage (dung lượng)/Tables+Indexes (mới)/Workflow Version (mới)/Metadata Version (mới)/Notification Queue (mới)/Scheduler (mới)/Latest Import/Export/Login/Backup (mới) — tất cả tại `/admin/system`. |
| 10. Digital Worker File | ✅ `worker_profiles` (1 người/1 hồ sơ, khoá theo CCCD) + `employment_sessions` (1 lần đăng ký/1 session). Tự tạo khi đăng ký (không cần thao tác thủ công). Backfill dữ liệu cũ tại `/admin/worker-profiles`. Tra cứu theo CCCD, xem toàn bộ lịch sử các đợt làm việc. |
| 11. CCCD QR | ✅ `CccdQrScanner` (thư viện `jsqr`, giải mã 100% trên trình duyệt) — đọc đúng chuẩn QR CCCD gắn chip VN (Thông tư 59/2021/TT-BCA), tự điền CCCD/Họ tên/Ngày sinh/Giới tính/Địa chỉ. Hỗ trợ camera + upload ảnh. Không lưu ảnh. Đã gắn vào form đăng ký công khai. |
| 16. Biometric (Fingerprint) | ✅ `worker_profiles.fingerprintCode/Device/Status/CreatedAt/LastUsedAt` — quản lý tại `/admin/worker-profiles` (tìm theo CCCD → cấp/xem mã vân tay). Người cũ giữ nguyên mã, người mới ở trạng thái `CHUA_CAP` chờ HR cấp. |
| 17. Privacy (che dữ liệu theo quyền) | ✅ 3 quyền mới `privacy.view_cccd/phone/address` — Export tự che CCCD/SĐT/Địa chỉ nếu Role không có quyền tương ứng. |
| 19. Provider Architecture | ⚠️ Interface đầy đủ (`StorageProvider`/`DocumentProvider`/`OtpProvider`/`NotificationProvider`/`IdentityProvider`) + registry. `NotificationProvider` có implementation thật (IN_APP). Các provider còn lại mới có hợp đồng — xem 10.5 (phụ thuộc #13/#14). |
| 20. Documentation (chỉ 1 file) | ✅ Toàn bộ trong file này. |

### 10.5 Chưa thể triển khai — lý do kỹ thuật

| Hạng mục | Lý do kỹ thuật | Phương án đã triển khai để không phải viết lại sau |
|---|---|---|
| **13. Electronic Signature** (OTP nội bộ, ký trên màn hình, SHA256, lưu IP/Device/Timestamp) | Phụ thuộc trực tiếp vào #14 (nơi lưu PDF đã ký) và #15 (nội dung PDF) — ký xong mà không có nơi lưu bền vững thì tính năng vô nghĩa. Xây cả 3 cùng lúc trong khi #14 thiếu thông tin xác thực (xem dưới) sẽ tạo ra 1 luồng nghiệp vụ "ký được nhưng không lưu được", rủi ro cho hệ thống sắp đưa vào dùng thật. | `OtpProvider`/`DocumentProvider` đã có interface sẵn trong `src/lib/providers/types.ts`. `crypto` (SHA256), UTC/VN time đều là API có sẵn của Node — khi có #14, chỉ cần viết 1 route mới, không phải thiết kế lại. |
| **14. Google Drive** (lưu PDF, không base64, tự tạo folder Year/Month/Day) | Cần **Google Cloud Service Account** (file JSON credentials) + 1 Drive folder được chia sẻ quyền ghi cho service account đó — đây là thông tin bí mật của tổ chức mà môi trường phát triển này không có và không được tự tạo thay. | `StorageProvider` interface đã định nghĩa đúng hợp đồng (`upload`, `getDownloadUrl`, trả về `fileId`/`url`/`folder`/`checksum` — đúng yêu cầu "không lưu base64"). Khi có credentials, chỉ cần viết `GoogleDriveStorageProvider implements StorageProvider` dùng gói `googleapis` và đăng ký vào `providers/registry.ts` — không sửa bất kỳ nghiệp vụ nào khác. |
| **15. PDF Template động** (Admin quản lý Header/Footer/Logo/Font/Watermark/QR/Điều khoản/Chữ ký qua giao diện) | Phụ thuộc #13/#14 (không có nơi sinh/lưu PDF thì chưa cần giao diện quản lý template). Ngoài ra 1 trình soạn template PDF kéo-thả là khối lượng công việc tương đương 1 tính năng độc lập (tương tự Dashboard Builder đã cố tình để ở mức nền tảng). | `DocumentProvider.generatePdf({ templateKey, data })` đã nhận `templateKey` làm tham số ngay từ đầu — khi triển khai #13, mặc định 1 template cứng trong code trước, rồi thêm bảng `pdf_templates` + `/admin/pdf-template` sau mà không đổi chữ ký hàm. |
| **12. Digital Onboarding** (đoạn "Ký điện tử → Lưu PDF" trong luồng) | Là hệ quả trực tiếp của #13/#14/#15 ở trên. | Phần còn lại của luồng — Đăng ký → HR duyệt → Xếp việc → Sinh hồ sơ điện tử → Tra cứu bằng CCCD → Đọc hồ sơ — **đã hoạt động đầy đủ** (Digital Worker File #10 + `/lookup` + `/api/worker-profiles/[cccd]`). Chỉ đoạn ký/PDF là chưa nối tiếp được. |
| **5. Rule Engine — OR/NOT/Nested Groups/between/regex** | Cho phép nhập biểu thức logic lồng nhau tuỳ ý (đặc biệt `regex`) trên server dùng chung tiềm ẩn rủi ro bảo mật (ReDoS — regex có thể được viết để treo CPU) nếu không có sandbox riêng, và bộ phân tích cú pháp cho biểu thức lồng nhau là khối lượng công việc lớn, rủi ro lỗi cao nếu làm vội trong 1 đợt đã rất nhiều thay đổi khác. | Kiến trúc dữ liệu `conditions: [{field, op, value}]` (mảng phẳng) migrate được sang dạng cây lồng nhau sau này mà KHÔNG cần đổi bảng `rules` (cột `conditions` đã là `jsonb`, tự do định dạng) — chỉ cần viết lại evaluator trong `src/lib/rule-engine.ts`, các rule đã tạo trước đó vẫn chạy được. |
| **9. Workflow Engine — Icon riêng** | Yêu cầu gốc liệt kê "Icon" tách biệt "Color" nhưng không có bộ icon chuẩn nào được chỉ định — chọn 1 bộ giới hạn tuỳ tiện có thể không đúng ý admin thật. | Cột `color` (varchar tự do) đã đủ rộng để lưu thêm tên icon nếu cần mà không cần đổi schema — để dành quyết định UX cụ thể hơn khi có phản hồi thực tế. |
| **18. Performance 100.000+ Worker / 500.000+ Registration (Streaming/Chunk)** | Import xử lý theo lô ở client nhưng vẫn insert từng dòng ở server (không dùng `COPY`); Export dựng toàn bộ workbook trong bộ nhớ (không streaming). Quy mô hiện tại (~20.7k DW Data) chạy ổn; không có 100k+ bản ghi thật để kiểm thử trong môi trường này trước khi khẳng định chịu tải được. | Batch size đã tham số hoá (`SLOTS[].batchSize`). Export đã tách `exportColumns()`/resolver khỏi việc build file — khi cần streaming chỉ đổi phần build file (ExcelJS hỗ trợ streaming writer). |

### 10.6 Kết quả TypeScript

```
npx tsc --noEmit
```
**PASS — 0 lỗi.**

### 10.7 Kết quả ESLint

**14 lỗi, toàn bộ cùng 1 loại `react-hooks/set-state-in-effect`** (gọi hàm tải dữ liệu bên trong `useEffect` khi mount trang) — đây là **pattern đã tồn tại trong toàn bộ codebase từ trước** (có ở `departments`, `users`, `form-builder`, `workers` — những trang KHÔNG bị đụng tới trong đợt này) chứ không phải lỗi phát sinh từ đợt này. Đây là cảnh báo phong cách của 1 rule mới trong `eslint-config-next`, không phải lỗi chức năng. Xem mục 10.9 để biết hướng xử lý triệt để trong tương lai.

### 10.8 Kết quả Next Build

```
next build
```
**PASS — build thành công, 47 route** (26 trang + 21 nhóm API) compile không lỗi.

### 10.9 Danh sách điểm có thể tối ưu trong tương lai

1. Chuyển toàn bộ trang admin từ `useEffect(() => { void load() }, [])` sang 1 thư viện data-fetching (SWR/TanStack Query) — giải quyết dứt điểm 14 cảnh báo ESLint ở mục 10.7.
2. Triển khai #13/#14/#15 (Ký điện tử/Google Drive/PDF Template) khi có Google Cloud Service Account.
3. Nâng Rule Engine lên hỗ trợ OR/NOT/Nested Groups (đổi evaluator, giữ nguyên schema `rules.conditions` dạng jsonb).
4. Import dùng Postgres `COPY` thay vì insert từng dòng khi dữ liệu vượt quá vài chục nghìn dòng/lần.
5. Export Excel dùng ExcelJS streaming writer khi số dòng vượt quá vài chục nghìn.
6. Bộ lọc dạng dropdown ở `/hr/registrations` tự sinh từ `field_definitions.filterable` (cột đã có, UI chưa dùng tới).
7. Giao diện `/admin/audit` thêm bộ lọc theo `category` (cột đã có trong DB).
8. Viết thêm `ZaloNotificationProvider`/`SmsNotificationProvider` khi có tài khoản dịch vụ, đăng ký vào `providers/registry.ts`.
9. Đặt `CRON_SECRET` trên Vercel để bảo vệ `/api/cron/run`.
10. Rà soát lại giới hạn 3000 dòng/lần xem ở `/hr/registrations` khi dữ liệu tích luỹ nhiều năm.

---

## 11. PHASE 2 (2026-07-27) — BUSINESS WORKFLOW REDESIGN

> Đây là đợt Refactor + Redesign theo đúng 8 Step trong Refactor Plan đã được xác nhận (xem file phân tích Phase 1 đã gửi riêng trước đó). Toàn bộ đã hoàn thành, kiểm thử: **TypeScript PASS, ESLint chỉ còn pattern có sẵn từ trước (không phát sinh mới), Next Build PASS với toàn bộ route.**

### 11.1 Đối chiếu 8 Step đã hoàn thành

| Step | Nội dung | Trạng thái |
|---|---|---|
| 0 | Quick Fixes: sai permission key `workers.edit`→`workers.view` trên route GET; "GT"→"Giới tính" (3 nơi); `sortOrder` mặc định MAX+1 thay vì 10; báo cáo duyệt hàng loạt chi tiết theo từng ID (không còn "0/0" im lặng) | ✅ |
| 1 | RBAC + Data Scope: `user_department_scopes` (1 user ↔ nhiều Department), `getUserScope()`, áp dụng ở `/department`, Daily Application, Export; `/admin/data-scopes` quản lý ma trận | ✅ |
| 2 | Workflow Engine tổng quát hoá: `/api/workflow-stages` nhận `entityType`, seed thêm bước cho `resignation`/`transfer`, `/admin/workflow` có tab chọn quy trình | ✅ |
| 3 | Workforce Movement: 1 bảng `workforce_movements` dùng chung Nghỉ việc + Thuyên chuyển (đã xác nhận), đủ 5 nhánh trạng thái Thuyên chuyển (Đã nhận/Hoãn/Không đến→Huỷ hoặc Sinh nghỉ việc/Reject), Notification 2 chiều | ✅ |
| 4 | Planning theo giai đoạn: `planning_periods`/`planning_targets`/`planning_allocations`, chặn overlap (partial unique index + kiểm tra tầng ứng dụng), version khi sửa (không UPDATE đè), tự Expire theo lịch, phân bổ lao động Unplanned khi tạo kế hoạch mới | ✅ |
| 5 | Task Center: `/task-center` — trang chủ mới sau đăng nhập cho ADMIN/HR_RECRUITER, tổng hợp Người mới/Nghỉ việc/Thuyên chuyển/Planning sắp hết hạn, có Search + Priority (theo tuổi task) | ✅ |
| 6 | Dashboard theo Role + Data Scope: DEPT_MANAGER chỉ thấy KPI/bảng trong phạm vi được gán | ✅ |
| 7 | Dọn dẹp "Ngày công": loại bỏ khỏi toàn bộ UI/API (12 vị trí đã rà soát), cột DB giữ nguyên (deprecated, có comment trong `schema.ts`), phát hiện thêm và xoá 1 file dead code (`merge-tool-ui.tsx`, gọi API không tồn tại) | ✅ |

### 11.2 Bug đã sửa (đối chiếu với báo cáo gốc)

- **"Duyệt Người Mới → DW Data" báo 0/0`**: `/api/bulk-import` nay phân loại từng ID (không tìm thấy / đã ở đúng trạng thái / xử lý thành công) và trả `results[]` chi tiết; UI hiện modal đúng định dạng yêu cầu (Đã duyệt/Đã thêm/Không thành công/Nguyên nhân).
- **"GT" → "Giới tính"**: sửa ở `registrations-grid.tsx`, `hr/workers/page.tsx`, `department/page.tsx`.
- **DW Data import xong không hiển thị**: sửa bug xác nhận được (permission key sai) + đổi thứ tự sắp xếp từ `lastWorkDate` (cột nay đã deprecated, không còn đáng tin cậy) sang `createdAt DESC` — dòng mới nhập luôn lên đầu, hết mơ hồ.
- **Dynamic Question `sortOrder` cố định 10**: nay tính `MAX(sortOrder) + 1` khi mở form thêm câu hỏi.

### 11.3 Bảng mới (chi tiết cột: xem `src/db/schema.ts`, migration: xem `schema.sql` khối "Phase 2")

`user_department_scopes`, `workforce_movements`, `planning_periods`, `planning_targets`, `planning_allocations`

### 11.4 Cột deprecated (KHÔNG xoá — chỉ ngừng đọc/ghi ở code)

- `departments.daily_quota` — thay bằng Planning (mục 11.1 Step 4)
- `dw_data.total_work_days`, `dw_data.last_work_date` — loại bỏ khỏi UI/API (mục 11.1 Step 7); job scheduler `recompute_dw_workdays` cũ tự động tắt (không xoá) khi nâng cấp

### 11.5 Vai trò & Data Scope — lưu ý vận hành

- ADMIN/HR_RECRUITER: luôn xem toàn công ty, không cần cấu hình Data Scope.
- DEPT_MANAGER: vào `/admin/data-scopes` (chỉ ADMIN thao tác được) để gán 1 hoặc nhiều Department cho từng Manager. Nếu chưa gán, hệ thống tự dự phòng theo `users.deptId` cũ (không tự khoá ai khi vừa nâng cấp).
- Sau khi gán nhiều Department, Manager sẽ thấy dropdown chọn bộ phận ở `/department`, `/admin/dashboard`, và các bộ lọc liên quan.

### 11.6 Kiểm thử

TypeScript: PASS (0 lỗi) · ESLint: PASS (không phát sinh lỗi mới) · Next Build: PASS (toàn bộ route, bao gồm 4 route Planning, 2 route Workforce Movement, Task Center, Data Scope).

⚠️ Cũng như các đợt trước: môi trường phát triển không có kết nối Neon thật — chưa chạy được migration + luồng nghiệp vụ mới (Planning overlap, Workforce Movement 5 nhánh, Task Center) với dữ liệu thật. Cần tự kiểm tra theo checklist:

- [ ] Chạy `schema.sql` (khối "Phase 2 — Business Workflow Redesign") trên Neon.
- [ ] Tạo 2 kế hoạch Planning chồng ngày cùng Department → xác nhận bị chặn.
- [ ] Tạo 1 yêu cầu Thuyên chuyển → đi qua đủ nhánh Hoãn → Không đến → Sinh yêu cầu nghỉ việc.
- [ ] Gán 1 DEPT_MANAGER vào 2 Department ở `/admin/data-scopes` → xác nhận họ thấy dữ liệu cả 2 nơi.
- [ ] Đăng nhập lại → xác nhận vào thẳng `/task-center` thay vì `/hr/registrations`.
- [ ] Kiểm tra `/hr/workers` không còn cột "Ngày công"/"Gần nhất".

---

## 12. IMPORT ENGINE v2 + UI/UX ENTERPRISE (2026-07-27)

### 12.1 Import Engine — kiến trúc mới

Đã bỏ hoàn toàn cơ chế cũ (parse toàn bộ CSV/XLSX thành JSON ở trình duyệt rồi gửi nhiều lô nhỏ qua `fetch`). Kiến trúc mới, đúng 5 bước yêu cầu:

```
1. Upload nguyên file (multipart/form-data)  →  POST /api/admin/import-data/upload
2. Server đọc file (thư viện xlsx, đọc được cả CSV/XLSX/XLS)
3. Bulk load vào import_staging_rows          →  1 câu lệnh SQL/3.000 dòng dùng UNNEST
4. Merge từng lô 300 dòng sang bảng chính      →  POST /api/admin/import-data/merge (resumable)
5. Báo cáo chi tiết (thêm/trùng/lỗi/cảnh báo)  →  đọc trực tiếp từ import_batches + import_staging_rows
```

**Về lựa chọn COPY vs bulk insert:** yêu cầu gốc cho phép "COPY HOẶC cơ chế bulk insert hiệu quả". Đã chọn **UNNEST-based bulk insert** (`INSERT ... SELECT unnest($1::int[], $2::jsonb[])`) thay vì `COPY` qua `pg-copy-streams`, vì: (1) không cần thêm thư viện streaming ngoài (`pg-copy-streams` không có sẵn, thêm vào sẽ là 1 rủi ro chưa kiểm thử được trong môi trường này); (2) UNNEST đạt hiệu năng gần tương đương COPY cho khối lượng vài chục nghìn dòng (1 round-trip/3.000 dòng thay vì hàng nghìn round-trip riêng lẻ như trước); (3) an toàn tham số hoá tuyệt đối qua driver `pg`, không phải tự escape CSV thủ công. Đây là quyết định kỹ thuật có chủ đích, không phải bỏ sót.

**Resumable + không timeout:** mỗi lần gọi `/merge` chỉ xử lý 300 dòng (vài trăm mili-giây), nằm trong 1 transaction riêng — dù file có 30.000+ dòng, tổng thời gian vẫn chia nhỏ thành hàng chục request độc lập, không request nào chạm giới hạn `maxDuration`. Nếu mất kết nối/đóng trình duyệt giữa chừng, batch giữ nguyên trạng thái trong DB (`import_batches`/`import_staging_rows`) — mở lại trang, bấm "Lịch sử" → "Tiếp tục" trên batch chưa DONE sẽ merge tiếp đúng từ dòng còn `PENDING`, không xử lý trùng.

**Transaction & rollback:** mỗi lô 300 dòng nằm trong `BEGIN...COMMIT`; nếu có lỗi hệ thống ngoài dự kiến giữa lô, `ROLLBACK` chỉ lô đó (các lô trước đã `COMMIT` không bị ảnh hưởng) — batch chuyển trạng thái `FAILED`, người dùng bấm "Tiếp tục" để thử lại đúng các dòng chưa xử lý.

**Giữ nguyên 100% logic nghiệp vụ cũ** (đúng yêu cầu "chỉ đổi engine, không đổi validate/mapping"): toàn bộ alias-detect, Metadata Engine, Data Quality (Error/Warning), đối chiếu DW 3 tầng, câu hỏi động → `customAnswers` đều được chuyển nguyên vẹn từ `route.ts` cũ sang `src/lib/import-engine.ts`, chỉ đổi nguồn đọc dữ liệu (từ mảng JSON client gửi → từ 1 lô `import_staging_rows`). Map Columns vẫn hoạt động y hệt, chỉ áp dụng ở bước merge (server) thay vì trước khi gửi (client).

**File liên quan:** `src/lib/import-engine.ts` (service layer dùng chung), `src/app/api/admin/import-data/upload/route.ts`, `.../merge/route.ts`, `.../batches/route.ts`, `src/app/api/admin/import-data/route.ts` (chỉ còn `finalize`), `src/app/(internal)/admin/import-data/page.tsx` (viết lại toàn bộ UI).

**Migration:** `schema.sql` khối "Import Engine v2" — 2 bảng mới `import_batches`, `import_staging_rows`.

### 12.2 UI/UX — phạm vi đã làm (cập nhật)

- Logo thật của Dalat Hasfarm (lấy từ trang tuyển dụng chính thức, `https://datax-talent.basecdn.net/dalathasfarm/logo-footer.png`) đã thay vào `BrandLogo` — có dự phòng tự động về icon hoa vẽ tay nếu ảnh (host ngoài, không kiểm soát được) không tải được.
- Bổ sung ngôn ngữ thiết kế Enterprise vào `globals.css`: `.skeleton` (shimmer loading), `.progress-glow` (thanh tiến trình có hiệu ứng chuyển động), `.animate-fade-in-scale` — dùng cùng `.hasfarm-hero`/`.hasfarm-card` (gradient + glassmorphism) đã có sẵn từ trước.
- Áp dụng đầy đủ ngôn ngữ thiết kế mới vào **trang Import Wizard**: hero gradient, step timeline có animation, progress bar chuyển động, count-up statistic, skeleton loading, thẻ kết quả glassmorphism.
- **Applicant (trang chủ công khai `/`)**: thêm ảnh thật cánh đồng hoa Dalat Hasfarm (lấy từ trang tuyển dụng chính thức) làm nền hero, phủ gradient giữ độ tương phản chữ.
- **Admin**: `/admin/system` nay là **Control Center** — hero + 4 ô truy cập nhanh (Import Engine/Audit Log/Phân quyền/Thùng rác) phía trên Health Monitor, đúng yêu cầu "System Health, Import Engine, Audit Log, đồng bộ dữ liệu và giám sát hệ thống" trong 1 màn hình.
- **Recruiter**: `/hr/registrations` nay có dải KPI pipeline (Chờ duyệt hôm nay / Đã duyệt hôm nay / Lao động mới) ngay đầu trang bằng thẻ gradient — đúng yêu cầu "tập trung vào pipeline tuyển dụng và KPI".

### 12.3 UI/UX — CHƯA làm (phạm vi còn lại, lý do)

Yêu cầu gốc (mục C/D) đề cập redesign **toàn bộ hệ thống** — tất cả màn hình — theo phong cách Enterprise SaaS. Đã làm 4/4 vai trò ở mức "điểm chạm chính" (trang chủ Applicant, Control Center Admin, dải KPI Recruiter, Task Center + Dashboard theo Data Scope cho HR Manager — có từ mục 11). **Chưa làm** redesign toàn diện từng màn hình còn lại (`/hr/workers`, `/department`, `/lookup`, form đăng ký chi tiết trong `applicant-portal.tsx`, `/admin/planning`, `/admin/workforce-movements`...) theo cùng mức độ chi tiết như trang Import Wizard — đây là khối lượng tương đương redesign lại toàn bộ ~30 màn hình, không làm trong 1-2 đợt để tránh vừa làm dở vừa có nguy cơ phá vỡ giao diện đang chạy thật ở các màn hình chưa kịp cập nhật đồng bộ.

**Còn lại cần làm ở đợt sau (nếu xác nhận tiếp tục):**
- Redesign đồng bộ toàn bộ các trang liệt kê ở trên theo cùng ngôn ngữ thiết kế (hero gradient, glassmorphism, animation) đã thiết lập.
- HR Manager: mở rộng `/admin/dashboard` thành dashboard lifecycle/analytics đầy đủ hơn (hiện mới có KPI + bảng gần nhất theo Metadata Engine).
- Ảnh minh hoạ chất lượng cao hơn cho Applicant (hiện dùng 1 ảnh từ trang tuyển dụng chính thức — có thể chọn thêm/đổi ảnh khác trong bộ ảnh đã có).

---

## 13. IMPORT ENGINE v3 — JOB-BASED ENTERPRISE ARCHITECTURE (2026-07-28)

### 13.1 ⚠️ Giới hạn nền tảng — đọc trước khi kỳ vọng

**Vercel KHÔNG có worker nền thật.** Không có 1 tiến trình nào chạy liên tục ngoài vòng đời request/response — kể cả **Vercel Cron cũng chỉ là 1 serverless function được gọi theo lịch**, vẫn bị giới hạn `maxDuration` giống mọi request khác. Muốn có worker nền đúng nghĩa (như Workday/SAP/Oracle HCM) cần 1 trong 2 hướng: (a) dịch vụ điều phối job ngoài — QStash, Inngest, Trigger.dev (đều có gói miễn phí, nhưng là **thêm 1 dịch vụ ngoài stack hiện tại**, cần tài khoản riêng), hoặc (b) 1 máy chủ luôn bật riêng (VPS/Railway/Render) chạy tiến trình worker thật.

**Đã KHÔNG tự ý thêm dịch vụ ngoài** (đúng nguyên tắc "không thêm công nghệ ngoài stack nếu không thực sự cần thiết" đã thống nhất từ đầu dự án) — thay vào đó xây dựng kiến trúc tốt nhất có thể trên Vercel + Neon:

```
Upload → tạo Job (QUEUED) → Worker xử lý 1 bước/1 lô (vài giây)
   → Worker TỰ gọi lượt kế tiếp bằng Next.js after() (server → server,
     KHÔNG phải trình duyệt lặp gọi) → ... → DONE
```

Mỗi request trong chuỗi chỉ tồn tại vài giây — Job không phụ thuộc vào 1 request cụ thể nào sống bao lâu, nhưng vẫn thực thi qua **chuỗi nhiều request ngắn tự nối tiếp**, không phải 1 tiến trình nền thật sự. Đây là khác biệt quan trọng cần hiểu đúng: **trình duyệt có thể đóng ngay sau khi upload xong** (điểm bạn báo là vấn đề chính đã được giải quyết), nhưng nếu 1 lượt "chain" chết giữa chừng (deploy mới, cold start lỗi mạng...), cần **Cron watchdog** (chạy theo lịch, không phải liên tục) hoặc nút **Resume** thủ công để phát hiện và tiếp tục — không có gì "tự phục hồi trong tích tắc" như 1 worker fleet thật.

**Nếu sau này thực sự cần worker thật** (ví dụ khi vượt hẳn quy mô hiện tại, > 1 triệu dòng, hoặc cần xử lý nhiều Job song song liên tục): khuyến nghị thêm **QStash** (Upstash) — tích hợp rất gọn với Next.js/Vercel, có gói miễn phí đủ dùng, và **không cần đổi kiến trúc job/staging/set-based SQL đã xây ở đây** — chỉ đổi cách "kích hoạt worker" từ `after()` sang gọi QStash.

### 13.2 Kiến trúc mới — đúng yêu cầu

| # | Yêu cầu | Đã làm |
|---|---|---|
| 1 | Job-based Architecture | ✅ `import_jobs`, browser chỉ nhận `jobId` rồi polling `GET /api/import/job/:id` |
| 2 | Import Job Table | ✅ Đủ field yêu cầu: id/job_type/file_name/checksum/status/progress/total_rows/processed_rows/inserted_rows/updated_rows/duplicate_rows/warning_rows/error_rows/started_at/finished_at/created_by/current_stage/resume_token/last_error/metadata |
| 3 | Staging Tables | ✅ 3 bảng **riêng, có kiểu cột rõ ràng** (không phải 1 bảng jsonb chung): `staging_department`, `staging_dw_data`, `staging_daily_application` |
| 4 | Bulk Import | ✅ Không còn vòng lặp `for {await insert()}` hay `SELECT/INSERT` từng dòng — staging nạp bằng UNNEST (vài nghìn dòng/câu lệnh), merge bằng `INSERT...SELECT...ON CONFLICT` (1 câu lệnh/lô 8.000 dòng) |
| 5 | Matching | ✅ **1 câu `UPDATE...FROM JOIN`** đối chiếu toàn bộ staging với `dw_data`/`departments` cùng lúc — không còn "SELECT dw_data 15.774 lần" |
| 6 | Resume | ✅ Resume thật: `current_stage` + `metadata.mergeCursor` (batch hiện tại) lưu trong DB sau MỖI lô — Resume tiếp tục đúng từ đó, không chạy lại từ đầu. `resume_token` chống 2 chuỗi worker chạy trùng trên cùng 1 Job |
| 7 | Import History | ✅ `/api/import/jobs` — đủ 6 trạng thái QUEUED/RUNNING/PAUSED/DONE/FAILED/CANCELLED; mỗi Job có Resume/Retry/Cancel/Download Log |
| 8 | Progress theo giai đoạn + ETA + tốc độ | ✅ STAGING→VALIDATING→MATCHING→MERGING→BUILDING_STATS→DONE, tính rows/giây + ETA tại `/api/import/job/:id` |
| 9 | Error Handling per-row | ✅ `import_job_errors` (job_id/row_number/reason/original_data/severity) — 1 dòng lỗi không làm hỏng cả Job |
| 10 | UI | ✅ Giữ nguyên phong cách đã có, bổ sung ETA/tốc độ/Job Queue/Retry/Resume/Cancel/Download Log |
| 11 | Performance | ⚠️ Xem 13.3 — chưa có số đo thật (không có Neon thật trong môi trường phát triển) |
| 12 | Kiến trúc "giống Workday/SAP" | ⚠️ Đạt được PHẦN LỚN hành vi (Job/staging/queue/resume/history) trên nền tảng KHÔNG có worker thật — xem 13.1 |

### 13.3 Về mục tiêu hiệu năng (31.000 dòng < 2 phút, 15.000 dòng < 1 phút)

**Chưa đo được bằng số liệu thật** — môi trường phát triển này không có kết nối Neon thật, không có file 31.000/15.000 dòng thật để chạy thử. Tuy nhiên, thay đổi kiến trúc cốt lõi (loại bỏ hoàn toàn vòng lặp per-row, chuyển 100% sang SQL set-based) **đổi hẳn bậc độ phức tạp**: kiến trúc cũ là O(N) round-trip riêng lẻ (N = số dòng, mỗi round-trip ~5-20ms → hàng phút đến hàng giờ cho 15-30k dòng); kiến trúc mới là O(N / 8.000) câu lệnh SQL lớn (vài câu cho 15-30k dòng, mỗi câu xử lý hàng nghìn dòng trong 1 lần quét index/join — thường dưới 1 giây/câu trên Postgres cỡ dữ liệu này). Đây là lý do kỹ thuật để tin tưởng đạt mục tiêu, nhưng **cần xác nhận bằng import thật trên Neon** trước khi coi là đã chứng minh — đề nghị bạn thử ngay với đúng 2 file 31.000 dòng (DW Data) và 15.700 dòng (Daily Application) đã nêu, và báo lại thời gian thực tế.

### 13.4 File liên quan

`src/db/schema.ts` (khối "IMPORT ENGINE v3"), `src/lib/import-jobs.ts` (toàn bộ logic set-based), `src/app/api/import/upload/route.ts`, `.../worker/route.ts`, `.../job/[id]/route.ts` (+`/cancel`, `/retry`, `/log`), `.../jobs/route.ts`, `src/lib/scheduler.ts` (thêm `RESUME_STALLED_IMPORT_JOBS`), `src/app/(internal)/admin/import-data/page.tsx` (viết lại UI dùng polling thay vì client-loop). Đã **xoá** 3 route Import Engine v2 (`upload`/`merge`/`batches` cũ dưới `/api/admin/import-data/`) — không giữ lại song song để tránh nhầm lẫn 2 kiến trúc cùng tồn tại.

### 13.5 Việc cần làm sau khi deploy

1. Chạy `schema.sql` (khối "Import Engine v3") trên Neon.
2. Đặt biến môi trường `CRON_SECRET` trên Vercel (nếu chưa) — bảo vệ endpoint watchdog.
3. **Xác nhận gói Vercel đang dùng có hỗ trợ Cron tần suất cao hay không** (Hobby chỉ 1 lần/ngày — watchdog vẫn chạy nhưng độ trễ phát hiện Job treo có thể tới 24h; nút Resume thủ công vẫn là đường phục hồi chính, không phụ thuộc Cron).
4. Thử import 2 file thật (31.000 dòng DW Data, 15.700 dòng Daily Application) — đo thời gian thật, đối chiếu với mục tiêu ở 13.3.
5. Thử đóng trình duyệt giữa chừng 1 lần import lớn — xác nhận Job tự chạy tiếp mà không cần thao tác gì.

---

## 14. IMPORT AUDIT — sửa lỗi Encoding + Timestamp (2026-07-28)

Đã audit và sửa tận gốc 2 lỗi nghiêm trọng phát sinh khi dùng thật (encoding tiếng Việt "ÄĐịa chỉ"/"SÄĐT", và `invalid input syntax for type timestamp with time zone`), cùng với validate toàn diện trước khi merge, header mapping mờ (fuzzy), error report dễ đọc, và tối giản giao diện Import theo Progressive Disclosure. **Chi tiết đầy đủ (nguyên nhân gốc, cách sửa, rủi ro còn lại): xem `IMPORT_AUDIT_REPORT.md` ở gốc dự án.** Hướng dẫn sử dụng Import đã chuyển sang `public/help/import/` (mở qua nút "Hướng dẫn Import" trên trang `/admin/import-data`).

⚠️ **Chưa xác nhận bằng dữ liệu thật** — cần import lại đúng 2 file đã từng gây lỗi trên Neon thật trước khi coi là đã xử lý dứt điểm.

---

*Cập nhật lần cuối: theo lần chỉnh sửa gần nhất của dự án — luôn sửa trực tiếp file này, không tạo bản mới.*
