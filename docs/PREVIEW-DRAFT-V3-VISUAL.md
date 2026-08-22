# PREVIEW DRAFT v3 VISUAL — Operator Runbook (Production-safe)

Đường xem trước HTML **chỉ-đọc** cho DRAFT v3 qua **cùng renderer HTML_PDF** mà worker dùng.
Không publish, không tạo job/PDF/Drive/Docs, không ghi source, không đổi engine.

## Điều kiện

- Đăng nhập Production với tài khoản **ADMIN**.
- Mở DevTools Console trên bất kỳ trang nào của app (cùng origin).
- Cho phép popup cho trang web này (nếu `window.open` bị chặn, hãy bật popup rồi chạy lại).

## Script

```js
(async () => {
  const TEMPLATE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const RECORD_ID   = "4e05a1ff-775c-43d8-bd10-2ff3c383452e";
  const VERSION     = 3;

  const res = await fetch("/api/document-merge/preview", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      templateId: TEMPLATE_ID,
      applicationId: RECORD_ID,
      autoRoute: false,
      htmlVersion: VERSION, // nhánh chỉ-đọc HTML VERSION PREVIEW (ADMIN-only)
    }),
  });

  const data = await res.json();
  console.log("[VISUAL-PREVIEW] HTTP", res.status, data.code ?? "", data.error ?? "");

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} — ${data.code ?? ""} ${data.error ?? ""}`);
  }
  if (data.version !== VERSION) {
    throw new Error(`Sai version: mong đợi ${VERSION}, nhận ${data.version}`);
  }
  if ((data.unresolved || []).length > 0) {
    console.warn("[VISUAL-PREVIEW] unresolved placeholders:", data.unresolved);
  } else {
    console.log("[VISUAL-PREVIEW] unresolved placeholders = [] ✓");
  }

  console.log("[VISUAL-PREVIEW] SUMMARY", {
    mode: data.mode,
    version: data.version,
    versionStatus: data.versionStatus,
    templateId: data.templateId,
    recordId: data.recordId,
    fullName: data.fullName,
    valid: data.valid,
    pageCount: data.pageCount,
    renderer: data.renderer,
  });

  // Mở tab mới và inject HTML đã render (chỉ trong browser, không ghi server).
  const win = window.open("about:blank", "_blank");
  if (!win) {
    throw new Error("Popup bị chặn — hãy cho phép popup cho trang này rồi chạy lại script.");
  }
  win.document.open();
  win.document.write(data.renderedHtml);
  win.document.close();
  console.log("[VISUAL-PREVIEW] Tab đã mở — nhấn Ctrl+P để Print Preview A4.");
})();
```

## Kiểm chứng

- `HTTP 200`, `version: 3`, `unresolved: []`.
- Tab mới hiển thị tài liệu A4 với dữ liệu thật của hồ sơ.
- `Ctrl+P` → Print Preview; nếu muốn PDF chỉ để xem, dùng **Save as PDF** (không gửi lên server).

## KHÔNG được làm

- Không publish v3.
- Không gọi `/merge/execute`, `/jobs`, worker `/run`.
- Không gọi Google Docs / Drive / Cloud Run.
- Không thay đổi `DOCUMENT_MERGE_ENGINE`.

Nếu script báo lỗi: copy `data` (code/error/action) về báo cáo; không tự sửa mapping/source.
