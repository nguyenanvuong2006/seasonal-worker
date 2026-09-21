[← Mục lục](./README.md)

# 12. Xuất dữ liệu nghiệp vụ (Business Data Export)

**Ai dùng:** chỉ `ADMIN`. Vào **Control Center** (`/admin/system`) → mục **Dữ liệu nghiệp vụ**.

## 12.1 Xuất dữ liệu nghiệp vụ dùng để làm gì?

Nút **"Xuất dữ liệu nghiệp vụ (JSON)"** tải về dữ liệu của các bảng nghiệp vụ chính dưới dạng file JSON — phục vụ kiểm tra, tra cứu đối chiếu, phân tích offline hoặc cung cấp dữ liệu cho đội kỹ thuật phân tích sự cố.

> **Cảnh báo an toàn:**
> **Đây KHÔNG PHẢI là bản sao lưu toàn bộ cơ sở dữ liệu (Disaster Recovery Backup).**
> File xuất này chỉ chứa một số bảng nghiệp vụ được chọn, không thể dùng độc lập để khôi phục toàn vẹn hệ thống.

## 12.2 Phạm vi dữ liệu được xuất

Bao gồm 17 bảng nghiệp vụ chính:
- **Tổ chức & danh mục**: Department, Data Scope, Form Questions, Field Definitions, Workflow Stages, Rules, Phân quyền vai trò (Role Permissions).
- **Hồ sơ & vận hành**: Worker Profiles, Employment Sessions, Daily Applications, Master DW Data, Workforce Movements (điều chuyển / nghỉ việc).
- **Kế hoạch**: Planning Periods, Planning Targets, Planning Allocations.
- **Theo dõi**: Thông báo (Notifications), Nhật ký hệ thống gần nhất (Audit Logs — giới hạn tối đa 10.000 bản ghi mới nhất để đảm bảo an toàn bộ nhớ).

### Các dữ liệu KHÔNG nằm trong file xuất:
1. **Tài khoản người dùng (`users`)**: Không bao gồm tài khoản và mật khẩu mã hoá (password hash) nhằm bảo vệ an toàn danh tính và bảo mật hệ thống.
2. **Mẫu tài liệu & chứng từ điện tử**: Mẫu hợp đồng/cam kết (`merge_templates`, phiên bản, trường) và xác nhận ký điện tử của người lao động.
3. **Mã vận hành & Pool số**: Danh mục địa điểm mã DW, pool mã số (`dw_codes`), lịch sử cấp mã DW/IT.
4. **Cấu hình hệ thống & Schema**: Lịch trình tác vụ (`scheduled_jobs`), cài đặt giao diện/thương hiệu, lịch sử di chuyển schema (`schema_migrations`).

## 12.3 Không có tính năng Restore tự động từ file này

Hệ thống **không hỗ trợ và không có tính năng tự động khôi phục (Restore)** từ file JSON này. File JSON chỉ mang tính chất bản ghi dữ liệu nghiệp vụ offline (Business Data Export).

Đối với công tác phòng chống và phục hồi thảm hoạ thật sự (Disaster Recovery):
- Bắt buộc phải sử dụng các giải pháp sao lưu cấp cơ sở dữ liệu (database-level backup / point-in-time recovery / logical pg_dump).
- Đảm bảo đầy đủ toàn bộ schema, bảng dữ liệu, ràng buộc khoá ngoại (foreign keys), chuỗi số (sequences), và index.

## 12.4 Khi nào nên xuất dữ liệu nghiệp vụ?

- Định kỳ hàng tháng hoặc trước các đợt cập nhật dữ liệu lớn để lưu trữ đối chiếu ngoại tuyến.
- Khi cần đối chiếu số liệu tuyển dụng, phân bổ nhân sự, lịch sử điều chuyển trong mùa vụ.
- Khi cần phục vụ công tác thanh kiểm tra, audit hoạt động vận hành.

Tiếp theo: [13 — Tra cứu công khai](./13-public-lookup.md)

