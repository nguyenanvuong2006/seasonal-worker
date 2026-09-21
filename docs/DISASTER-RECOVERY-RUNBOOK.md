# Disaster Recovery (DR) Runbook

Tài liệu hướng dẫn quy trình sao lưu và phục hồi thảm hoạ cho hệ thống Seasonal Worker (`nguyenanvuong2006/seasonal-worker`).

---

## 1. Kiến trúc phân tầng Disaster Recovery (DR Architecture)

Hệ thống áp dụng mô hình bảo vệ dữ liệu 4 lớp độc lập:

| Tầng | Cơ chế | Phạm vi / Bản chất | Lưu trữ / Retention | Tình trạng hiện tại |
|---|---|---|---|---|
| **Layer 1** | **Neon PITR (Point-in-Time Recovery)** | Native database time-travel, khôi phục trạng thái DB đến bất kỳ thời điểm nào trong lịch sử | 6 giờ (theo gói Neon Free plan) | Đang hoạt động |
| **Layer 2A** | **Guarded Logical `pg_dump` Pipeline** | Workflow GitHub Actions thủ công (`workflow_dispatch`), xuất định dạng custom (`-Fc -Z9`), checksum SHA-256, sidecar manifest | GitHub Actions Artifacts (Retention: 7 ngày) | **Đã xây dựng (Phase 2A, Manual-only)** |
| **Layer 2B** | **Off-site Encrypted Backup Vault** | Sao lưu định kỳ chuyển vào kho lưu trữ ngoài độc lập (S3/GCS/R2 có mã hoá KMS) | Dài hạn (30–90 ngày) | *Dự kiến triển khai sau (Phase 2B)* |
| **Layer 3** | **Business Data Export** | Nút tải JSON 17 bảng nghiệp vụ từ Control Center (`/admin/system` -> `/api/admin/backup`) | Tải về máy quản trị viên | Đang hoạt động (Phase 1) |

> [!IMPORTANT]
> **Giới hạn thực tế hiện tại:**
> - Neon PITR chỉ lưu giữ lịch sử **6 giờ** (không tự động mở rộng nếu chưa nâng cấp gói).
> - Chưa cấu hình Neon Snapshots tự động hoặc scheduled snapshots.
> - Chưa cấu hình S3/GCS/R2 Object Storage.
> - **Chưa kích hoạt lịch chạy tự động hàng đêm (nightly cron)** cho Phase 2A để tránh vượt hạn mức compute Neon (~97.1%).

---

## 2. Phase 2A — Guarded Logical Backup Pipeline

Workflow: `.github/workflows/database-backup-production.yml`

### 2.1 Đặc tính vận hành
- **Trigger**: Hoàn toàn thủ công (`workflow_dispatch` ONLY). Không có lịch trình cron/schedule.
- **Môi trường**: GitHub Actions Environment `production`.
- **Concurrency**: Group `database-production-backup`, `cancel-in-progress: false` (ngăn xung đột khi sao lưu).
- **Lưu trữ kết quả**: GitHub Actions Artifact với thời hạn lưu trữ **7 ngày** (`retention-days: 7`).
- **Không phải kho lưu trữ vĩnh viễn**: Artifacts 7 ngày là lớp trung gian độc lập tạm thời (Phase 2A), không thay thế cho kho lưu trữ dài hạn ngoài site (Phase 2B).

### 2.2 Các chốt chặn an toàn (Safety Guardrails)
Trước khi bất kỳ kết nối cơ sở dữ liệu nào được thiết lập, workflow bắt buộc phải vượt qua toàn bộ các kiểm tra:
1. **Branch Guard**: Nhánh chạy bắt buộc phải là `refs/heads/main`.
2. **Confirmation Guard**: Quản trị viên phải nhập chính xác chuỗi:
   ```
   BACKUP_PRODUCTION_DATABASE
   ```
3. **Commit SHA Guard**:
   - `expected_source_commit_sha` bắt buộc phải là 40 ký tự hex thường.
   - Bắt buộc phải khớp 100% với commit `HEAD` vừa checkout trên `main`.
4. **Database Identity Guard**:
   - Bắt buộc có bí mật `PROD_DATABASE_URL` và biến `PRODUCTION_DATABASE_HOSTNAME`.
   - Hostname phân tích từ URL bắt buộc khớp tuyệt đối với `PRODUCTION_DATABASE_HOSTNAME`.
   - Nếu `STAGING_DATABASE_HOSTNAME` tồn tại, từ chối ngay lập tức nếu trùng hostname staging.
   - Không in connection string, mật khẩu hoặc thông tin nhạy cảm ra log.
5. **No Destructive/Restore Command**: Workflow tuyệt đối không chứa lệnh khôi phục hay can thiệp phá huỷ dữ liệu.

### 2.3 Quy cách bản sao lưu
- **Công cụ**: PostgreSQL 16 client (`pg_dump`, `pg_restore`).
- **Định dạng**: Custom PostgreSQL format (`--format=custom`, nén `--compress=9`, `--no-owner`, `--no-privileges`).
- **Tên file**: `seasonal-worker-prod-YYYYMMDDTHHMMSSZ.dump`
- **Xác thực cấu trúc**: Chạy `pg_restore --list` để kiểm tra tính toàn vẹn danh mục (TOC) trước khi đóng gói.
- **Sidecar Checksum**: Tạo file `.dump.sha256` chứa SHA-256 hash của file dump.
- **Sidecar Manifest**: Tạo `manifest.json` ghi nhận phiên bản, commit SHA, kích thước, SHA-256 hash, hostname máy chủ, và số lượng bảng/dòng TOC.

---

## 3. Quy trình thực hiện sao lưu thủ công (Manual Backup Execution)

Khi cần thực hiện sao lưu Production (ví dụ: trước đợt bảo trì lớn, sau khi kiểm tra hạn mức Neon cho phép):

1. Vào tab **Actions** trên GitHub repository.
2. Chọn workflow **"Database Backup — PRODUCTION"**.
3. Nhấn nút **Run workflow**:
   - Nhánh: `main`
   - `confirmation`: Nhập chính xác `BACKUP_PRODUCTION_DATABASE`
   - `expected_source_commit_sha`: Nhập commit SHA 40 ký tự của commit mới nhất trên `main`.
4. Kiểm tra log thực thi:
   - Các Guardrail A, B, C, D đều chuyển trạng thái `✅`.
   - Step `Execute Guarded Logical Backup (pg_dump)` hoàn thành.
   - Step `Structural verification of backup archive` hiển thị thống kê bảng/dòng hợp lệ.
   - Step `Upload backup artifact package` tải lên artifact với 3 file:
     - `seasonal-worker-prod-<timestamp>.dump`
     - `seasonal-worker-prod-<timestamp>.dump.sha256`
     - `manifest.json`
5. Tải artifact về lưu trữ nội bộ an toàn nếu cần lưu dài hơn 7 ngày.

---

## 4. Chính sách Khôi phục (Recovery Policy)

> [!CAUTION]
> **Hiện tại hệ thống KHÔNG CÓ endpoint web tự động restore.**
> Không tự ý chạy restore trực tiếp vào database Production mà không qua phê duyệt và kiểm tra đối chiếu.

1. **Khôi phục sự cố gần (< 6 giờ)**:
   - Sử dụng Neon Console -> nhánh `main` -> **Restore from history / PITR**.
   - Tạo nhánh mới tại thời điểm trước sự cố (ví dụ `restore-point-2026-xx-xx`).
   - Kiểm tra dữ liệu trên nhánh mới trước khi trỏ kết nối Production sang nhánh phục hồi.

2. **Khôi phục từ Logical Backup (Layer 2A)**:
   - Tải artifact `.dump`, `.sha256`, `manifest.json`.
   - Xác minh toàn vẹn SHA-256 bằng lệnh:
     ```bash
     sha256sum -c seasonal-worker-prod-*.dump.sha256
     ```
   - Chạy lệnh kiểm tra cấu trúc cục bộ:
     ```bash
     pg_restore --list seasonal-worker-prod-*.dump
     ```
   - Phục hồi vào cơ sở dữ liệu staging hoặc branch cô lập để kiểm thử trước khi quyết định can thiệp Production.

---

## 5. Lộ trình phát triển tiếp theo (Phase 2B & Beyond)

- [ ] **Phase 2B**: Thiết lập off-site encrypted vault tự động đẩy bản sao lưu lên bucket lưu trữ độc lập (AWS S3 / Cloudflare R2 / Google Cloud Storage) có vòng đời 30–90 ngày.
- [ ] **Automated Schedule**: Thiết lập lịch chạy định kỳ (nightly backup) sau khi hạn mức compute Neon tháng mới được làm mới hoặc chuyển sang gói hỗ trợ phù hợp.
- [ ] **Automated Restore Drill**: Định kỳ tự động test restore bản backup vào DB cô lập tạm thời để kiểm thử khả năng phục hồi hoàn chỉnh (Disaster Recovery Drill).
