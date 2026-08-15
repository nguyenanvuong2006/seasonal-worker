import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  ageBucket,
  buildApplicationWhere,
  bucketStart,
  conversionPct,
  enumerateBuckets,
  makeKpi,
  matchDepartmentsByHierarchy,
  parseAnalyticsFilters,
  pctChange,
  previousRange,
  rangeDays,
  resolveDeptRestriction,
  sessionCountBucketIndex,
  trendGranularity,
  UNKNOWN_REFERRAL,
  type AnalyticsFilters,
  type DeptMeta,
} from "./analytics-core.ts";

const TODAY = "2026-08-15";

function parse(qs: string) {
  return parseAnalyticsFilters(new URLSearchParams(qs), TODAY);
}

function baseFilters(over: Partial<AnalyticsFilters> = {}): AnalyticsFilters {
  return {
    from: "2026-08-01",
    to: "2026-08-15",
    location: null,
    division: null,
    departmentId: null,
    section: null,
    groupName: null,
    workerType: "ALL",
    gender: "ALL",
    referralChannel: null,
    status: null,
    ...over,
  };
}

/* ---------------- 1. Date filter / parameter validation (test 1, 14) ---------------- */

test("parse: mặc định 30 ngày gần nhất theo giờ VN", () => {
  const r = parse("");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.filters.to, TODAY);
    assert.equal(r.filters.from, addDays(TODAY, -29));
    assert.equal(rangeDays(r.filters.from, r.filters.to), 30);
  }
});

test("parse: from/to hợp lệ được giữ nguyên", () => {
  const r = parse("from=2026-08-01&to=2026-08-15");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.filters.from, "2026-08-01");
    assert.equal(r.filters.to, "2026-08-15");
  }
});

test("parse: ngày sai định dạng / không tồn tại bị từ chối", () => {
  assert.equal(parse("from=2026-13-01&to=2026-08-15").ok, false);
  assert.equal(parse("from=hello&to=2026-08-15").ok, false);
  assert.equal(parse("from=2026-02-30&to=2026-08-15").ok, false);
});

test("parse: from > to bị từ chối", () => {
  assert.equal(parse("from=2026-08-20&to=2026-08-15").ok, false);
});

test("parse: range quá dài bị từ chối (an toàn hiệu năng)", () => {
  assert.equal(parse("from=2020-01-01&to=2026-08-15").ok, false);
});

test("parse: departmentId phải là UUID", () => {
  assert.equal(parse("departmentId=1;DROP TABLE users").ok, false);
  assert.equal(parse("departmentId=6f9619ff-8b86-d011-b42d-00c04fc964ff").ok, true);
});

test("parse: workerType/gender ngoài danh mục bị từ chối", () => {
  assert.equal(parse("workerType=HACK").ok, false);
  assert.equal(parse("gender=X").ok, false);
  const r = parse("workerType=new&gender=female");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.filters.workerType, "NEW");
    assert.equal(r.filters.gender, "FEMALE");
  }
});

/* ---------------- 12. Previous-period comparison ---------------- */

test("previousRange: cùng số ngày, nằm ngay trước kỳ đã chọn", () => {
  const r = previousRange("2026-08-01", "2026-08-15"); // 15 ngày
  assert.equal(r.to, "2026-07-31");
  assert.equal(r.from, "2026-07-17");
  assert.equal(rangeDays(r.from, r.to), 15);
});

test("previousRange: 1 ngày → đúng hôm trước", () => {
  const r = previousRange("2026-08-15", "2026-08-15");
  assert.deepEqual(r, { from: "2026-08-14", to: "2026-08-14" });
});

test("previousRange: qua ranh giới tháng/năm", () => {
  const r = previousRange("2026-01-01", "2026-01-30");
  assert.equal(r.to, "2025-12-31");
  assert.equal(rangeDays(r.from, r.to), 30);
});

/* ---------------- Granularity ---------------- */

test("trendGranularity: <=31 DAY, 32-180 WEEK, >180 MONTH", () => {
  assert.equal(trendGranularity(1), "DAY");
  assert.equal(trendGranularity(31), "DAY");
  assert.equal(trendGranularity(32), "WEEK");
  assert.equal(trendGranularity(180), "WEEK");
  assert.equal(trendGranularity(181), "MONTH");
});

test("bucketStart/enumerateBuckets: tuần bắt đầu thứ 2, không đứt bucket", () => {
  // 2026-08-15 là thứ 7 → tuần bắt đầu 2026-08-10 (thứ 2)
  assert.equal(bucketStart("2026-08-15", "WEEK"), "2026-08-10");
  assert.equal(bucketStart("2026-08-15", "MONTH"), "2026-08-01");
  const days = enumerateBuckets("2026-08-01", "2026-08-05", "DAY");
  assert.deepEqual(days, ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]);
  const months = enumerateBuckets("2026-01-15", "2026-04-02", "MONTH");
  assert.deepEqual(months, ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
});

/* ---------------- 2,3,4. Scope resolution ---------------- */

test("scope=null + không filter → không giới hạn (null)", () => {
  assert.equal(resolveDeptRestriction(null, null), null);
});

test("scope=[] → không thấy gì, kể cả có filter", () => {
  assert.deepEqual(resolveDeptRestriction([], null), []);
  assert.deepEqual(resolveDeptRestriction([], ["d1"]), []);
});

test("scope=[1 dept] → chỉ dept đó; filter dept NGOÀI scope → [] (không leak)", () => {
  assert.deepEqual(resolveDeptRestriction(["d1"], null), ["d1"]);
  assert.deepEqual(resolveDeptRestriction(["d1"], ["d1"]), ["d1"]);
  assert.deepEqual(resolveDeptRestriction(["d1"], ["d2"]), []); // filter ngoài scope
});

test("scope=null + filter → chỉ dept khớp filter", () => {
  assert.deepEqual(resolveDeptRestriction(null, ["d3", "d4"]), ["d3", "d4"]);
});

/* ---------------- Hierarchy matching ---------------- */

const DEPTS: DeptMeta[] = [
  { id: "a", deptName: "Packing", groupName: "A", vnName: null, location: "Đà Lạt", division: "Production", section: "Pack" },
  { id: "b", deptName: "Packing", groupName: "B", vnName: null, location: "Đà Lạt", division: "Production", section: "Pack" },
  { id: "c", deptName: "Rose", groupName: "", vnName: null, location: "Đơn Dương", division: "Farm", section: "Grow" },
];

test("hierarchy filter: không filter → null; theo location/division/section/group", () => {
  assert.equal(matchDepartmentsByHierarchy(DEPTS, baseFilters()), null);
  assert.deepEqual(matchDepartmentsByHierarchy(DEPTS, baseFilters({ location: "đà lạt" })), ["a", "b"]);
  assert.deepEqual(matchDepartmentsByHierarchy(DEPTS, baseFilters({ division: "Farm" })), ["c"]);
  assert.deepEqual(matchDepartmentsByHierarchy(DEPTS, baseFilters({ groupName: "B" })), ["b"]);
  assert.deepEqual(matchDepartmentsByHierarchy(DEPTS, baseFilters({ departmentId: "c" })), ["c"]);
  assert.deepEqual(matchDepartmentsByHierarchy(DEPTS, baseFilters({ location: "Đà Lạt", groupName: "Z" })), []);
});

/* ---------------- SQL builder: parameterized, no injection ---------------- */

test("buildApplicationWhere: mọi input đi qua params, không nối chuỗi", () => {
  const evil = "'; DROP TABLE daily_applications; --";
  const { where, params } = buildApplicationWhere(
    baseFilters({ referralChannel: evil, status: "PENDING" }),
    ["6f9619ff-8b86-d011-b42d-00c04fc964ff"],
  );
  assert.ok(!where.includes("DROP TABLE"), "user input must never appear in SQL text");
  assert.ok(params.includes(evil), "user input must be passed as parameter");
  // đếm placeholder khớp số param
  const placeholders = new Set(where.match(/\$\d+/g));
  assert.equal(placeholders.size, params.length);
});

test("buildApplicationWhere: deptIds=[] sinh điều kiện FALSE (scope rỗng không thấy gì)", () => {
  const { where } = buildApplicationWhere(baseFilters(), []);
  assert.ok(where.includes("FALSE"));
});

test("buildApplicationWhere: deptIds=null không có điều kiện dept (xem toàn bộ)", () => {
  const { where } = buildApplicationWhere(baseFilters(), null);
  assert.ok(!where.includes("dept_id"));
});

/* ---------------- 5,6. Worker type / unknown referral filters ---------------- */

test("workerType NEW/RETURNING map đúng dw_match (server-side classification)", () => {
  const newW = buildApplicationWhere(baseFilters({ workerType: "NEW" }), null);
  assert.ok(newW.where.includes("dw_match <> 'MATCHED'"));
  const ret = buildApplicationWhere(baseFilters({ workerType: "RETURNING" }), null);
  assert.ok(ret.where.includes("dw_match = 'MATCHED'"));
});

test("referralChannel=UNKNOWN lọc null/blank (test missing dimension)", () => {
  const { where } = buildApplicationWhere(baseFilters({ referralChannel: UNKNOWN_REFERRAL }), null);
  assert.ok(where.includes("referral_channel IS NULL"));
});

/* ---------------- 7,8. Funnel & referral conversion ---------------- */

test("conversionPct: đúng công thức, null khi mẫu = 0", () => {
  assert.equal(conversionPct(200, 50), 25);
  assert.equal(conversionPct(3, 1), 33.3);
  assert.equal(conversionPct(0, 0), null);
  assert.equal(conversionPct(0, 5), null);
});

test("funnel conversion chain: App→Processed→Approved→Started", () => {
  const app = 100, processed = 80, approved = 40, started = 30;
  assert.equal(conversionPct(app, processed), 80);
  assert.equal(conversionPct(processed, approved), 50);
  assert.equal(conversionPct(approved, started), 75);
  assert.equal(conversionPct(app, started), 30); // overall
});

/* ---------------- KPI comparison ---------------- */

test("pctChange/makeKpi: hướng và % đúng; previous=0 không chia 0", () => {
  assert.equal(pctChange(120, 100), 20);
  assert.equal(pctChange(80, 100), -20);
  assert.equal(pctChange(0, 0), 0);
  assert.equal(pctChange(5, 0), null);
  assert.equal(pctChange(10, null), null);

  const up = makeKpi(120, 100, "up");
  assert.equal(up.direction, "up");
  assert.equal(up.changePct, 20);

  const shortage = makeKpi(50, 40, "down"); // tăng shortage là XẤU
  assert.equal(shortage.direction, "up");
  assert.equal(shortage.goodWhen, "down");

  const noPrev = makeKpi(10, null, "neutral");
  assert.equal(noPrev.direction, "flat");
  assert.equal(noPrev.changePct, null);
});

/* ---------------- Demographics / distribution ---------------- */

test("ageBucket: đúng ranh giới + Unknown cho giá trị bất thường", () => {
  assert.equal(ageBucket(17), "<18");
  assert.equal(ageBucket(18), "18–24");
  assert.equal(ageBucket(24), "18–24");
  assert.equal(ageBucket(25), "25–34");
  assert.equal(ageBucket(34), "25–34");
  assert.equal(ageBucket(35), "35–44");
  assert.equal(ageBucket(45), "45–54");
  assert.equal(ageBucket(55), "55+");
  assert.equal(ageBucket(null), "Không rõ");
  assert.equal(ageBucket(0), "Không rõ");
  assert.equal(ageBucket(150), "Không rõ");
});

test("sessionCountBucketIndex: 1 / 2 / 3 / 4+", () => {
  assert.equal(sessionCountBucketIndex(1), 0);
  assert.equal(sessionCountBucketIndex(2), 1);
  assert.equal(sessionCountBucketIndex(3), 2);
  assert.equal(sessionCountBucketIndex(4), 3);
  assert.equal(sessionCountBucketIndex(9), 3);
});
