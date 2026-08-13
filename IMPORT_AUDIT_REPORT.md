# IMPORT_AUDIT_REPORT.md

**Phạm vi:** `app/api/import/*`, `src/lib/import-jobs.ts`, `src/lib/metadata.ts`, `src/app/(internal)/admin/import-data/page.tsx`, database schema liên quan (`import_jobs`, `import_job_errors`, `staging_*`).

**Ngày:** 2026-07-28. **Trạng thái kiểm thử:** đã xác nhận `tsc --noEmit` (0 lỗi), ESLint (không phát sinh lỗi mới), `next build` (thành công, toàn bộ route) — **chưa** chạy được với dữ liệu thật trên Neon (môi trường phát triển không có kết nối Postgres thật), xem mục "Rủi ro còn lại".

---

## 1. Danh sách lỗi đã phát hiện

| # | Lỗi | Mức độ | Trạng thái |
|---|---|---|---|
| 1 | Encoding tiếng Việt bị lỗi khi import CSV (hiển thị "ÄĐịa chỉ", "SÄĐT", "Tuá»•i") | **Nghiêm trọng** | ✅ Đã sửa |
| 2 | `invalid input syntax for type timestamp with time zone` khi import Daily Application | **Nghiêm trọng** | ✅ Đã sửa |
| 3 | 1 dòng dữ liệu ngày sai định dạng có thể làm hỏng cả lô 8.000 dòng (INSERT set-based là all-or-nothing) | **Cao** | ✅ Đã sửa (validate trước khi merge) |
| 4 | Lỗi Postgres thô có thể lộ ra `job.lastError` nếu có lỗi hệ thống khác | **Trung bình** | ✅ Đã thêm lớp dịch lỗi |
| 5 | Header mapping không nhận diện được biến thể không dấu ("Ho va ten") | **Trung bình** | ✅ Đã sửa |
| 6 | Trùng lặp code (2 nơi implement logic dò cột giống hệt nhau) | **Thấp (code quality)** | ✅ Đã hợp nhất (DRY) |
| 7 | `warningRows` bị giai đoạn MATCHING ghi đè thay vì cộng dồn với VALIDATING | **Thấp** | ✅ Đã sửa |
| 8 | Biến `cols` không dùng đến (dead code) trong `runValidating()` | **Thấp** | ✅ Đã dọn |
| 9 | UI trang Import chứa nhiều đoạn mô tả/hướng dẫn dài | **UX** | ✅ Đã tối giản, chuyển sang `/help/import/` |

## 2. Nguyên nhân gốc (Root Cause)

### 2.1 Encoding tiếng Việt

**Nguyên nhân:** `src/app/api/import/upload/route.ts` (bản trước khi sửa) gọi `XLSX.read(buf, { type: "buffer" })` cho **mọi** loại file, kể cả `.csv`. SheetJS xử lý đúng `.xlsx`/`.xls` (định dạng nhị phân OOXML, tự mã hoá UTF-8 trong cấu trúc XML nội bộ) nhưng với `.csv` (văn bản thuần), thư viện không có cách nào biết bytes đó là UTF-8 nếu không được yêu cầu tường minh — bytes UTF-8 của ký tự tiếng Việt (2-3 byte/ký tự) bị đọc nhầm thành 1-byte/ký tự (Windows-1252/Latin-1), tạo ra đúng dạng lỗi quan sát được: "Đ" (UTF-8: `C4 90`) → "Ä" + ký tự lạ.

Đây **không phải lỗi hiển thị ở React UI** — dữ liệu đã sai ngay từ lúc đọc file, trước khi vào staging.

**Kiểm tra toàn pipeline CSV → Upload → Parser → Staging → Database → API → React UI:** xác nhận điểm lỗi duy nhất là bước **Parser**; các bước sau (staging bằng `unnest($n::text[])` tham số hoá, API trả JSON, React render chuỗi) đều trung lập với encoding — không tìm thấy bước encode/decode lại nào khác ở bất kỳ tầng nào.

### 2.2 Timestamp sai định dạng

**Nguyên nhân:** giai đoạn MERGING (SQL set-based, `src/lib/import-jobs.ts`) viết:
```sql
(reg_date_raw || 'T00:00:00+07:00')::timestamptz
```
Giả định `reg_date_raw` luôn ở dạng `yyyy-MM-dd`. Nhưng staging chỉ COPY nguyên giá trị gốc từ file (`13/08/2024 07:08:45` — đã có sẵn giờ) mà **chưa từng chuẩn hoá qua bất kỳ parser nào** trước khi tới bước này. Nối chuỗi trực tiếp tạo ra chính xác chuỗi lỗi trong báo cáo gốc: `13/08/2024 07:08:45T00:00:00+07:00`.

## 3. Cách sửa

### 3.1 Encoding — `src/lib/file-parser.ts` (mới)

Tách pipeline đọc file theo **đúng loại file**, không dùng chung 1 hàm cho mọi định dạng:
- `.csv` → decode buffer thành chuỗi UTF-8 tường minh (`buf.toString("utf-8")`, tự loại BOM) → `csv-parse` (thư viện CSV chuyên dụng, **đã có sẵn trong dependencies từ trước**, không thêm gói mới).
- `.xlsx`/`.xls` → vẫn `xlsx` (SheetJS) — đúng công cụ cho định dạng nhị phân.

Không sửa bằng cách "replace chuỗi" hay decode/encode nhiều lần — sửa đúng ở điểm đọc file, dữ liệu từ đó trở đi thống nhất UTF-8 tới tận React UI.

### 3.2 Timestamp — `src/lib/date-parser.ts` (mới)

1 parser duy nhất (`parseFlexibleDateTime`/`parseFlexibleDate`), hỗ trợ đủ 6 định dạng yêu cầu (dd/MM/yyyy, dd/MM/yyyy HH:mm, dd/MM/yyyy HH:mm:ss, yyyy-MM-dd, yyyy-MM-dd HH:mm:ss, ISO8601) bằng regex tường minh cho từng dạng (không dùng `new Date(str)` — mơ hồ giữa dd/MM và MM/dd). Trả về `null` nếu không parse được — **không bao giờ sinh chuỗi timestamp sai**.

Áp dụng **tại thời điểm staging** (không phải lúc merge): staging giữ **2 cột song song** cho mỗi trường ngày —
- `reg_date_raw` / `starting_date_raw`: giá trị GỐC, giữ nguyên để hiện đúng trong báo cáo lỗi.
- `reg_date_parsed` / `starting_date_parsed`: kết quả đã chuẩn hoá (ISO hợp lệ) hoặc NULL.

VALIDATING đánh dấu dòng invalid nếu `reg_date_parsed IS NULL` (bắt buộc) hoặc cảnh báo nếu `starting_date_parsed IS NULL` (không bắt buộc). MERGING **chỉ** cast từ cột `_parsed` — không còn nối chuỗi ở bất kỳ đâu.

### 3.3 Validate trước khi Merge — `src/lib/validators.ts` (mới)

Validate **trước** khi bất kỳ dòng nào chạm tới câu lệnh INSERT chính: CCCD (bắt buộc đúng 12 chữ số), SĐT Việt Nam, Số (tuổi), Ngày/Timestamp, Required. Dòng lỗi bị loại khỏi `WHERE valid = true` của câu MERGE — **1 dòng lỗi không còn làm hỏng cả lô 8.000 dòng**.

Pattern regex (CCCD/SĐT/Số) export dưới dạng **hằng số chuỗi** trong `validators.ts` và SQL tham chiếu lại đúng pattern đó (qua tham số hoá) — 1 nguồn sự thật dù chạy ở tầng TypeScript hay SQL.

### 3.4 Error Report — không lộ lỗi Postgres thô

Thêm `translateError()` (lớp phòng thủ thứ 2 — lớp thứ 1 là validate trước khi merge): dịch mã lỗi Postgres phổ biến (`22007`/`22008` ngày giờ, `22P02` sai kiểu, `23505` trùng khoá, `23503` khoá ngoại, `57014` timeout) sang tiếng Việt; lỗi không nhận diện được → thông báo chung chung.

Dữ liệu lỗi (`import_job_errors.reason`) ở dạng người đọc được ngay từ khi ghi — ví dụ: `Ngày đăng ký không đúng định dạng — giá trị: "13/08/2024 07:08:45"`.

### 3.5 Header Mapping — `normalizeHeaderFuzzy()` trong `src/lib/metadata.ts`

Lớp so khớp "mờ" làm fallback sau so khớp chính xác: bỏ dấu tiếng Việt (Unicode NFD), lowercase, bỏ khoảng trắng + ký tự đặc biệt. "Họ và tên" và "Ho va ten" đều chuẩn hoá về `hovaten`, khớp nhau.

## 4. Những phần đã refactor

- Xoá trùng lặp: `buildColumnPickers()` dùng lại `makeFieldPicker()` chung thay vì tự cài lại logic dò cột.
- `runValidating()`: thêm kiểm tra ngày dựa trên cột `_parsed`, thêm cảnh báo `starting_date`, sửa lỗi đếm `warningRows` bị ghi đè, dọn biến chết.
- `runMatching()`: dùng lại pattern từ `validators.ts`; khôi phục cảnh báo "tuổi bất thường".
- UI: bỏ mô tả/hướng dẫn dài, chỉ giữ label chức năng, thêm 1 nút "Hướng dẫn Import".
- Tài liệu: `public/help/import/{IMPORT_GUIDE,IMPORT_FAQ,IMPORT_TROUBLESHOOTING}.md`.
- **Business logic: không thay đổi** — toàn bộ quy tắc nghiệp vụ giữ nguyên như trước audit.

## 5. Rủi ro còn lại

| Rủi ro | Mức độ | Ghi chú |
|---|---|---|
| Chưa chạy thử với dữ liệu thật trên Neon | Cao | Cần import lại đúng file đã gây lỗi để xác nhận dứt điểm end-to-end. |
| `Promise.all` không giới hạn | Chưa rà soát ngoài phạm vi Import | Trong `import-jobs.ts`, các vòng lặp bulk-load đều `await` tuần tự — không có rủi ro này trong module Import. |
| Kích thước lô 8.000 dòng | Trung bình | Chưa đo thời gian thật; `STAGE_CHUNK` đã tham số hoá sẵn, đổi 1 chỗ nếu cần. |
| Index staging | Thấp | Đã có `(job_id, valid)`, `(job_id, cccd)` — đủ cho quy mô hiện tại. |
| Deadlock | Thấp | Mỗi lô là 1 câu SQL đơn — chưa kiểm thử tải đồng thời nhiều Job cùng loại. |
| `isValidEmail`/`isValidEnum`/`isValidBoolean` chưa được gọi ở đâu | Thấp | Hệ thống hiện không có trường Email/Boolean/Enum trong dữ liệu import — chuẩn bị sẵn cho tương lai theo đúng yêu cầu, không phải code chết vô nghĩa. |

## 6. Đề xuất tối ưu tiếp theo

1. **Ưu tiên cao nhất:** import lại đúng 2 file đã gây lỗi trên Neon thật để xác nhận dứt điểm.
2. Đo thời gian thực thi 1 lô MERGING 8.000 dòng trên dữ liệu thật, điều chỉnh `STAGE_CHUNK` nếu cần.
3. Khi có nhu cầu thật (Email/Boolean/Enum xuất hiện), áp dụng ngay `validators.ts` đã chuẩn bị sẵn.
4. Diễn tập 2 Job cùng loại chạy đồng thời — xác nhận không có race condition ở bước matching.
