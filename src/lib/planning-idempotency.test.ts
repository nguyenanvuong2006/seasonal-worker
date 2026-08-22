import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, type FakeDb } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/* ============================================================
   A2 (Production Recovery audit) — createPeriod() idempotency
   ------------------------------------------------------------
   Chạy trên ĐÚNG src/lib/planning.ts.

   Trước đây createPeriod() không có guard nào chống double-submit:
   double-click / fetch-retry gửi 2 POST giống hệt nhau tạo 2
   planning_periods ACTIVE độc lập, cả 2 supersededBy=null → mọi
   aggregate CỘNG DỒN, nhân đôi demand đã báo cáo.

   Fix: debounce theo nội dung + người tạo trong cửa sổ 15 giây —
   double-submit trả về bản ghi đã có; submit thật sự khác nhau
   (khác nội dung, khác người, hoặc ngoài cửa sổ) vẫn tạo bình thường.
   ============================================================ */

const schemaStub = {
  departments: makeTable("departments"),
  planningPeriods: makeTable("planning_periods"),
  planningTargets: makeTable("planning_targets"),
};

function load(db: FakeDb) {
  return loadModule(new URL("./planning.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": {
        todayStr: () => "2026-08-16",
        isMale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("M"),
        isFemale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("F"),
      },
      "@/lib/person-name": { normalizePersonName: (v: string) => v },
      "@/lib/workforce-request": { mirrorPlanningAllocationToRequest: async () => false },
    },
    fallback(spec) {
      throw new Error(`Unexpected require("${spec}")`);
    },
  });
}

type CreatePeriodInput = {
  departmentId: string;
  startDate: string;
  endDate: string;
  demandMale: number;
  demandFemale: number;
  requestType?: "ORIGINAL" | "SUPPLEMENT";
  createdBy: string;
  activateNow?: boolean;
};
type CreatePeriodFn = (input: CreatePeriodInput) => Promise<{ id: string }>;

function baseInput(overrides: Partial<CreatePeriodInput> = {}): CreatePeriodInput {
  return {
    departmentId: "dept-A",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    demandMale: 10,
    demandFemale: 5,
    createdBy: "recruiter-1",
    activateNow: true,
    ...overrides,
  };
}

test("createPeriod: double-submit giống hệt trong cửa sổ debounce → trả về period đã có, KHÔNG tạo bản ghi thứ 2", async () => {
  const recentlyCreated = { id: "period-1", createdAt: new Date() };
  let insertCount = 0;
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "departments") return [{ id: "dept-A", section: null, groupName: null, location: "Đà Lạt", division: "Prod" }];
      if (call.root === "select" && call.table === "planning_periods") return [recentlyCreated];
      if (call.root === "insert" && call.table === "planning_periods") {
        insertCount += 1;
        return [{ id: `new-${insertCount}` }];
      }
      return undefined;
    },
  });
  const mod = load(db);

  const result = await (mod.createPeriod as CreatePeriodFn)(baseInput());

  assert.equal(result.id, "period-1", "phải trả về bản ghi đã tồn tại, không tạo mới");
  assert.equal(insertCount, 0, "KHÔNG được INSERT thêm khi phát hiện double-submit");
});

test("createPeriod: không có bản ghi trùng gần đây → tạo mới bình thường", async () => {
  let insertCount = 0;
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "departments") return [{ id: "dept-A", section: null, groupName: null, location: "Đà Lạt", division: "Prod" }];
      if (call.root === "select" && call.table === "planning_periods") return []; // không có duplicate
      if (call.root === "insert" && call.table === "planning_periods") {
        insertCount += 1;
        return [{ id: "new-period-1" }];
      }
      return undefined;
    },
  });
  const mod = load(db);

  const result = await (mod.createPeriod as CreatePeriodFn)(baseInput());

  assert.equal(result.id, "new-period-1");
  assert.equal(insertCount, 1, "phải tạo đúng 1 bản ghi mới");
});

test("createPeriod: guard chạy trong transaction (không phải 2 round-trip tách rời không an toàn)", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "departments") return [{ id: "dept-A", section: null, groupName: null, location: "Đà Lạt", division: "Prod" }];
      if (call.root === "select" && call.table === "planning_periods") return [];
      if (call.root === "insert" && call.table === "planning_periods") return [{ id: "new-period-1" }];
      return undefined;
    },
  });
  const mod = load(db);

  await (mod.createPeriod as CreatePeriodFn)(baseInput());

  assert.equal(db.transactions, 1, "check-rồi-insert phải nằm trong 1 transaction");
});
