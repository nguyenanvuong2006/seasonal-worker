import test from "node:test";
import assert from "node:assert/strict";
import {
  canImportToDw,
  isAlreadyImportedToDw,
  decideDwImportAction,
  hasDailyCode,
  isEligibleForFingerprintQueue,
  isEligibleForMealExport,
  maskCccd,
  maskPhone,
  maskAddress,
} from "./daily-intake-workflow.ts";

/* ------------------------------------------------------------
   CASE 2 — Recruiter nhập DW dù HR Support CHƯA merge (PASS, không phụ thuộc merge)
   ------------------------------------------------------------ */
test("canImportToDw: chỉ phụ thuộc status APPROVED — không hề nhắc tới Document Merge", () => {
  assert.deepEqual(canImportToDw({ status: "APPROVED", dwImportedAt: null }), { ok: true });
  assert.equal(canImportToDw({ status: "PENDING", dwImportedAt: null }).ok, false);
  assert.equal(canImportToDw({ status: "REJECTED", dwImportedAt: null }).ok, false);
});

/* ------------------------------------------------------------
   CASE 13 — Bấm "Nhập DW" 2 lần -> idempotent, không duplicate DW
   ------------------------------------------------------------ */
test("decideDwImportAction: đã dwImportedAt -> SKIP_ALREADY_IMPORTED (idempotent, không tạo trùng)", () => {
  const decision = decideDwImportAction({ status: "APPROVED", dwImportedAt: new Date(), dwId: "dw-1" });
  assert.equal(decision.action, "SKIP_ALREADY_IMPORTED");
});

test("decideDwImportAction: chưa xếp việc (chưa APPROVED) -> SKIP_NOT_APPROVED", () => {
  const decision = decideDwImportAction({ status: "PENDING", dwImportedAt: null, dwId: null });
  assert.equal(decision.action, "SKIP_NOT_APPROVED");
});

/* ------------------------------------------------------------
   CASE 14 — Người DW cũ quay lại đăng ký -> link đúng DW cũ, không tạo DW mới
   ------------------------------------------------------------ */
test("decideDwImportAction: đã có dwId (MATCHED từ đăng ký) -> LINK_EXISTING, KHÔNG insert mới", () => {
  const decision = decideDwImportAction({ status: "APPROVED", dwImportedAt: null, dwId: "dw-cu-123" });
  assert.deepEqual(decision, { action: "LINK_EXISTING", dwId: "dw-cu-123" });
});

test("decideDwImportAction: người hoàn toàn mới (chưa có dwId) -> INSERT_NEW", () => {
  const decision = decideDwImportAction({ status: "APPROVED", dwImportedAt: null, dwId: null });
  assert.deepEqual(decision, { action: "INSERT_NEW" });
});

test("isAlreadyImportedToDw", () => {
  assert.equal(isAlreadyImportedToDw({ dwImportedAt: null }), false);
  assert.equal(isAlreadyImportedToDw({ dwImportedAt: new Date() }), true);
  assert.equal(isAlreadyImportedToDw({ dwImportedAt: "2026-08-20T00:00:00Z" }), true);
});

/* ------------------------------------------------------------
   CASE 4 — Chưa có Mã công nhật -> KHÔNG xuất hiện trong hàng chờ Fingerprint
   ------------------------------------------------------------ */
test("isEligibleForFingerprintQueue: cần dwImportedAt + Mã số công nhật — thiếu 1 trong 2 -> false", () => {
  assert.equal(isEligibleForFingerprintQueue({ status: "APPROVED", dwImportedAt: new Date() }, { code: "DW-001" }), true);
  assert.equal(isEligibleForFingerprintQueue({ status: "APPROVED", dwImportedAt: null }, { code: "DW-001" }), false, "chưa nhập DW -> không vào hàng chờ");
  assert.equal(isEligibleForFingerprintQueue({ status: "APPROVED", dwImportedAt: new Date() }, { code: null }), false, "CASE 4: chưa có Mã công nhật -> không xuất hiện");
  assert.equal(isEligibleForFingerprintQueue({ status: "APPROVED", dwImportedAt: new Date() }, { code: "   " }), false, "mã rỗng/space -> vẫn coi là chưa có");
});

/* ------------------------------------------------------------
   CASE 3 — Có Mã công nhật, CHƯA có IT CODE -> Meal export vẫn PASS
   CASE 5 — Chưa có Mã công nhật -> KHÔNG xuất hiện trong Meal export
   ------------------------------------------------------------ */
test("isEligibleForMealExport: cần Mã số công nhật, KHÔNG cần IT CODE", () => {
  assert.equal(
    isEligibleForMealExport({ status: "APPROVED", dwImportedAt: new Date() }, { code: "DW-001" }),
    true,
    "CASE 3: có Mã công nhật, chưa có IT CODE vẫn PASS — hàm này không hề nhận tham số IT CODE",
  );
  assert.equal(
    isEligibleForMealExport({ status: "APPROVED", dwImportedAt: null }, { code: "DW-001" }),
    false,
  );
  assert.equal(
    isEligibleForMealExport({ status: "APPROVED", dwImportedAt: new Date() }, { code: null }),
    false,
    "CASE 5: chưa có Mã công nhật -> không đủ điều kiện báo cơm",
  );
});

test("hasDailyCode", () => {
  assert.equal(hasDailyCode({ code: "DW-001" }), true);
  assert.equal(hasDailyCode({ code: null }), false);
  assert.equal(hasDailyCode({ code: "" }), false);
  assert.equal(hasDailyCode({ code: "  " }), false);
});

/* ------------------------------------------------------------
   PII masking (mục IX, X)
   ------------------------------------------------------------ */
test("maskCccd / maskPhone / maskAddress: ẩn khi không có quyền privacy.view_*", () => {
  assert.equal(maskCccd("012345678901", false), "••••••••8901");
  assert.equal(maskCccd("012345678901", true), "012345678901");
  assert.equal(maskCccd(null, false), null);
  assert.equal(maskPhone("0912345678", false), "••••••••678");
  assert.equal(maskPhone("0912345678", true), "0912345678");
  assert.equal(maskAddress("123 Đường ABC", false), "••••••••");
  assert.equal(maskAddress("123 Đường ABC", true), "123 Đường ABC");
});
