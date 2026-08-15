# Document Merge — Cấu hình Google Docs/Drive trên Vercel

Tài liệu này dành cho production `seasonal-worker` trên Vercel. Merge Engine hiện hỗ trợ 3 cách lấy Google access token, ưu tiên theo thứ tự: access token truyền trực tiếp (debug), Service Account, hoặc OAuth Refresh Token.

## Khuyến nghị production: Service Account

Service Account phù hợp nhất cho Merge Engine chạy server-to-server và không phụ thuộc vào phiên đăng nhập Google của một cá nhân.

### 1. Tạo hoặc chọn Google Cloud project

Trong Google Cloud Console, chọn project dành cho ứng dụng Seasonal Internship.

### 2. Bật API

Bật tối thiểu:

- Google Docs API
- Google Drive API

Merge Engine cần Docs API để `batchUpdate` placeholder/page break và Drive API để đọc/copy template, tạo file và di chuyển file vào output folder.

### 3. Tạo Service Account

Vào `IAM & Admin → Service Accounts → Create service account`.

Sau khi tạo, mở Service Account → `Keys → Add key → Create new key → JSON`.

File JSON tải về chứa các giá trị quan trọng:

```json
{
  "client_email": "seasonal-merge@PROJECT_ID.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
}
```

Không commit file JSON hoặc private key vào GitHub.

### 4. Share Google Docs template và output folder

Google Cloud IAM role không tự động cấp quyền vào Google Workspace files. Bạn phải share trực tiếp tài liệu/folder với email Service Account.

Với mỗi Google Docs template:

1. Mở Google Docs.
2. Nhấn `Share`.
3. Thêm đúng email `client_email` của Service Account.
4. Cấp quyền **Editor** để hệ thống có thể copy và xử lý tài liệu.

Nếu dùng một Google Drive folder để chứa file merge:

1. Mở folder.
2. Share folder với cùng Service Account.
3. Cấp quyền **Editor**.
4. Copy Folder ID từ URL và nhập vào `Google Drive Output Folder ID` của Template trong Document Merge Center.

## 5. Biến Vercel cần nhập

Vào:

`Vercel → seasonal-worker → Settings → Environment Variables`

Tạo 2 biến sau cho **Production**:

### `GOOGLE_SERVICE_ACCOUNT_EMAIL`

Giá trị = `client_email` trong JSON.

Ví dụ:

```text
seasonal-merge@my-project.iam.gserviceaccount.com
```

### `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

Giá trị = toàn bộ `private_key`, gồm cả header/footer:

```text
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

Code đã tự xử lý trường hợp Vercel lưu newline dưới dạng `\n`.

### Không bật mock trên production

Đảm bảo:

```text
DOCUMENT_MERGE_USE_MOCK=false
```

Nếu biến này chưa có thì không bắt buộc phải thêm; nhưng tuyệt đối không đặt `true` trên Production.

### Không cần dùng `GOOGLE_ACCESS_TOKEN` trong production

`GOOGLE_ACCESS_TOKEN` chỉ phù hợp debug tạm thời vì token hết hạn nhanh. Nếu đang có token cũ trên Vercel, nên xoá sau khi Service Account hoạt động ổn định để tránh nhầm cấu hình.

## 6. OAuth Refresh Token — phương án thay thế

Chỉ dùng khi công ty muốn Merge Engine chạy dưới một tài khoản Google Workspace cụ thể thay vì Service Account.

Khi đó đặt đủ 3 biến:

```text
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
```

Không cần đặt Service Account variables nếu chọn OAuth mode.

## 7. Redeploy bắt buộc

Sau khi thêm/sửa Environment Variables, Vercel chỉ áp dụng chúng cho deployment mới.

Vào `Deployments → deployment production mới nhất → ... → Redeploy` hoặc tạo một deployment mới từ `main`.

Sau redeploy, mở:

`/admin/document-merge`

Chọn một ứng viên DW Mới và bấm Preview.

Kết quả mong đợi:

- Không còn `GOOGLE_AUTH_MISSING`.
- Nếu Service Account chưa được share Google Doc: UI sẽ báo lỗi quyền truy cập Google template.
- Nếu Template B đã active và mapping hợp lệ: Preview hiển thị nội dung merge thật.

## 8. Cấu hình Template đầu tiên

Template hiện tại dùng Google Doc ID:

```text
10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE
```

Trong `Quản lý Templates → Sửa`:

- Phân loại: **Tài liệu B — DW Mới / Hồ sơ đào tạo nghề**
- Trạng thái: **Hoạt động**
- Google Docs ID: giữ đúng ID trên
- Chế độ mặc định: `1 file gộp + Page Break` nếu dùng in hàng loạt
- Mapping: kiểm tra `Matched / Missing / Orphaned` trước khi merge

Nếu đang hiển thị `Mẫu chung`, auto-routing DW Mới sẽ không chọn nó làm Tài liệu B.

## 9. Checklist test production an toàn

Test đúng thứ tự:

1. Preview đúng **1 DW Mới**.
2. Kiểm tra họ tên, CCCD, ngày sinh, ngày nhận việc, bộ phận.
3. Kiểm tra checkbox là `☒ / ☐`, không phải `true / false`.
4. Tìm `<<` trong Preview để đảm bảo không còn placeholder chưa thay.
5. Merge đúng 1 người, chưa dispatch applicant.
6. Mở Google Docs output và kiểm tra format gốc không bị biến dạng.
7. Sau đó mới test `Đẩy tài liệu merge đến Người tìm việc`.
8. Kiểm tra `/lookup` thấy đúng tài liệu.
9. Test chữ ký điện tử.
10. Cuối cùng mới test batch merge nhiều người + Page Break.

## 10. Các biến Document Merge mà source hiện đọc

```text
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
GOOGLE_ACCESS_TOKEN
DOCUMENT_MERGE_USE_MOCK
```

Không tự đặt tên biến khác vì service `src/lib/document-merge/google-docs-service.ts` chỉ đọc các key trên.
