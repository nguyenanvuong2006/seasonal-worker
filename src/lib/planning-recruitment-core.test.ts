import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUEST_STATUSES,
  isOpenStatus,
  isTerminalStatus,
  normalizeRequestStatus,
  computeBalance,
  computeTotalRequest,
  computeRecruitedVsExpected,
  daysBetween,
  computeDateDeltas,
  isRequestExpired,
  isOverdueIncomplete,
  expectedDateBucket,
  bucketLabel,
  sortByExpectedDate,
  compareByExpectedDate,
  stripSystemOwnedFields,
  canEditColumn,
  validateReallocationInput,
  MAX_REALLOCATION_BATCH,
  TASK_PLANNING_REALLOCATION_REQUIRED,
  buildReallocationTaskTitle,
  shouldAutoCloseReallocationTask,
  SORT_BUCKET_OVERDUE,
  SORT_BUCKET_UPCOMING,
  SORT_BUCKET_UNDATED,
} from "./planning-recruitment-core.ts";
import {
  RECRUITMENT_REQUEST_COLUMNS,
  SYSTEM_OWNED_COLUMN_KEYS,
  resolveColumnsForRole,
  visibleColumns,
  defaultProfileFor,
  ALL_COLUMN_KEYS,
} from "./recruitment-request-columns.ts";

const TODAY = "2026-08-16";

/* ------------------------------------------------------------------ */
/* 1. TRẠNG THÁI: EXPIRED tách biệt hoàn toàn với CANCELLED            */
/* ------------------------------------------------------------------ */

test("status set contains EXPIRED as a status distinct from CANCELLED", () => {
  assert.deepEqual(
    [...REQUEST_STATUSES],
    ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED", "EXPIRED"],
  );
  assert.notEqual(normalizeRequestStatus("EXPIRED"), "CANCELLED");

  // EXPIRED không phải trạng thái kết thúc nghiệp vụ: yêu cầu vẫn cần xử lý.
  assert.equal(isTerminalStatus("COMPLETED"), true);
  assert.equal(isTerminalStatus("CANCELLED"), true);
  assert.equal(isTerminalStatus("EXPIRED"), false);
  assert.equal(isOpenStatus("PENDING"), true);
  assert.equal(isOpenStatus("PROCESSING"), true);
  assert.equal(isOpenStatus("EXPIRED"), false);
});

test("normalizeRequestStatus never turns an expiry wording into CANCELLED", () => {
  assert.equal(normalizeRequestStatus("pending"), "PENDING");
  assert.equal(normalizeRequestStatus("In Progress"), "PROCESSING");
  assert.equal(normalizeRequestStatus("Done"), "COMPLETED");
  assert.equal(normalizeRequestStatus("Cancelled"), "CANCELLED");

  // Mọi cách viết "hết hạn" đều phải ra EXPIRED, không được rơi vào CANCELLED.
  for (const raw of ["EXPIRED", "expire", "Hết hạn", "HET HAN", "het han"]) {
    const got = normalizeRequestStatus(raw);
    assert.equal(got, "EXPIRED", `"${raw}" -> ${got}`);
    assert.notEqual(got, "CANCELLED");
  }
  assert.equal(normalizeRequestStatus("khong biet"), null);
  assert.equal(normalizeRequestStatus(null), null);
});

/* ------------------------------------------------------------------ */
/* 2. BALANCE ĐƯỢC TÍNH LẠI TỰ ĐỘNG                                    */
/* ------------------------------------------------------------------ */

test("Balance recalculated: Balance = Rq - Recruited + Quit, per gender, clamped at 0", () => {
  // 10 nam yêu cầu, tuyển 4, nghỉ 1 -> còn thiếu 7.
  // 5 nữ yêu cầu, tuyển 2, nghỉ 0  -> còn thiếu 3.
  assert.deepEqual(
    computeBalance({ maleRq: 10, femaleRq: 5, maleRecruited: 4, femaleRecruited: 2, maleQuit: 1, femaleQuit: 0 }),
    { maleBalance: 7, femaleBalance: 3, totalBalance: 10 },
  );

  // Tuyển đủ -> 0, không âm.
  assert.deepEqual(
    computeBalance({ maleRq: 5, femaleRq: 5, maleRecruited: 5, femaleRecruited: 5, maleQuit: 0, femaleQuit: 0 }),
    { maleBalance: 0, femaleBalance: 0, totalBalance: 0 },
  );

  // Tuyển vượt -> vẫn clamp về 0, không cho số âm lan vào Total Balance.
  assert.deepEqual(
    computeBalance({ maleRq: 3, femaleRq: 3, maleRecruited: 9, femaleRecruited: 9, maleQuit: 0, femaleQuit: 0 }),
    { maleBalance: 0, femaleBalance: 0, totalBalance: 0 },
  );

  // Người nghỉ làm nhu cầu mở lại: tuyển đủ 5 rồi 2 người nghỉ -> thiếu lại 2.
  assert.equal(
    computeBalance({ maleRq: 5, femaleRq: 0, maleRecruited: 5, femaleRecruited: 0, maleQuit: 2, femaleQuit: 0 })
      .totalBalance,
    2,
  );

  // Giá trị rác từ Excel không làm hỏng công thức.
  assert.deepEqual(
    computeBalance({
      maleRq: Number.NaN,
      femaleRq: 4,
      maleRecruited: Number.NaN,
      femaleRecruited: 1,
      maleQuit: 0,
      femaleQuit: 0,
    }),
    { maleBalance: 0, femaleBalance: 3, totalBalance: 3 },
  );
});

test("Total Request and Recruited vs Expected are derived, never taken from Excel", () => {
  assert.equal(computeTotalRequest(10, 5), 15);
  assert.equal(computeTotalRequest(-3, 5), 5);
  assert.equal(computeRecruitedVsExpected(5, 5, 20), 50);
  assert.equal(computeRecruitedVsExpected(0, 0, 20), 0);
  assert.equal(computeRecruitedVsExpected(5, 5, 0), 0);
  // Tuyển vượt phải nhìn thấy được, không cắt trần ở 100%.
  assert.equal(computeRecruitedVsExpected(15, 15, 20), 150);
});

test("date deltas: Offered/Completed vs Requested measured in days", () => {
  assert.equal(daysBetween("2026-08-01", "2026-08-16"), 15);
  assert.equal(daysBetween("2026-08-16", "2026-08-01"), -15);
  assert.equal(daysBetween(null, "2026-08-01"), null);
  assert.equal(daysBetween("bad-date", "2026-08-01"), null);

  assert.deepEqual(
    computeDateDeltas({ requestedDate: "2026-08-01", offeredDate: "2026-08-06", completedDate: "2026-08-21" }),
    { offeredVsRequested: 5, completedVsRequested: 20 },
  );
  assert.deepEqual(computeDateDeltas({ requestedDate: "2026-08-01" }), {
    offeredVsRequested: null,
    completedVsRequested: null,
  });
});

/* ------------------------------------------------------------------ */
/* 3. HẾT HẠN ≠ NGHỈ VIỆC                                              */
/* ------------------------------------------------------------------ */

test("expired request is only a lapsed demand: never CANCELLED, never a resignation", () => {
  const req = { endDate: "2026-08-01", status: "PROCESSING" };
  assert.equal(isRequestExpired(req, TODAY), true);

  // Quá End Date KHÔNG được biến thành CANCELLED.
  const normalized = normalizeRequestStatus("EXPIRED");
  assert.equal(normalized, "EXPIRED");
  assert.notEqual(normalized, "CANCELLED");

  // Yêu cầu đã đóng nghiệp vụ thì không tính là hết hạn nữa.
  assert.equal(isRequestExpired({ endDate: "2026-08-01", status: "COMPLETED" }, TODAY), false);
  assert.equal(isRequestExpired({ endDate: "2026-08-01", status: "CANCELLED" }, TODAY), false);

  // Chưa tới End Date, hoặc đúng hôm nay, hoặc không có End Date -> chưa hết hạn.
  assert.equal(isRequestExpired({ endDate: "2026-09-01", status: "PENDING" }, TODAY), false);
  assert.equal(isRequestExpired({ endDate: TODAY, status: "PENDING" }, TODAY), false);
  assert.equal(isRequestExpired({ endDate: null, status: "PENDING" }, TODAY), false);
});

test("an expired request produces exactly one reallocation task type and title", () => {
  assert.equal(TASK_PLANNING_REALLOCATION_REQUIRED, "PLANNING_REALLOCATION_REQUIRED");
  const title = buildReallocationTaskTitle("RQ-2026-001");
  assert.equal(
    title,
    "Yêu cầu nhân lực RQ-2026-001 đã hết hạn — cần xác nhận phân bổ DW sang yêu cầu mới.",
  );
  // Tiêu đề ổn định -> cron chạy lại sinh ra cùng một task, không tạo bản khác.
  assert.equal(buildReallocationTaskTitle("RQ-2026-001"), title);
});

test("reallocation task auto-closes only when no open allocation remains", () => {
  assert.equal(shouldAutoCloseReallocationTask(5), false);
  assert.equal(shouldAutoCloseReallocationTask(1), false);
  assert.equal(shouldAutoCloseReallocationTask(0), true);
});

/* ------------------------------------------------------------------ */
/* 4. SẮP XẾP MẶC ĐỊNH THEO EXPECTED DATE                              */
/* ------------------------------------------------------------------ */

test("default sort is by Expected Date near to far, overdue-incomplete grouped on top", () => {
  const rows = [
    { requestCode: "C-FUTURE", expectedDate: "2026-12-01", status: "PENDING", totalBalance: 4, endDate: "2026-12-31" },
    { requestCode: "A-OVERDUE-OLD", expectedDate: "2026-07-01", status: "PROCESSING", totalBalance: 3, endDate: "2026-12-31" },
    { requestCode: "E-NODATE", expectedDate: null, status: "PENDING", totalBalance: 2, endDate: null },
    { requestCode: "B-OVERDUE-NEW", expectedDate: "2026-08-10", status: "PENDING", totalBalance: 1, endDate: "2026-12-31" },
    { requestCode: "D-SOON", expectedDate: "2026-08-20", status: "PENDING", totalBalance: 5, endDate: "2026-12-31" },
  ];

  const sorted = sortByExpectedDate(rows, TODAY).map((r) => r.requestCode);
  assert.deepEqual(sorted, ["A-OVERDUE-OLD", "B-OVERDUE-NEW", "D-SOON", "C-FUTURE", "E-NODATE"]);

  // Không sắp theo ngày kết thúc mùa vụ: E-NODATE có endDate null vẫn xuống cuối,
  // và C-FUTURE/D-SOON có cùng endDate nhưng thứ tự do Expected Date quyết định.
  assert.ok(sorted.indexOf("D-SOON") < sorted.indexOf("C-FUTURE"));

  // Hàm sort không đột biến mảng gốc.
  assert.equal(rows[0].requestCode, "C-FUTURE");
});

test("sort buckets: overdue-incomplete, upcoming, undated", () => {
  const overdue = { requestCode: "X", expectedDate: "2026-01-01", status: "PENDING", totalBalance: 2 };
  const overdueButFilled = { requestCode: "Y", expectedDate: "2026-01-01", status: "PENDING", totalBalance: 0 };
  const upcoming = { requestCode: "Z", expectedDate: "2026-09-01", status: "PENDING", totalBalance: 2 };
  const undated = { requestCode: "W", expectedDate: null, status: "PENDING", totalBalance: 2 };

  assert.equal(expectedDateBucket(overdue, TODAY), SORT_BUCKET_OVERDUE);
  // Quá ngày nhưng đã tuyển đủ -> không phải việc cần xử lý gấp.
  assert.equal(expectedDateBucket(overdueButFilled, TODAY), SORT_BUCKET_UPCOMING);
  assert.equal(expectedDateBucket(upcoming, TODAY), SORT_BUCKET_UPCOMING);
  assert.equal(expectedDateBucket(undated, TODAY), SORT_BUCKET_UNDATED);

  assert.equal(isOverdueIncomplete(overdue, TODAY), true);
  assert.equal(isOverdueIncomplete(overdueButFilled, TODAY), false);
  // Yêu cầu đã hoàn tất/huỷ không bao giờ bị gắn cờ quá hạn.
  assert.equal(isOverdueIncomplete({ ...overdue, status: "COMPLETED" }, TODAY), false);
  assert.equal(isOverdueIncomplete({ ...overdue, status: "CANCELLED" }, TODAY), false);

  assert.equal(bucketLabel(SORT_BUCKET_OVERDUE), "Quá hạn / Cần xử lý");
  assert.equal(bucketLabel(SORT_BUCKET_UPCOMING), "Sắp tới");
  assert.equal(bucketLabel(SORT_BUCKET_UNDATED), "Chưa có ngày cần nhân lực");

  assert.ok(compareByExpectedDate(overdue, upcoming, TODAY) < 0);
  assert.ok(compareByExpectedDate(undated, upcoming, TODAY) > 0);
});

/* ------------------------------------------------------------------ */
/* 5. EXCEL KHÔNG ĐƯỢC GHI ĐÈ SỐ LIỆU HỆ THỐNG                         */
/* ------------------------------------------------------------------ */

test("Excel import cannot overwrite system-owned KPI columns", () => {
  const pasted = {
    requestCode: "RQ-001",
    maleRq: 10,
    femaleRq: 5,
    // Các cột dưới đây do hệ thống tính/đọc từ nguồn thật -> phải bị loại bỏ.
    totalRequest: 999,
    maleRecruited: 99,
    femaleRecruited: 99,
    maleBalance: 0,
    femaleBalance: 0,
    totalBalance: 0,
    recruitedVsExpected: 100,
    remarks: "ghi chú hợp lệ",
  };

  const { safe, rejected } = stripSystemOwnedFields(pasted);

  assert.equal(safe.requestCode, "RQ-001");
  assert.equal(safe.maleRq, 10);
  assert.equal(safe.femaleRq, 5);
  assert.equal(safe.remarks, "ghi chú hợp lệ");

  for (const key of ["totalRequest", "maleRecruited", "maleBalance", "totalBalance", "recruitedVsExpected"]) {
    assert.equal(key in safe, false, `${key} phải bị loại khỏi payload import`);
    assert.ok(rejected.includes(key), `${key} phải được báo lại cho người import`);
  }

  // Ô trống trong Excel không bị coi là mưu toan ghi đè.
  const blank = stripSystemOwnedFields({ requestCode: "RQ-002", totalBalance: "" });
  assert.deepEqual(blank.rejected, []);
  assert.equal("totalBalance" in blank.safe, false);
});

test("system-owned column keys cover every DERIVED and SYSTEM column", () => {
  const expected = RECRUITMENT_REQUEST_COLUMNS.filter((c) => c.source !== "INPUT").map((c) => c.key);
  assert.deepEqual([...SYSTEM_OWNED_COLUMN_KEYS].sort(), [...expected].sort());
  assert.ok(SYSTEM_OWNED_COLUMN_KEYS.includes("totalBalance"));
  assert.ok(SYSTEM_OWNED_COLUMN_KEYS.includes("maleBalance"));
  assert.ok(SYSTEM_OWNED_COLUMN_KEYS.includes("maleApplication"));
  assert.ok(!SYSTEM_OWNED_COLUMN_KEYS.includes("maleRq"));
  assert.ok(!SYSTEM_OWNED_COLUMN_KEYS.includes("remarks"));
});

/* ------------------------------------------------------------------ */
/* 6. PHÂN QUYỀN CỘT: DEPT_MANAGER CHỈ ĐỌC                             */
/* ------------------------------------------------------------------ */

test("read-only role (DEPT_MANAGER) cannot edit any column", () => {
  assert.equal(canEditColumn("maleRq", { readOnlyRole: false }), true);
  assert.equal(canEditColumn("remarks", { readOnlyRole: false }), true);
  // Cột hệ thống thì kể cả Recruiter cũng không sửa tay được.
  assert.equal(canEditColumn("totalBalance", { readOnlyRole: false }), false);
  assert.equal(canEditColumn("maleRecruited", { readOnlyRole: false }), false);
  assert.equal(canEditColumn("khongTonTai", { readOnlyRole: false }), false);

  // Vai trò chỉ đọc: không sửa được bất kỳ cột nào trong toàn bộ catalog.
  for (const key of ALL_COLUMN_KEYS) {
    assert.equal(canEditColumn(key, { readOnlyRole: true }), false, `${key} phải khoá với vai trò chỉ đọc`);
  }
});

test("column profiles are role- and device-aware, with no hardcoded UI list", () => {
  // Mọi vai trò đều có profile desktop và mobile.
  for (const role of ["ADMIN", "HR_DIRECTOR", "HR_RECRUITER", "DEPT_MANAGER"]) {
    for (const device of ["desktop", "mobile"] as const) {
      const profile = defaultProfileFor(role, device);
      assert.equal(profile.role, role);
      assert.equal(profile.device, device);
      assert.ok(profile.visible.length > 0, `${role}/${device} phải có cột mặc định`);
    }
  }

  // Mobile chỉ hiện cột ưu tiên, không đổ cả ~40 cột ra màn hình nhỏ.
  const mobile = visibleColumns(resolveColumnsForRole("HR_RECRUITER", "mobile", null));
  const desktop = visibleColumns(resolveColumnsForRole("HR_RECRUITER", "desktop", null));
  assert.ok(mobile.length < desktop.length);
  assert.ok(mobile.length <= 8, `mobile hiện ${mobile.length} cột, quá nhiều`);

  // Cấu hình lưu trong DB ghi đè mặc định: ẩn cột, đổi thứ tự, ghim.
  const overridden = resolveColumnsForRole("HR_RECRUITER", "desktop", [
    { columnKey: "requestCode", visible: true, sortOrder: 0, sticky: true },
    { columnKey: "expectedDate", visible: true, sortOrder: 1, sticky: false },
    { columnKey: "cost", visible: false, sortOrder: 2, sticky: false },
  ]);
  assert.equal(overridden[0].key, "requestCode");
  assert.equal(overridden[0].sticky, true);
  assert.equal(overridden[1].key, "expectedDate");
  assert.equal(overridden.find((c) => c.key === "cost")?.visible, false);

  // Vai trò chỉ đọc không bao giờ nhận được cột editable, kể cả khi gọi ép.
  const deptManagerCols = resolveColumnsForRole("DEPT_MANAGER", "desktop", null, { canEdit: true });
  assert.equal(deptManagerCols.some((c) => c.editable), false);
  assert.equal(defaultProfileFor("DEPT_MANAGER", "desktop").readOnly, true);
  assert.equal(defaultProfileFor("HR_RECRUITER", "desktop").readOnly, false);
});

test("catalog covers the full Recruitment Request column set with unique keys", () => {
  assert.ok(RECRUITMENT_REQUEST_COLUMNS.length >= 40, `mới có ${RECRUITMENT_REQUEST_COLUMNS.length} cột`);
  assert.equal(new Set(ALL_COLUMN_KEYS).size, ALL_COLUMN_KEYS.length, "trùng key cột");

  // Sáu trường ngày phải tách bạch, không dùng chung một cột.
  for (const key of ["requestedDate", "expectedDate", "startingDate", "endDate", "offeredDate", "completedDate"]) {
    assert.ok(ALL_COLUMN_KEYS.includes(key), `thiếu cột ngày ${key}`);
  }
  // Nhãn tiếng Việt bắt buộc.
  const byKey = Object.fromEntries(RECRUITMENT_REQUEST_COLUMNS.map((c) => [c.key, c]));
  assert.equal(byKey.requestedDate.labelVi, "Ngày yêu cầu");
  assert.equal(byKey.expectedDate.labelVi, "Ngày cần nhân lực");
  assert.equal(byKey.startingDate.labelVi, "Ngày nhận việc");
  assert.equal(byKey.endDate.labelVi, "Ngày kết thúc yêu cầu");
  assert.equal(byKey.completedDate.labelVi, "Ngày tuyển đủ");

  // Không còn tên sai chính tả "Offerred".
  for (const col of RECRUITMENT_REQUEST_COLUMNS) {
    assert.ok(!/offerred/i.test(col.key), `key sai chính tả: ${col.key}`);
    assert.ok(!/offerred/i.test(col.label), `nhãn sai chính tả: ${col.label}`);
  }
});

/* ------------------------------------------------------------------ */
/* 7. KIỂM TRA ĐẦU VÀO TÁI PHÂN BỔ                                     */
/* ------------------------------------------------------------------ */

test("reallocation input validation guards the transaction", () => {
  assert.deepEqual(validateReallocationInput({ fromRequestId: "a", toRequestId: "b", allocationIds: ["x"] }), {
    ok: true,
  });

  // Chuyển 20 DW cùng lúc là hợp lệ (yêu cầu nghiệp vụ).
  const twenty = Array.from({ length: 20 }, (_, i) => `alloc-${i}`);
  assert.equal(validateReallocationInput({ fromRequestId: "a", toRequestId: "b", allocationIds: twenty }).ok, true);

  const cases: Array<[string, ReturnType<typeof validateReallocationInput>]> = [
    ["thiếu id", validateReallocationInput({ fromRequestId: "", toRequestId: "b", allocationIds: ["x"] })],
    ["trùng nguồn/đích", validateReallocationInput({ fromRequestId: "a", toRequestId: "a", allocationIds: ["x"] })],
    ["rỗng", validateReallocationInput({ fromRequestId: "a", toRequestId: "b", allocationIds: [] })],
    ["trùng DW", validateReallocationInput({ fromRequestId: "a", toRequestId: "b", allocationIds: ["x", "x"] })],
    [
      "quá lô",
      validateReallocationInput({
        fromRequestId: "a",
        toRequestId: "b",
        allocationIds: Array.from({ length: MAX_REALLOCATION_BATCH + 1 }, (_, i) => `a${i}`),
      }),
    ],
  ];
  for (const [name, result] of cases) {
    assert.equal(result.ok, false, `${name} phải bị chặn`);
  }
});
