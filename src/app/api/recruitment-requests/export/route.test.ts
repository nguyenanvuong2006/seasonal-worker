import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ TẦNG ROUTE — GET /api/recruitment-requests/export (flat list)
   ------------------------------------------------------------
   Phase 2B mục 6 refactor: Recruited/Quit/Transfer Out/Balance phải đọc từ
   `.kpi.*` (batchComputeRequestKpis + resolveDefaultAsOf — ĐÚNG 1 engine
   dùng chung với GET /api/recruitment-requests), KHÔNG còn đọc trực tiếp
   cột tĩnh cũ trên row. Styling dùng chung addStyledSheet() (không mock
   thật ExcelJS ở đây — chỉ chứng minh route TRUYỀN ĐÚNG dữ liệu).
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string; fullName: string } }
  | { ok: false; status: number; error: string };

function loadRoute(opts: {
  hasPermission?: boolean;
  scope: string[] | null;
  rows: { id: string; requestCode: string; status: string; endDate: string | null; completedDate: string | null; updatedAt: Date; createdAt: Date; maleRecruited: number; femaleRecruited: number; maleQuit: number; femaleQuit: number; maleBalance: number; femaleBalance: number; totalBalance: number }[];
  kpis?: Map<string, Record<string, number>>;
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const listCalls: { filter: Record<string, unknown> }[] = [];
  const kpiCalls: { rows: unknown[] }[] = [];
  const audits: { action: string; details: Record<string, unknown> }[] = [];
  const sheetsBuilt: { sheetName: string; rows: unknown[] }[] = [];
  const SESSION = { id: "u1", role: "ADMIN", username: "admin1", fullName: "Admin One" };

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: class {
        status: number;
        body: unknown;
        headers: Record<string, string>;
        constructor(body: unknown, init?: { headers?: Record<string, string>; status?: number }) {
          this.body = body;
          this.status = init?.status ?? 200;
          this.headers = init?.headers ?? {};
        }
        static json(body: Record<string, unknown>, init?: { status?: number }) {
          return { status: init?.status ?? 200, body };
        }
      },
    },
    "@/lib/auth": {
      getSession: async () => SESSION,
      getUserScope: async () => opts.scope,
      hasPermission: async () => opts.hasPermission ?? true,
      writeAudit: async (_s: unknown, action: string, _t: string, details: Record<string, unknown>) => {
        audits.push({ action, details });
      },
    },
    "@/lib/excel-workbook-style": {
      createStyledWorkbook: () => ({ __fake: "workbook" }),
      addStyledSheet: (_wb: unknown, o: { sheetName: string; rows: unknown[] }) => {
        sheetsBuilt.push({ sheetName: o.sheetName, rows: o.rows });
      },
      workbookToBuffer: async () => Buffer.from("fake-xlsx"),
    },
    "@/lib/helpers": { todayStr: () => "2026-09-11" },
    "@/lib/recruitment-request": {
      listRecruitmentRequests: async (filter: Record<string, unknown>) => {
        listCalls.push({ filter });
        return { rows: opts.rows, total: opts.rows.length };
      },
    },
    "@/lib/workforce-request": {
      batchComputeRequestKpis: async (rows: unknown[]) => {
        kpiCalls.push({ rows });
        return opts.kpis ?? new Map();
      },
    },
    "@/lib/workforce-request-kpi": {
      resolveDefaultAsOf: (r: { status: string; endDate: string | null; completedDate: string | null; updatedAt: Date }, today: string) => {
        if (r.status === "EXPIRED" || r.status === "COMPLETED" || r.status === "CANCELLED") {
          return r.endDate ?? r.completedDate ?? r.updatedAt.toISOString().slice(0, 10);
        }
        return today;
      },
    },
  };

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      if (id in stubs) return stubs[id];
      throw new Error(`Unexpected require("${id}")`);
    },
    process,
    URL,
    Date,
    Buffer,
    Uint8Array,
    Map,
    console,
    isNaN,
  });
  vm.runInContext(js, context);

  return { mod: moduleObj.exports, listCalls, kpiCalls, audits, sheetsBuilt };
}

function makeReq(qs = ""): Request {
  return { url: `https://app.example/api/recruitment-requests/export${qs}` } as unknown as Request;
}

function baseRow(id: string, overrides: Partial<Parameters<typeof loadRoute>[0]["rows"][number]> = {}) {
  return {
    id,
    requestCode: `RQ-${id}`,
    status: "PENDING",
    endDate: null,
    completedDate: null,
    updatedAt: new Date("2026-09-01"),
    createdAt: new Date("2026-09-01"),
    maleRecruited: 999,
    femaleRecruited: 999,
    maleQuit: 999,
    femaleQuit: 999,
    maleBalance: 999,
    femaleBalance: 999,
    totalBalance: 999,
    ...overrides,
  };
}

test("403 không có quyền planning.view -> KHÔNG gọi listRecruitmentRequests", async () => {
  const { mod, listCalls } = loadRoute({ hasPermission: false, scope: null, rows: [] });
  const GET = mod.GET as (req: Request) => Promise<{ status: number }>;
  const res = await GET(makeReq());
  assert.equal(res.status, 403);
  assert.equal(listCalls.length, 0);
});

test("Recruited/Quit/Balance trong sheet đọc từ .kpi.* (canonical engine), KHÔNG đọc cột tĩnh cũ trên row (999 là bẫy)", async () => {
  const row = baseRow("r1");
  const kpi = { maleRecruited: 3, femaleRecruited: 2, maleQuit: 1, femaleQuit: 0, maleTransferOut: 1, femaleTransferOut: 0, maleBalance: 4, femaleBalance: 5, totalBalance: 9 };
  const { mod, sheetsBuilt } = loadRoute({ scope: null, rows: [row], kpis: new Map([["r1", kpi]]) });
  const GET = mod.GET as (req: Request) => Promise<{ status: number }>;
  const res = await GET(makeReq());

  assert.equal(res.status, 200);
  const sheetRows = sheetsBuilt[0].rows as { kpi: typeof kpi }[];
  assert.equal(sheetRows.length, 1);
  assert.equal(sheetRows[0].kpi.maleRecruited, 3);
  assert.equal(sheetRows[0].kpi.maleBalance, 4);
  assert.notEqual(sheetRows[0].kpi.maleRecruited, 999, "route KHÔNG được đọc cột tĩnh male_recruited cũ trên row, phải dùng .kpi.*");
});

test("audit được ghi mỗi lần export với số dòng đúng", async () => {
  const { mod, audits } = loadRoute({ scope: null, rows: [baseRow("r1"), baseRow("r2")], kpis: new Map() });
  const GET = mod.GET as (req: Request) => Promise<{ status: number }>;
  await GET(makeReq());
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "EXPORT_RECRUITMENT_REQUESTS");
  assert.equal(audits[0].details.rows, 2);
});

test("Data Scope được truyền xuống listRecruitmentRequests filter.scope — không mở rộng ngoài phạm vi", async () => {
  const { mod, listCalls } = loadRoute({ scope: ["dept-A"], rows: [] });
  const GET = mod.GET as (req: Request) => Promise<{ status: number }>;
  await GET(makeReq());
  assert.deepEqual(listCalls[0].filter.scope, ["dept-A"]);
});

test("request EXPIRED -> KPI được tính tại asOf=endDate (đóng băng), không phải today — resolveDefaultAsOf dùng chung với GET list", async () => {
  const row = baseRow("r1", { status: "EXPIRED", endDate: "2026-08-15" });
  const { mod, kpiCalls } = loadRoute({ scope: null, rows: [row], kpis: new Map() });
  const GET = mod.GET as (req: Request) => Promise<{ status: number }>;
  await GET(makeReq());
  assert.equal(kpiCalls.length, 1);
  assert.equal(kpiCalls[0].rows.length, 1);
});
