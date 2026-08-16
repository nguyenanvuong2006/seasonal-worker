import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHeaderName,
  resolveHeaderAlias,
  mapRowToCanonical,
  validateRow,
  computeBalanceFromCanonical,
  parseDate,
  toInt,
  normalizeStatus,
} from "./recruitment-request-utils.ts";

test("normalizeHeaderName removes Vietnamese accents and spaces", () => {
  assert.equal(normalizeHeaderName("  Request Code  "), "requestcode");
  assert.equal(normalizeHeaderName("Mã yêu cầu"), "mayeucau");
  assert.equal(normalizeHeaderName("Giới tính"), "gioitinh");
  assert.equal(normalizeHeaderName("Số CCCD"), "socccd");
  assert.equal(normalizeHeaderName(""), "");
});

test("resolveHeaderAlias matches canonical headers", () => {
  assert.equal(resolveHeaderAlias("Request Code"), "Request Code");
  assert.equal(resolveHeaderAlias("Mã yêu cầu"), "Request Code");
  assert.equal(resolveHeaderAlias("ma yeu cau"), "Request Code");
  assert.equal(resolveHeaderAlias("Male Rq"), "Male Rq");
  assert.equal(resolveHeaderAlias("Nam Rq"), "Male Rq");
  assert.equal(resolveHeaderAlias("Female Rq"), "Female Rq");
  assert.equal(resolveHeaderAlias("Nữ Rq"), "Female Rq");
  assert.equal(resolveHeaderAlias("Unknown Column"), null);
});

test("resolveHeaderAlias handles case and accent variations", () => {
  assert.equal(resolveHeaderAlias("NGƯỜI YÊU CẦU"), "Requester");
  assert.equal(resolveHeaderAlias("người yêu cầu"), "Requester");
  assert.equal(resolveHeaderAlias("ĐỊA ĐIỂM"), "Location");
  assert.equal(resolveHeaderAlias("vị trí"), "Position");
  assert.equal(resolveHeaderAlias("TRẠNG THÁI"), "Status");
  assert.equal(resolveHeaderAlias("Ghi chú"), "Remarks");
});

test("mapRowToCanonical maps all known headers and returns unknown ones", () => {
  const raw = {
    "Request Code": "RQ-001",
    "Requester": "Nguyễn Văn A",
    "Male Rq": "5",
    "Female Rq": "3",
    "Unknown Col": "value",
    "Another Unknown": "test",
  };
  const { canonical, unknownHeaders } = mapRowToCanonical(raw);
  assert.equal(canonical["Request Code"], "RQ-001");
  assert.equal(canonical["Requester"], "Nguyễn Văn A");
  assert.equal(canonical["Male Rq"], "5");
  assert.equal(canonical["Female Rq"], "3");
  assert.ok(unknownHeaders.includes("Unknown Col"));
  assert.ok(unknownHeaders.includes("Another Unknown"));
});

test("mapRowToCanonical handles Vietnamese header names", () => {
  const raw = {
    "Mã yêu cầu": "RQ-002",
    "Người yêu cầu": "Trần Thị B",
    "Nam cần": "10",
    "Nữ cần": "8",
  };
  const { canonical } = mapRowToCanonical(raw);
  assert.equal(canonical["Request Code"], "RQ-002");
  assert.equal(canonical["Requester"], "Trần Thị B");
  assert.equal(canonical["Male Rq"], "10");
  assert.equal(canonical["Female Rq"], "8");
});

test("validateRow passes for valid row", () => {
  const row = {
    "Request Code": "RQ-001",
    "Requester": "Nguyễn Văn A",
    "Male Rq": "5",
    "Female Rq": "3",
    "Male Recruited": "2",
    "Female Recruited": "1",
    "Male Quit": "0",
    "Female Quit": "0",
    "Status": "PENDING",
    "Requested Date": "01/01/2025",
    "Expected Date": "2025-02-01",
  };
  const result = validateRow(row);
  assert.ok(result.valid);
  assert.equal(result.errors.length, 0);
});

test("validateRow fails for missing Request Code", () => {
  const row = {
    "Requester": "Test",
    "Male Rq": "5",
  };
  const result = validateRow(row);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.field === "Request Code"));
});

test("validateRow fails for invalid numeric fields", () => {
  const row = {
    "Request Code": "RQ-002",
    "Male Rq": "abc",
    "Female Rq": "xyz",
  };
  const result = validateRow(row);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.field === "Male Rq"));
  assert.ok(result.errors.some((e) => e.field === "Female Rq"));
});

test("validateRow fails for invalid date format", () => {
  const row = {
    "Request Code": "RQ-003",
    "Requested Date": "invalid-date",
  };
  const result = validateRow(row);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.field === "Requested Date"));
});

test("validateRow warns for non-standard status", () => {
  const row = {
    "Request Code": "RQ-004",
    "Status": "DRAFT",
  };
  const result = validateRow(row);
  assert.ok(result.valid);
  assert.ok(result.warnings.some((w) => w.field === "Status"));
});

test("validateRow accepts dd/MM/yyyy and yyyy-MM-dd dates", () => {
  const row1 = {
    "Request Code": "RQ-005",
    "Requested Date": "15/03/2025",
  };
  assert.ok(validateRow(row1).valid);

  const row2 = {
    "Request Code": "RQ-006",
    "Requested Date": "2025-03-15",
  };
  assert.ok(validateRow(row2).valid);
});

test("parseDate handles Vietnamese and ISO date formats", () => {
  assert.equal(parseDate("15/03/2025"), "2025-03-15");
  assert.equal(parseDate("01/12/2025"), "2025-12-01");
  assert.equal(parseDate("2025-03-15"), "2025-03-15");
  assert.equal(parseDate("2025-12-01"), "2025-12-01");
  assert.equal(parseDate("invalid"), null);
  assert.equal(parseDate(""), null);
});

test("toInt parses numbers correctly", () => {
  assert.equal(toInt("5"), 5);
  assert.equal(toInt("10"), 10);
  assert.equal(toInt(""), 0);
  assert.equal(toInt("abc"), 0);
  assert.equal(toInt(undefined), 0);
});

test("normalizeStatus maps status variants", () => {
  assert.equal(normalizeStatus("PENDING"), "PENDING");
  assert.equal(normalizeStatus("PROCESSING"), "PROCESSING");
  assert.equal(normalizeStatus("COMPLETED"), "COMPLETED");
  assert.equal(normalizeStatus("CANCELLED"), "CANCELLED");
  assert.equal(normalizeStatus("pending"), "PENDING");
  assert.equal(normalizeStatus("Processing"), "PROCESSING");
  assert.equal(normalizeStatus("in progress"), "PROCESSING");
  assert.equal(normalizeStatus("Complete"), "COMPLETED");
  assert.equal(normalizeStatus("DONE"), "COMPLETED");
  assert.equal(normalizeStatus("cancel"), "CANCELLED");
  assert.equal(normalizeStatus(""), null);
  assert.equal(normalizeStatus(undefined), null);
});

test("computeBalanceFromCanonical formula: Balance = max(0, Rq - Current Workforce). PHASE 6 v2: Recruited/Quit are historical KPIs, NOT in formula", () => {
  // Default: Current = 0/0 (luồng INSERT yêu cầu mới, chưa có allocation nào).
  // Balance = Rq - 0 = Rq. Recruited/Quit giá trị tuỳ ý KHÔNG ảnh hưởng.
  let b = computeBalanceFromCanonical({
    "Male Rq": "10", "Female Rq": "8",
    "Male Recruited": "4", "Female Recruited": "3",
    "Male Quit": "1", "Female Quit": "0",
  });
  assert.equal(b.maleBalance, 10, "INSERT mới, Current=0 → Balance = Rq");
  assert.equal(b.femaleBalance, 8);
  assert.equal(b.totalBalance, 18);

  // Có Current truyền vào (luồng UPDATE yêu cầu đã tồn tại).
  b = computeBalanceFromCanonical({
    "Male Rq": "10", "Female Rq": "8",
    "Male Recruited": "4", "Female Recruited": "3",
    "Male Quit": "1", "Female Quit": "0",
  }, { maleCurrent: 4, femaleCurrent: 3 });
  assert.equal(b.maleBalance, 6, "10 - 4 = 6 (Current=4) — Quit vẫn ignored");
  assert.equal(b.femaleBalance, 5, "8 - 3 = 5 (Current=3) — Quit vẫn ignored");
  assert.equal(b.totalBalance, 11);

  // Current vượt Rq → clamp về 0
  b = computeBalanceFromCanonical({
    "Male Rq": "5", "Female Rq": "5",
    "Male Recruited": "6", "Female Recruited": "7",
    "Male Quit": "0", "Female Quit": "0",
  }, { maleCurrent: 8, femaleCurrent: 9 });
  assert.equal(b.maleBalance, 0);
  assert.equal(b.femaleBalance, 0);
  assert.equal(b.totalBalance, 0);

  // PHASE 6 v2 regression A: Rq=10, Current=9, Quit=1 → Balance = max(0, 10-9) = 1
  b = computeBalanceFromCanonical({
    "Male Rq": "10", "Female Rq": "0",
    "Male Recruited": "9", "Female Recruited": "0",
    "Male Quit": "1", "Female Quit": "0",
  }, { maleCurrent: 9, femaleCurrent: 0 });
  assert.equal(b.maleBalance, 1);
  assert.equal(b.femaleBalance, 0);
  assert.equal(b.totalBalance, 1);

  // PHASE 6 v2 regression B: Rq=10, Current=8, Quit=4 → Balance = 2
  b = computeBalanceFromCanonical({
    "Male Rq": "10", "Female Rq": "0",
    "Male Recruited": "12", "Female Recruited": "0",
    "Male Quit": "4", "Female Quit": "0",
  }, { maleCurrent: 8, femaleCurrent: 0 });
  assert.equal(b.maleBalance, 2);
  assert.equal(b.totalBalance, 2);

  // PHASE 6 v2 regression C: Rq=10, Current=10, Quit=5 → Balance = 0
  b = computeBalanceFromCanonical({
    "Male Rq": "10", "Female Rq": "0",
    "Male Recruited": "15", "Female Recruited": "0",
    "Male Quit": "5", "Female Quit": "0",
  }, { maleCurrent: 10, femaleCurrent: 0 });
  assert.equal(b.maleBalance, 0);
  assert.equal(b.totalBalance, 0);

  // PHASE 6 v2 regression D: Rq=10, Current=0, Quit=10 → Balance = 10
  b = computeBalanceFromCanonical({
    "Male Rq": "10", "Female Rq": "0",
    "Male Recruited": "10", "Female Recruited": "0",
    "Male Quit": "10", "Female Quit": "0",
  }, { maleCurrent: 0, femaleCurrent: 0 });
  assert.equal(b.maleBalance, 10);
  assert.equal(b.totalBalance, 10);

  // Zero demand
  b = computeBalanceFromCanonical({
    "Male Rq": "0", "Female Rq": "0",
    "Male Recruited": "0", "Female Recruited": "0",
    "Male Quit": "0", "Female Quit": "0",
  });
  assert.equal(b.maleBalance, 0);
  assert.equal(b.femaleBalance, 0);
  assert.equal(b.totalBalance, 0);
});

test("mapRowToCanonical handles all field types from Excel paste", () => {
  const raw = {
    "Request Code": "RQ-007",
    "Requester": "Lê Văn C",
    "Position": "Trưởng ca",
    "Job title": "Giám sát sản xuất",
    "Location": "Đà Lạt",
    "Section": "Tổ 1",
    "Group": "Nhóm A",
    "Division": "Khối sản xuất",
    "Department": "Packing",
    "Reason": "Thiếu nhân sự",
    "Note for reason": "Cần gấp",
    "Special Requirements": "Có kinh nghiệm",
    "Male Rq": "10",
    "Female Rq": "5",
    "Male Application": "8",
    "Female Application": "4",
    "Male Interviewed": "6",
    "Female Interviewed": "3",
    "Male Recruited": "5",
    "Female Recruited": "2",
    "Male Quit": "1",
    "Female Quit": "0",
    "Status": "PROCESSING",
    "Requested Date": "01/01/2025",
    "Expected Date": "15/01/2025",
    "Offered Date": "10/01/2025",
    "Completed Date": "",
    "Month": "01/2025",
    "Cost": "5000000",
    "Remarks": "Ghi chú",
    "To": "HR",
    "Rq Status": "Đang xử lý",
    "Month_Rc": "01/2025",
    "Total Request": "15",
    "Recruited vs Expected": "80",
    "Screened": "12",
    "Interview": "9",
    "Recruit": "7",
    "Month_Report": "01/2025",
  };
  const { canonical, unknownHeaders } = mapRowToCanonical(raw);
  assert.equal(unknownHeaders.length, 0); // All known
  assert.equal(canonical["Request Code"], "RQ-007");
  assert.equal(canonical["Requester"], "Lê Văn C");
  assert.equal(canonical["Position"], "Trưởng ca");
  assert.equal(canonical["Job title"], "Giám sát sản xuất");
  assert.equal(canonical["Location"], "Đà Lạt");
  assert.equal(canonical["Section"], "Tổ 1");
  assert.equal(canonical["Group"], "Nhóm A");
  assert.equal(canonical["Division"], "Khối sản xuất");
  assert.equal(canonical["Department"], "Packing");
  assert.equal(canonical["Reason"], "Thiếu nhân sự");
  assert.equal(canonical["Male Rq"], "10");
  assert.equal(canonical["Female Rq"], "5");
  assert.equal(canonical["Status"], "PROCESSING");
});