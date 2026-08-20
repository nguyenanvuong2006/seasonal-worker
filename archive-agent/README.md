# Archive Agent (Phase 12)

Tải PDF từ backend → lưu HDD/NAS → **SHA-256 verify** → **manifest.csv** → báo backend.

## Cài đặt (máy HR hoặc NAS)

Yêu cầu: **Node.js ≥ 18** (không cần npm install — không dependency).

```bash
cd archive-agent
cp .env.example .env   # điền ARCHIVE_API_URL + ARCHIVE_API_KEY + ARCHIVE_DESTINATION
node agent.mjs         # chạy thử (hoặc: npm start)
```

## Luồng

```
POST /api/archive/runs                 → mở phiên (runId)
GET  /api/archive/documents            → PDF chưa archive (ONLINE / ARCHIVE_VERIFY_FAILED), phân trang
GET  /api/archive/documents/[id]/download → tải PDF qua backend (KHÔNG lộ Drive token)
lưu D:\HR_DOCUMENT_ARCHIVE\YYYY\MM\DD\<filename>.pdf
SHA-256 local == doc.sha256 ?
  YES → POST /api/archive/verify { sha256Match: true }  → VERIFIED
  NO  → POST /api/archive/verify { sha256Match: false } → ARCHIVE_VERIFY_FAILED (GIỮ Drive, tải lại lần sau)
ghi manifest-YYYY-MM.csv (MONTHLY) / manifest-YYYY.csv (YEARLY)
POST /api/archive/runs/complete        → đóng phiên (COMPLETED/PARTIAL/FAILED)
```

## An toàn

- **Resume**: file đã `VERIFIED` bị skip — không tải lại.
- **Checksum lệch**: không xoá file Drive; đánh dấu `ARCHIVE_VERIFY_FAILED`, lần chạy sau tải lại.
- **Retention cleanup** (Phase 13) chỉ xoá Drive khi `retention_until <= now()` **VÀ** `archive_status = 'VERIFIED'`.
- Manifest **không chứa secrets**; không ghi CCCD.

## Lịch chạy

- Windows Task Scheduler / cron NAS: chạy daily hoặc weekly.
- `node agent.mjs --dry-run` để chạy thử không ghi gì.
