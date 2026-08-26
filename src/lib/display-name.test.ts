import test from "node:test";
import assert from "node:assert/strict";
import { resolveDisplayName } from "./display-name.ts";

test("displayName được ưu tiên hơn fullName và username", () => {
  assert.equal(
    resolveDisplayName({ displayName: "C&B - Code DW", fullName: "Trần Mai", username: "tranmai" }),
    "C&B - Code DW",
  );
});

test("fullName là fallback khi không có displayName", () => {
  assert.equal(resolveDisplayName({ fullName: "An Vượng", username: "anvuong" }), "An Vượng");
});

test("username chỉ dùng khi không có tên tốt hơn", () => {
  assert.equal(resolveDisplayName({ username: "anvuong" }), "anvuong");
});

test("không có gì -> chuỗi rỗng", () => {
  assert.equal(resolveDisplayName({}), "");
  assert.equal(resolveDisplayName({ displayName: null, fullName: "", username: "  " }), "");
});

test("bảo toàn tiếng Việt Unicode", () => {
  assert.equal(resolveDisplayName({ fullName: "Nguyễn Thị Vượng" }), "Nguyễn Thị Vượng");
  assert.equal(resolveDisplayName({ fullName: "Đặng Văn Đà Lạt" }), "Đặng Văn Đà Lạt");
});

test("trim khoảng trắng thừa", () => {
  assert.equal(resolveDisplayName({ fullName: "  An Vượng  " }), "An Vượng");
});
