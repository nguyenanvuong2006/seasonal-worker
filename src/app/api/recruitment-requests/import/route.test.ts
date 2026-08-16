import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ PHÂN QUYỀN & DATA SCOPE Ở TẦNG ROUTE
   ------------------------------------------------------------
   Chạy trên ĐÚNG route thật, theo khuôn mẫu đã dùng ở
   src/app/api/cron/run/route.test.ts.

   Bao phủ:
     • DEPT_MANAGER KHÔNG được import/dán Excel   (Yêu cầu #3, #11)
     • Chặn ở SERVER, không chỉ ẩn nút trên UI    (Yêu cầu #15)
     • Dòng ngoài Data Scope bị loại theo department_id
   ============================================================ */

type Guard =
  | { ok: true; session: { userId: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

type Harness = {
  handlers: Record<string, (req: unknown) => Promise<{ status: number; body: Record<string, unknown> }>>;
  imported: unknown[][];
  audits: { action: string; detail: Record<string, unknown> }[];
  permissionChecks: { roles: string[]; key: string }[];
};

function loadRoute(opts: {
  /** Mô phỏng RBAC: trả về guard theo vai trò/quyền được yêu cầu. */
  guardFor: (roles: string[], key: string) => Guard;
  scope: string[] | null;
  /** Bản đồ tên phòng ban → id, dùng cho matchHierarchy giả. */
  deptMap?: Record<string, string>;
}): Harness {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const imported: unknown[][] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const permissionChecks: { roles: string[]; key: string }[] = [];
  const deptMap = opts.deptMap ?? { "Farm A": "dept-A", "Farm B": "dept-B", "Farm Z": "dept-Z" };

  const utils = loadPlain(new URL("../../../../lib/recruitment-request-utils.ts", import.meta.url));

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: {
        json: (body: Record<string, unknown>, init?: { status?: number }) => ({
          status: init?.status ?? 200,
          body,
        }),
      },
    },
    "@/lib/auth": {
      requirePermission: async (roles: string[], key: string) => {
        permissionChecks.push({ roles, key });
        return opts.guardFor(roles, key);
      },
      getUserScope: async () => opts.scope,
      writeAudit: async (_s: unknown, action: string, _t: string, detail: Record<string, unknown>) => {
        audits.push({ action, detail });
      },
    },
    "@/lib/recruitment-request": {
      importRecruitmentRequests: async (rows: unknown[]) => {
        imported.push(rows);
        return rows.map((_r, i) => ({ rowIndex: i + 1, status: "INSERTED", requestCode: `R${i}` }));
      },
      matchHierarchy: async (
        _loc: string,
        _div: string,
        dept: string,
      ) => ({ deptId: deptMap[dept] ?? null, matched: Boolean(deptMap[dept]) }),
      mapRowToCanonical: utils.mapRowToCanonical,
      validateRow: utils.validateRow,
      resolveHeaderAlias: utils.resolveHeaderAlias,
      normalizeHeaderName: utils.normalizeHeaderName,
      HEADER_ALIASES: utils.HEADER_ALIASES,
    },
    "@/lib/file-parser": {
      parseImportFile: async () => ({ rows: [], headers: [] }),
    },
  };

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (spec: string) => {
      if (spec in stubs) return stubs[spec];
      throw new Error(`Unexpected require("${spec}")`);
    },
    console,
    process,
    Buffer,
    Date,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Error,
    isNaN,
    parseInt,
    parseFloat,
  });
  vm.runInContext(js, context);

  return {
    handlers: moduleObj.exports as Harness["handlers"],
    imported,
    audits,
    permissionChecks,
  };
}

function loadPlain(url: URL): Record<string, ReturnType<typeof Function>> {
  const js = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const m = { exports: {} as Record<string, ReturnType<typeof Function>> };
  vm.runInContext(
    js,
    vm.createContext({
      module: m,
      exports: m.exports,
      require: () => ({}),
      console,
      Date,
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Set,
      Map,
      Error,
      isNaN,
      parseInt,
      parseFloat,
    }),
  );
  return m.exports;
}

/**
 * Route nhận `rawData` là mảng bản ghi đã tách cột (grid dán từ Excel đã được
 * client parse sẵn), nên helper này dựng đúng hình dạng đó — kèm dòng header
 * để kích hoạt cơ chế tự nhận diện header của route.
 */
function grid(rows: string[][]): Record<string, string>[] {
  return rows.map((r) => {
    const o: Record<string, string> = {};
    HEADER.forEach((h, i) => {
      o[h] = r[i] ?? "";
    });
    return o;
  });
}

const HEADER = ["Request Code", "Requester", "Location", "Division", "Department", "Male Rq", "Female Rq"];

function makeRequest(body: Record<string, unknown>) {
  return { json: async () => body };
}

/* ------------------------------------------------------------ */

test("route import yêu cầu quyền planning.import và KHÔNG chấp nhận DEPT_MANAGER", async () => {
  const h = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "HR_RECRUITER", username: "recruiter1" } }),
    scope: null,
  });

  await h.handlers.POST(
    makeRequest({ action: "import", rawData: grid([HEADER, ["RQ-1", "A", "Đà Lạt", "P", "Farm A", "2", "1"]]) }),
  );

  assert.equal(h.permissionChecks.length, 1);
  const check = h.permissionChecks[0];
  // Quyền riêng cho việc import, tách khỏi planning.request.
  assert.equal(check.key, "planning.import");
  assert.ok(!check.roles.includes("DEPT_MANAGER"), "DEPT_MANAGER không được nằm trong danh sách vai trò cho phép");
  // Array.from để so sánh trong cùng realm (mảng gốc sinh ra trong vm).
  assert.deepEqual(Array.from(check.roles).sort(), ["ADMIN", "HR_RECRUITER"]);
});

test("DEPT_MANAGER bị chặn ở SERVER với 403, không có dòng nào được import", async () => {
  const h = loadRoute({
    // RBAC thật sẽ từ chối vì DEPT_MANAGER không có planning.import.
    guardFor: () => ({ ok: false, status: 403, error: "Không có quyền" }),
    scope: ["dept-A"],
  });

  const res = await h.handlers.POST(
    makeRequest({ action: "import", rawData: grid([HEADER, ["RQ-1", "A", "Đà Lạt", "P", "Farm A", "2", "1"]]) }),
  );

  assert.equal(res.status, 403);
  assert.equal(h.imported.length, 0, "không được gọi hàm import");
  assert.equal(h.audits.length, 0);
});

test("DEPT_MANAGER cũng bị chặn ở chế độ xem trước (preview)", async () => {
  const h = loadRoute({
    guardFor: () => ({ ok: false, status: 403, error: "Không có quyền" }),
    scope: ["dept-A"],
  });

  const res = await h.handlers.POST(
    makeRequest({ action: "preview", rawData: grid([HEADER, ["RQ-1", "A", "Đà Lạt", "P", "Farm A", "2", "1"]]) }),
  );

  assert.equal(res.status, 403);
  assert.equal(h.imported.length, 0);
});

test("HR_RECRUITER chỉ import được dòng thuộc Data Scope của mình", async () => {
  const h = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "HR_RECRUITER", username: "recruiter1" } }),
    scope: ["dept-A"], // chỉ được Farm A
  });

  const res = await h.handlers.POST(
    makeRequest({
      action: "import",
      rawData: grid([
        HEADER,
        ["RQ-1", "A", "Đà Lạt", "P", "Farm A", "2", "1"],
        ["RQ-2", "B", "Đà Lạt", "P", "Farm B", "3", "0"], // ngoài phạm vi
        ["RQ-3", "C", "Đà Lạt", "P", "Farm A", "1", "1"],
      ]),
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(h.imported.length, 1);
  const rows = h.imported[0] as Record<string, string>[];
  assert.equal(rows.length, 2, "chỉ 2 dòng thuộc Farm A được import");
  assert.ok(rows.every((r) => r["Department"] === "Farm A"));
  assert.equal(res.body.outOfScope, 1, "phải báo lại số dòng bị loại");
});

test("dòng có phòng ban không khớp cây tổ chức bị loại khỏi phạm vi", async () => {
  const h = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "HR_RECRUITER", username: "recruiter1" } }),
    scope: ["dept-A"],
    deptMap: { "Farm A": "dept-A" }, // "Phòng Lạ" không tồn tại
  });

  await h.handlers.POST(
    makeRequest({
      action: "import",
      rawData: grid([
        HEADER,
        ["RQ-1", "A", "Đà Lạt", "P", "Farm A", "2", "1"],
        ["RQ-2", "B", "Đà Lạt", "P", "Phòng Lạ", "3", "0"],
      ]),
    }),
  );

  const rows = h.imported[0] as Record<string, string>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["Department"], "Farm A");
});

test("tài khoản chưa được cấp Data Scope nào thì không import được gì", async () => {
  const h = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "HR_RECRUITER", username: "recruiter1" } }),
    scope: [], // rỗng = không có phạm vi
  });

  const res = await h.handlers.POST(
    makeRequest({ action: "import", rawData: grid([HEADER, ["RQ-1", "A", "Đà Lạt", "P", "Farm A", "2", "1"]]) }),
  );

  assert.equal(res.status, 403);
  assert.equal(h.imported.length, 0);
});

test("ADMIN không bị giới hạn phạm vi (scope null) và import được mọi phòng ban", async () => {
  const h = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "admin", role: "ADMIN", username: "admin" } }),
    scope: null,
  });

  const res = await h.handlers.POST(
    makeRequest({
      action: "import",
      rawData: grid([
        HEADER,
        ["RQ-1", "A", "Đà Lạt", "P", "Farm A", "2", "1"],
        ["RQ-2", "B", "Đà Lạt", "P", "Farm B", "3", "0"],
        ["RQ-3", "C", "Đà Lạt", "P", "Farm Z", "1", "1"],
      ]),
    }),
  );

  assert.equal(res.status, 200);
  assert.equal((h.imported[0] as unknown[]).length, 3);
  assert.equal(res.body.outOfScope, 0);
});

test("mọi lần import đều để lại dấu vết kiểm toán", async () => {
  const h = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "HR_RECRUITER", username: "recruiter1" } }),
    scope: null,
  });

  await h.handlers.POST(
    makeRequest({ action: "import", rawData: grid([HEADER, ["RQ-1", "A", "Đà Lạt", "P", "Farm A", "2", "1"]]) }),
  );

  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].action, "IMPORT_RECRUITMENT_REQUESTS");
  assert.ok("totalRows" in h.audits[0].detail);
  assert.ok("outOfScope" in h.audits[0].detail);
});

test("xem trước không ghi dữ liệu, chỉ trả về kết quả kiểm tra", async () => {
  const h = loadRoute({
    guardFor: () => ({ ok: true, session: { userId: "u1", role: "HR_RECRUITER", username: "recruiter1" } }),
    scope: null,
  });

  const res = await h.handlers.POST(
    makeRequest({
      action: "preview",
      rawData: grid([HEADER, ["RQ-1", "A", "Đà Lạt", "P", "Farm A", "2", "1"]]),
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(h.imported.length, 0, "preview tuyệt đối không được ghi");
  assert.equal(h.audits.length, 0);
});
