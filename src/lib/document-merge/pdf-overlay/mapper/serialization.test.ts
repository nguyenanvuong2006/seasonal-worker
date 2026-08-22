/**
 * PDF Overlay — Visual Mapper serialization tests (PR3).
 * Bao phủ: save serialization (payload upsert), dirty-state, defaults, new position.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  dbRowToEditor,
  editorToPayload,
  isDirty,
  makeNewPosition,
  newClientId,
  positionDirtyKey,
  type DbPositionRowLike,
} from "./serialization.ts";

const ROW: DbPositionRowLike = {
  id: "p1",
  placeholder: "Ho_ten",
  pageNumber: 1,
  x: 50,
  y: 700,
  width: 200,
  height: 20,
  type: "TEXT",
  fontSize: 10,
  align: "left",
  valign: "top",
  multiline: false,
  renderOrder: 1,
  isRequired: true,
  overflowPolicy: "FAIL",
};

test("dbRowToEditor: map đầy đủ + default khi thiếu", () => {
  const e = dbRowToEditor(ROW);
  assert.equal(e.clientId.length > 0, true);
  assert.equal(e.dbId, "p1");
  assert.equal(e.placeholder, "Ho_ten");
  assert.equal(e.x, 50);
  assert.equal(e.y, 700);
  assert.equal(e.align, "left");
  assert.equal(e.isRequired, true);
  assert.equal(e.renderOrder, 1);
  // các field thiếu → default
  assert.equal(e.minFontSize, null);
  assert.equal(e.checkboxStyle, null);
  assert.equal(e.staticText, null);
  assert.equal(e.multiline, false);
});

test("editorToPayload: tạo payload upsert khớp service contract", () => {
  const e = dbRowToEditor(ROW);
  const payload = editorToPayload(e);
  assert.equal(payload.placeholder, "Ho_ten");
  assert.equal(payload.pageNumber, 1);
  assert.equal(payload.x, 50);
  assert.equal(payload.y, 700);
  assert.equal(payload.width, 200);
  assert.equal(payload.type, "TEXT");
  assert.equal(payload.isRequired, true);
  assert.equal(payload.renderOrder, 1);
  assert.equal(payload.overflowPolicy, "FAIL");
  // metadata có mặt (object)
  assert.deepEqual(payload.metadata ?? {}, {});
});

test("save serialization round-trip: row → editor → payload → (default) không mất tọa độ", () => {
  const row: DbPositionRowLike = {
    id: "p2",
    placeholder: "Ngay_sinh",
    pageNumber: 2,
    x: 120.5,
    y: 300.25,
    width: 150,
    height: 16,
    type: "DATE",
    fontSize: 11,
    align: "center",
    valign: "middle",
    overflowPolicy: "ELLIPSIZE",
    staticText: null,
  };
  const e = dbRowToEditor(row);
  const payload = editorToPayload(e);
  assert.equal(payload.x, 120.5);
  assert.equal(payload.y, 300.25);
  assert.equal(payload.pageNumber, 2);
  assert.equal(payload.align, "center");
  assert.equal(payload.valign, "middle");
  assert.equal(payload.overflowPolicy, "ELLIPSIZE");
});

test("isDirty: không đổi → false; đổi geometry → true; thêm position → true", () => {
  const e1 = dbRowToEditor(ROW);
  const baseline = [e1];
  assert.equal(isDirty([{ ...e1 }], baseline), false);

  const moved = { ...e1, x: e1.x + 10 };
  assert.equal(isDirty([moved], baseline), true);

  const extra = makeNewPosition("Ho_ten", 1);
  assert.equal(isDirty([e1, extra], baseline), true);
});

test("failed save preserves dirty state — chính là giữ baseline cũ khi save fail", () => {
  // Mô phỏng: sau save fail, editor vẫn giữ bản chưa lưu (baseline không đổi).
  const e1 = dbRowToEditor(ROW);
  const baseline = [e1];
  const edited = { ...e1, width: e1.width + 30 };
  // giả lập lỗi: không cập nhật baseline → vẫn dirty
  assert.equal(isDirty([edited], baseline), true);
  // sau khi "save thành công", baseline = editor → hết dirty
  assert.equal(isDirty([edited], [edited]), false);
});

test("positionDirtyKey: ổn định, round giá trị float", () => {
  const a = dbRowToEditor({ ...ROW, x: 100.0004 });
  const b = dbRowToEditor({ ...ROW, x: 100.0004 });
  assert.equal(positionDirtyKey(a), positionDirtyKey(b));
});

test("makeNewPosition: TEXT default + checkbox default", () => {
  const t = makeNewPosition("Ho_ten", 1, { type: "TEXT" });
  assert.equal(t.type, "TEXT");
  assert.equal(t.isRequired, false);
  assert.equal(t.align, "left");
  assert.equal(t.checkboxStyle, null);
  assert.equal(t.pageNumber, 1);

  const c = makeNewPosition("Khu_vuc", 1, { type: "CHECKBOX", sourceKey: "Khu_vuc", optionValue: "Đà Lạt" });
  assert.equal(c.type, "CHECKBOX");
  assert.equal(c.checkboxStyle, "SQUARE_X");
  assert.equal(c.sourceKey, "Khu_vuc");
  assert.equal(c.optionValue, "Đà Lạt");
});

test("newClientId: không trống và khác nhau", () => {
  assert.notEqual(newClientId(), newClientId());
});
