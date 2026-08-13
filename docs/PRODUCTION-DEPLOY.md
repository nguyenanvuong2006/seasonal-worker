# Triển khai và vận hành Production

Tài liệu này là runbook chuẩn để triển khai Seasonal Worker lên Vercel với PostgreSQL (khuyến nghị Neon), chạy migration an toàn, kiểm tra sau phát hành, sao lưu và khôi phục khi có sự cố.

## 1. Kiến trúc production

- **Ứng dụng:** Next.js App Router, triển khai trên Vercel.
- **Cơ sở dữ liệu:** PostgreSQL; kết nối qua `DATABASE_URL` và bắt buộc bật SSL trên môi trường production.
- **Xác thực:** session JWT ký bằng `AUTH_SECRET`; tài khoản quản trị đầu tiên chỉ được bootstrap khi bảng `users` còn rỗng.
- **Tác vụ nền:** Vercel Cron gọi `GET /api/cron/run` hằng ngày theo `vercel.json` và xác thực bằng `CRON_SECRET`.
- **Import:** file được đưa vào staging, kiểm tra dữ liệu rồi merge theo job. Không chỉnh sửa trực tiếp bảng staging trong lúc job đang chạy.

## 2. Điều kiện trước khi phát hành

### Công cụ

- Node.js theo phiên bản tương thích với Next.js trong `package.json`.
- npm và Git.
- `psql` hoặc Neon SQL Editor để chạy migration.
- Vercel CLI chỉ cần khi không triển khai qua GitHub.

### Kiểm tra mã nguồn

Từ thư mục gốc repository, chạy đầy đủ:

```bash
npm ci
npm run typecheck
npm run lint
node scripts/verify-redesign.mjs
npm run build
```

Không phát hành nếu bất kỳ lệnh nào thất bại. Không dùng `--force`, không bỏ qua lỗi TypeScript hoặc lint.

### Sao lưu bắt buộc

Trước mỗi migration:

1. Tạo snapshot/branch database trên Neon, hoặc chạy `pg_dump`:

   ```bash
   pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" > seasonal-worker-$(date +%Y%m%d-%H%M%S).dump
   ```

2. Kiểm tra file sao lưu có dung lượng hợp lý và lưu ở nơi được mã hóa, giới hạn quyền truy cập.
3. Ghi lại Git SHA đang chạy và thời điểm snapshot để có thể ghép đúng phiên bản ứng dụng với dữ liệu.

Không đưa dump, `.env`, token hoặc dữ liệu cá nhân vào Git.

## 3. Biến môi trường

Cấu hình trong **Vercel → Project → Settings → Environment Variables**, áp dụng tối thiểu cho Production:

| Biến | Bắt buộc | Yêu cầu |
|---|---:|---|
| `DATABASE_URL` | Có | PostgreSQL connection string; với Neon phải có `sslmode=require`. Dùng user ứng dụng có quyền tối thiểu cần thiết. |
| `AUTH_SECRET` | Có | Chuỗi ngẫu nhiên mạnh, khác hoàn toàn giữa Preview và Production. Có thể tạo bằng `openssl rand -base64 32`. |
| `CRON_SECRET` | Có | Token ngẫu nhiên riêng cho `/api/cron/run`; không dùng lại `AUTH_SECRET`. |
| `INITIAL_ADMIN_USERNAME` | Chỉ lần đầu | Tên đăng nhập quản trị khởi tạo khi bảng `users` rỗng. Xóa biến sau lần đăng nhập đầu tiên. |
| `INITIAL_ADMIN_PASSWORD` | Chỉ lần đầu | Mật khẩu mạnh cho quản trị khởi tạo. Xóa biến sau lần đăng nhập đầu tiên. |

Quy tắc vận hành:

- Không ghi giá trị bí mật vào log, issue, PR hoặc tài liệu.
- Khi xoay `AUTH_SECRET`, toàn bộ session hiện tại sẽ hết hiệu lực; thông báo trước cho người dùng.
- Khi xoay `CRON_SECRET`, cập nhật biến Vercel rồi kiểm tra cron trả về thành công.
- Không dùng biến Production cho Preview hoặc máy cá nhân.

## 4. Chạy schema và migration

### Database mới

Chạy `schema.sql` một lần trên database trống:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f schema.sql
```

`ON_ERROR_STOP=1` là bắt buộc để dừng ngay khi có lỗi thay vì để lại một lần chạy thành công giả.

### Database đang hoạt động

1. Tạo snapshot/backup.
2. Chạy migration mới theo thứ tự thời gian. Với thay đổi ngày 2026-08-13:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f migrations/2026-08-13-form-targeting-cccd.sql
   ```

3. Kiểm tra ba cột Form Builder:

   ```sql
   SELECT visible_to_applicants, target_audience, skip_for_returning, count(*)
   FROM form_questions
   GROUP BY 1, 2, 3;
   ```

4. Kiểm tra dữ liệu CCCD lịch sử:

   ```sql
   SELECT id, cccd FROM daily_applications WHERE cccd !~ '^[0-9]{12}$';
   SELECT id, cccd FROM dw_data WHERE cccd IS NULL OR cccd !~ '^[0-9]{12}$';
   SELECT id, cccd FROM worker_profiles WHERE cccd !~ '^[0-9]{12}$';
   ```

Migration dùng CHECK constraint `NOT VALID`: dữ liệu lịch sử chưa chuẩn hóa vẫn đọc được, nhưng INSERT/UPDATE mới sai định dạng sẽ bị chặn. Không tự động xóa hoặc tự suy đoán CCCD. HR phải đối chiếu nguồn chính thức, sửa từng hồ sơ và ghi nhận audit.

Khi cả ba truy vấn đều trả về 0 dòng, xác nhận constraint:

```sql
ALTER TABLE daily_applications VALIDATE CONSTRAINT daily_applications_cccd_exact_12_chk;
ALTER TABLE dw_data VALIDATE CONSTRAINT dw_data_cccd_exact_12_chk;
ALTER TABLE worker_profiles VALIDATE CONSTRAINT worker_profiles_cccd_exact_12_chk;
```

Migration đã được thiết kế idempotent, nhưng vẫn phải dừng và điều tra nếu `psql` báo lỗi. Không sửa tay schema Production để “chạy tiếp”.

## 5. Trình tự phát hành

Khuyến nghị phát hành qua GitHub và Vercel Git Integration:

1. Merge PR đã được review vào `main`.
2. Xác nhận Vercel nhận đúng commit SHA.
3. Chạy migration trước khi chuyển traffic sang deployment có code đọc cột mới.
4. Chờ Vercel build hoàn tất; kiểm tra build log không lộ biến môi trường hoặc dữ liệu cá nhân.
5. Promote deployment đã kiểm tra sang Production.
6. Thực hiện smoke test ở mục 6.
7. Ghi vào nhật ký phát hành: commit SHA, migration đã chạy, người thực hiện, thời gian và kết quả smoke test.

Nếu dùng Vercel CLI:

```bash
vercel pull --environment=production
vercel build --prod
vercel deploy --prebuilt --prod
```

Không truyền secret trực tiếp trên command line hoặc lưu `.vercel/.env.production.local` vào Git.

## 6. Smoke test sau triển khai

Thực hiện bằng dữ liệu kiểm thử đã được phê duyệt; không dùng CCCD thật trong ảnh chụp hoặc ticket.

1. Gọi `/api/health` và xác nhận HTTP 200, database kết nối được.
2. Mở trang công khai `/`:
   - CCCD thiếu, không đủ hoặc thừa chữ số phải bị từ chối.
   - CCCD đúng 12 chữ số đi được đến bước kiểm tra.
   - Người mới chỉ thấy câu hỏi `ALL` và `NEW_ONLY`.
   - Người quay lại chỉ thấy câu hỏi `ALL` và `RETURNING_ONLY`, trừ câu có `skipForReturning`.
   - Câu `visibleToApplicants=false` không được hiển thị và không bị API yêu cầu.
3. Mở `/lookup`; xác nhận cần đúng cả CCCD 12 chữ số và số điện thoại.
4. Đăng nhập Admin, mở Form Builder; tạo câu hỏi thử, đổi nhóm mục tiêu, tắt hiển thị công khai rồi xóa câu hỏi thử.
5. Import một file nhỏ:
   - dòng CCCD đúng 12 chữ số được xử lý;
   - dòng CCCD sai bị ghi `ERROR` và không vào bảng nghiệp vụ;
   - job hoàn tất, không bị treo ở `MERGING`.
6. Kiểm tra Audit Log có ghi nhận các thao tác quản trị.
7. Gọi cron bằng secret từ môi trường an toàn và xác nhận request không có token trả về log:

   ```bash
   curl --fail --silent --show-error \
     -H "Authorization: Bearer $CRON_SECRET" \
     https://<production-domain>/api/cron/run
   ```

## 7. Giám sát hằng ngày

- **Vercel:** tỷ lệ lỗi 5xx, thời gian phản hồi, function timeout và lỗi build.
- **PostgreSQL:** dung lượng, số connection, truy vấn chậm, lock và lỗi constraint.
- **Import jobs:** job `FAILED`, job không cập nhật lâu, số dòng `ERROR` tăng bất thường.
- **Cron:** lịch sử invocation và phản hồi 2xx.
- **Bảo mật:** đăng nhập thất bại tăng đột biến, thay đổi quyền, export dữ liệu và thao tác sửa CCCD.

Truy vấn kiểm tra job bị kẹt:

```sql
SELECT id, job_type, status, current_stage, processed_rows, total_rows, updated_at, last_error
FROM import_jobs
WHERE status IN ('QUEUED', 'RUNNING')
  AND updated_at < now() - interval '15 minutes'
ORDER BY updated_at;
```

Chỉ retry qua giao diện/API được thiết kế cho retry. Không đổi trạng thái job bằng SQL nếu chưa xác định nguyên nhân.

## 8. Rollback và khôi phục

### Rollback ứng dụng

1. Trong Vercel, chọn deployment ổn định gần nhất và **Promote to Production**.
2. Xác nhận domain đã trỏ về đúng deployment SHA.
3. Chạy lại smoke test về health, đăng nhập, form công khai và lookup.

### Rollback database

Các migration trong repository ưu tiên mở rộng schema và tương thích ngược. Không `DROP COLUMN` ngay khi rollback code. Với sự cố migration:

1. Dừng phát hành và hạn chế thao tác ghi nếu cần.
2. Thu thập log, tên constraint và câu SQL lỗi.
3. Nếu chưa có dữ liệu mới sau migration, có thể phục hồi snapshot/branch database đã tạo.
4. Nếu đã có dữ liệu mới, không restore đè ngay. Tạo database khôi phục riêng, so sánh và lập kế hoạch chuyển dữ liệu có kiểm soát.
5. Chỉ xóa constraint/cột sau khi có review và câu lệnh rollback đã thử trên bản sao.

Phục hồi dump sang database tạm để xác minh:

```bash
createdb seasonal_worker_restore_check
pg_restore --exit-on-error --no-owner --no-acl \
  --dbname=seasonal_worker_restore_check seasonal-worker-YYYYMMDD-HHMMSS.dump
```

Không coi rollback ứng dụng là rollback dữ liệu. Hai thao tác có phạm vi và rủi ro khác nhau.

## 9. Xử lý sự cố thường gặp

### Health check báo lỗi database

- Kiểm tra `DATABASE_URL`, SSL, trạng thái Neon và giới hạn connection.
- Không in toàn bộ connection string ra log.
- Thử kết nối bằng `psql "$DATABASE_URL"` từ môi trường quản trị được phép.

### Đăng nhập thất bại sau deploy đầu tiên

- Xác nhận cả hai biến `INITIAL_ADMIN_*` đã có trước request đầu tiên.
- Bootstrap chỉ chạy khi bảng `users` rỗng; không xóa người dùng để chạy lại.
- Sau khi vào được hệ thống, tạo tài khoản quản trị chính thức theo quy trình và xóa hai biến bootstrap.

### Cron trả 401

- Xác nhận `CRON_SECRET` có ở Production và header là `Authorization: Bearer <secret>`.
- Redeploy sau khi đổi biến môi trường nếu deployment chưa nhận phiên bản biến mới.

### Import có nhiều dòng lỗi CCCD

- Tải báo cáo lỗi của job và sửa file nguồn.
- CCCD phải là chuỗi đúng 12 chữ số; bảo toàn số 0 ở đầu bằng định dạng Text trong bảng tính.
- Không nới regex hoặc sửa constraint để nhập dữ liệu chưa xác minh.

## 10. Checklist đóng phát hành

- [ ] Backup/snapshot đã tạo và kiểm tra.
- [ ] `npm ci`, typecheck, lint, verify và build đều thành công.
- [ ] Biến Production đầy đủ; không lộ secret.
- [ ] Migration chạy với `ON_ERROR_STOP=1` và đã kiểm tra kết quả.
- [ ] Vercel đang chạy đúng commit SHA.
- [ ] Health check và smoke test đều đạt.
- [ ] Cron, import và audit hoạt động.
- [ ] Nhật ký phát hành đã ghi đầy đủ.
- [ ] Người trực vận hành biết deployment và snapshot dùng để rollback.
