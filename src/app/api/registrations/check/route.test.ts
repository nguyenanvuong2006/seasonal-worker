/**
 * Tests for POST /api/registrations/check
 * ============================================================
 * Schema drift fix (2026-09-24): departments.vn_name was missing in Production,
 * causing this route to fail with a Postgres column-not-found error.
 *
 * Test coverage required by mission spec sections 9 & 10:
 *  1. Works when no registration exists for today (→ NEW or RETURNING_VERIFIED)
 *  2. Works when a same-day registration exists (→ ALREADY_REGISTERED_TODAY)
 *  3. Same-day response includes full_name, status, dept_name, dept_location
 *  4. null vnName handled safely (dept_location: null, not crash)
 *  5. DB/query failure returns a generic public error (no SQL text)
 *  6. Public 500 response does NOT expose SQL text (SELECT/table names/params)
 *  7. No CCCD or phone values leak in server-logged error payloads
 *  8. Returning-worker matching path (RETURNING_VERIFIED) is unchanged
 *
 * Uses node:vm sandbox + TypeScript transpile so we test the real route
 * source without requiring a live database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const routeFile = new URL(
  "../../../../app/api/registrations/check/route.ts",
  import.meta.url,
);
const routeSource = readFileSync(fileURLToPath(routeFile), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
}).outputText;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): Request {
  return {
    json: async () => body,
  } as unknown as Request;
}

type RouteModule = { POST: (req: Request) => Promise<Response> };

/**
 * Load the route into a vm sandbox with controllable stubs.
 * `dbSelectRows`  – rows returned by the daily_applications query
 * `matchResult`   – object returned by matchDwWorker()
 * `activeSession` – value returned by findActiveSessionByCccd()
 * `throwOnDb`     – if true, db.select() chain throws an Error
 * `dbError`       – error to throw when throwOnDb=true (defaults to generic Error with SQL-looking message)
 */
function loadRoute({
  dbSelectRows = [] as Record<string, unknown>[],
  matchResult = { status: "NEW", confidence: "NONE" },
  activeSession = null as null | { deptName: string; groupName: string; startingDate: string },
  throwOnDb = false,
  dbError = null as null | Error,
}: {
  dbSelectRows?: Record<string, unknown>[];
  matchResult?: { status: string; confidence: string; worker?: { fullName: string; residentialAddress?: string; permanentAddress?: string } };
  activeSession?: null | { deptName: string; groupName: string; startingDate: string };
  throwOnDb?: boolean;
  dbError?: null | Error;
} = {}): RouteModule {
  const fakeChain = {
    select: () => fakeChain,
    from: () => fakeChain,
    leftJoin: () => fakeChain,
    where: () => fakeChain,
    limit: () => {
      if (throwOnDb) {
        const err = dbError ?? new Error(
          // Simulate a Postgres column-not-found error containing SQL text
          'column "departments"."vn_name" does not exist\nSELECT "daily_applications"."full_name", "departments"."vn_name" FROM "daily_applications"',
        );
        return Promise.reject(err);
      }
      return Promise.resolve(dbSelectRows);
    },
  };

  const mockModule: Record<string, unknown> = {};
  const mockRequire = (id: string): unknown => {
    if (id === "next/server") {
      return {
        NextResponse: {
          json: (body: unknown, init?: { status?: number }) => ({
            _body: body,
            status: init?.status ?? 200,
            json: async () => body,
          }),
        },
      };
    }
    if (id === "drizzle-orm") {
      return { and: () => "and-cond", eq: () => "eq-cond" };
    }
    if (id === "@/db") {
      return { db: fakeChain };
    }
    if (id === "@/db/schema") {
      return {
        dailyApplications: new Proxy({}, { get: (_, p) => ({ __col: String(p) }) }),
        departments: new Proxy({}, { get: (_, p) => ({ __col: String(p) }) }),
      };
    }
    if (id === "@/lib/matching") {
      return { matchDwWorker: async () => matchResult };
    }
    if (id === "@/lib/employment") {
      return { findActiveSessionByCccd: async () => activeSession };
    }
    if (id === "@/lib/helpers") {
      return { todayStr: () => "2026-09-24" };
    }
    if (id === "@/lib/person-name") {
      return { normalizePersonName: (s: string) => s };
    }
    if (id === "@/lib/validators") {
      return {
        isValidCccd: (s: string) => /^\d{12}$/.test(s),
        CCCD_ERROR_MESSAGE: "CCCD không hợp lệ.",
      };
    }
    throw new Error(`Unexpected require("${id}") in check/route sandbox`);
  };

  const ctx = vm.createContext({
    module: mockModule,
    exports: mockModule,
    require: mockRequire,
    console,
    process,
    Promise,
  });
  vm.runInContext(jsSource, ctx);
  return mockModule as unknown as RouteModule;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const VALID_CCCD = "123456789012"; // 12-digit
const VALID_PHONE = "0901234567";

test("check route: returns NEW when no same-day registration and no DW match", async () => {
  const { POST } = loadRoute({
    dbSelectRows: [],
    matchResult: { status: "NEW", confidence: "NONE" },
  });
  const resp = await POST(makeRequest({ cccd: VALID_CCCD, phone: VALID_PHONE }));
  const body = await resp.json();
  assert.equal(body.status, "NEW");
  assert.equal(resp.status, 200);
});

test("check route: returns RETURNING_VERIFIED when DW match is MATCHED+CCCD confidence", async () => {
  const { POST } = loadRoute({
    dbSelectRows: [],
    matchResult: {
      status: "MATCHED",
      confidence: "CCCD",
      worker: { fullName: "NGUYỄN VĂN A", residentialAddress: "123 Đường ABC" },
    },
  });
  const resp = await POST(makeRequest({ cccd: VALID_CCCD, phone: VALID_PHONE }));
  const body = await resp.json();
  assert.equal(body.status, "RETURNING_VERIFIED");
  assert.ok(body.worker?.full_name, "returning worker must have full_name");
  // Must NOT expose raw PII fields like gender, DOB, phone
  assert.ok(!body.worker?.gender, "must not expose gender");
  assert.ok(!body.worker?.dob, "must not expose date of birth");
  assert.ok(!body.worker?.phone, "must not expose phone");
});

test("check route: ALREADY_REGISTERED_TODAY with dept_name and dept_location present", async () => {
  const { POST } = loadRoute({
    dbSelectRows: [
      {
        fullName: "TRẦN THỊ B",
        status: "PENDING",
        deptName: "Packing",
        groupName: "A",
        vnName: "Đà Lạt",
      },
    ],
    matchResult: { status: "NEW", confidence: "NONE" },
  });
  const resp = await POST(makeRequest({ cccd: VALID_CCCD, phone: VALID_PHONE }));
  const body = await resp.json();
  assert.equal(body.status, "ALREADY_REGISTERED_TODAY");
  assert.ok(body.reg?.full_name, "must have full_name");
  assert.ok((body.reg?.dept_name as string)?.includes("Packing"), "must have dept_name");
  assert.equal(body.reg?.dept_location, "Đà Lạt", "dept_location must equal vnName value");
  assert.equal(resp.status, 200);
});

test("check route: ALREADY_REGISTERED_TODAY with null vnName — dept_location is null, not crash", async () => {
  const { POST } = loadRoute({
    dbSelectRows: [
      {
        fullName: "LÊ VĂN C",
        status: "APPROVED",
        deptName: "Rose",
        groupName: "",
        vnName: null,
      },
    ],
    matchResult: { status: "NEW", confidence: "NONE" },
  });
  const resp = await POST(makeRequest({ cccd: VALID_CCCD, phone: VALID_PHONE }));
  const body = await resp.json();
  assert.equal(body.status, "ALREADY_REGISTERED_TODAY");
  assert.equal(body.reg?.dept_location, null, "null vnName must produce null dept_location");
});

test("check route: DB failure returns generic Vietnamese public error (no SQL text)", async () => {
  const logs: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.join(" ")); };

  try {
    const { POST } = loadRoute({ throwOnDb: true });
    const resp = await POST(makeRequest({ cccd: VALID_CCCD, phone: VALID_PHONE }));
    const body = await resp.json();

    // Public response must be generic
    assert.equal(resp.status, 500);
    assert.ok(body.error, "error field must exist");

    // Must NOT expose SQL text in the public response
    const errorText = String(body.error);
    assert.ok(!errorText.includes("SELECT"), "public error must not contain SELECT");
    assert.ok(!errorText.includes("daily_applications"), "public error must not contain table name");
    assert.ok(!errorText.includes("departments"), "public error must not contain table name");
    assert.ok(!errorText.includes("vn_name"), "public error must not contain column name");
    assert.ok(!errorText.includes("column"), "public error must not contain 'column'");

    // Public error must be a user-friendly Vietnamese message
    assert.ok(
      errorText.includes("Lỗi hệ thống") && !errorText.includes("SELECT"),
      `public error should be generic Vietnamese message, got: ${errorText}`,
    );
  } finally {
    console.error = origConsoleError;
  }
});

test("check route: server log on DB failure does NOT contain CCCD or phone", async () => {
  const serverLogs: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => { serverLogs.push(args.join(" ")); };

  try {
    const { POST } = loadRoute({ throwOnDb: true });
    await POST(makeRequest({ cccd: VALID_CCCD, phone: VALID_PHONE }));

    const allLogs = serverLogs.join("\n");
    assert.ok(!allLogs.includes(VALID_CCCD), "server log must not contain CCCD value");
    assert.ok(!allLogs.includes(VALID_PHONE), "server log must not contain phone value");
  } finally {
    console.error = origConsoleError;
  }
});

test("check route: server log on DB failure contains sanitized route+error metadata", async () => {
  const serverLogs: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => { serverLogs.push(args.join(" ")); };

  try {
    const { POST } = loadRoute({
      throwOnDb: true,
      dbError: Object.assign(new Error("column vn_name does not exist"), { code: "42703" }),
    });
    await POST(makeRequest({ cccd: VALID_CCCD, phone: VALID_PHONE }));

    const allLogs = serverLogs.join("\n");
    // Route identifier must appear (allows operators to locate the log line)
    assert.ok(allLogs.includes("/api/registrations/check"), "log must identify route path");
    // Postgres error code must appear (42703 = undefined_column)
    assert.ok(allLogs.includes("42703"), "log must contain Postgres error code");
  } finally {
    console.error = origConsoleError;
  }
});

test("check route: invalid CCCD returns 400 with validation error (no DB hit)", async () => {
  const { POST } = loadRoute({ throwOnDb: true }); // throw if DB is touched = test guard
  const resp = await POST(makeRequest({ cccd: "123", phone: VALID_PHONE }));
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.ok(body.error, "must have error field for invalid CCCD");
});

test("check route: invalid phone returns 400 (no DB hit)", async () => {
  const { POST } = loadRoute({ throwOnDb: true });
  const resp = await POST(makeRequest({ cccd: VALID_CCCD, phone: "abc" }));
  assert.equal(resp.status, 400);
});

test("check route: ALREADY_REGISTERED_TODAY with groupName appended to dept_name", async () => {
  const { POST } = loadRoute({
    dbSelectRows: [
      {
        fullName: "PHẠM THỊ D",
        status: "APPROVED",
        deptName: "Cutting",
        groupName: "B",
        vnName: null,
      },
    ],
    matchResult: { status: "NEW", confidence: "NONE" },
  });
  const resp = await POST(makeRequest({ cccd: VALID_CCCD, phone: VALID_PHONE }));
  const body = await resp.json();
  assert.equal(body.status, "ALREADY_REGISTERED_TODAY");
  assert.ok(
    (body.reg?.dept_name as string)?.includes("Cutting") &&
    (body.reg?.dept_name as string)?.includes("B"),
    "dept_name must combine deptName + groupName",
  );
});

test("check route: returning-worker active_employment payload is included when session exists", async () => {
  const { POST } = loadRoute({
    dbSelectRows: [],
    matchResult: {
      status: "MATCHED",
      confidence: "CCCD",
      worker: { fullName: "VÕ VĂN E", residentialAddress: "456 Phố XYZ" },
    },
    activeSession: { deptName: "Packing", groupName: "C", startingDate: "2026-09-01" },
  });
  const resp = await POST(makeRequest({ cccd: VALID_CCCD, phone: VALID_PHONE }));
  const body = await resp.json();
  assert.equal(body.status, "RETURNING_VERIFIED");
  assert.ok(body.active_employment, "active_employment must be present");
  assert.ok(
    (body.active_employment?.dept_name as string)?.includes("Packing"),
    "active_employment.dept_name must include department name",
  );
  assert.equal(body.active_employment?.starting_date, "2026-09-01");
});
