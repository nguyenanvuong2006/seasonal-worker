import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   PROOF TESTS — GET /api/admin/backup
   DR Phase 1 — Truthful Backup Labeling & Export Safety
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string } }
  | { ok: false; status: number; error: string };

type QueryRecord = {
  tableName: string;
  orderByCalled: unknown[];
  limitCalled: number | null;
};

function loadRoute(opts: {
  guard?: Guard;
  auditRowCount?: number;
}) {
  const url = new URL("./route.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const queries: QueryRecord[] = [];
  const audits: { action: string; target: string; details: Record<string, unknown> }[] = [];

  const mockAuditRows = Array.from({ length: opts.auditRowCount ?? 5 }, (_, i) => ({
    id: `audit-${i}`,
    action: "SOME_ACTION",
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
  }));

  const dbMock = {
    select: () => ({
      from: (table: { __tableName?: string }) => {
        const tName = table.__tableName ?? "unknown";
        const qRecord: QueryRecord = {
          tableName: tName,
          orderByCalled: [],
          limitCalled: null,
        };
        queries.push(qRecord);

        const chain: Record<string, unknown> = {
          orderBy: (...args: unknown[]) => {
            qRecord.orderByCalled.push(...args);
            return chain;
          },
          limit: (n: number) => {
            qRecord.limitCalled = n;
            return chain;
          },
          then: (resolve: (v: unknown) => void) => {
            if (tName === "audit_logs") {
              const rows = qRecord.limitCalled ? mockAuditRows.slice(0, qRecord.limitCalled) : mockAuditRows;
              resolve(rows);
            } else {
              resolve([{ id: `mock-${tName}-1` }]);
            }
          },
        };
        return chain;
      },
    }),
  };

  const makeTable = (name: string) => ({
    __tableName: name,
    id: { name: "id" },
    createdAt: { name: "created_at" },
  });

  const schemaMock = {
    auditLogs: makeTable("audit_logs"),
    dailyApplications: makeTable("daily_applications"),
    departments: makeTable("departments"),
    dwData: makeTable("dw_data"),
    employmentSessions: makeTable("employment_sessions"),
    fieldDefinitions: makeTable("field_definitions"),
    formQuestions: makeTable("form_questions"),
    notifications: makeTable("notifications"),
    planningAllocations: makeTable("planning_allocations"),
    planningPeriods: makeTable("planning_periods"),
    planningTargets: makeTable("planning_targets"),
    rolePermissions: makeTable("role_permissions"),
    rules: makeTable("rules"),
    userDepartmentScopes: makeTable("user_department_scopes"),
    workerProfiles: makeTable("worker_profiles"),
    workflowStages: makeTable("workflow_stages"),
    workforceMovements: makeTable("workforce_movements"),
  };

  class FakeNextResponse {
    body: string;
    status: number;
    headers: Record<string, string>;

    constructor(body: string, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = init?.headers ?? {};
    }

    static json(data: unknown, init?: { status?: number }) {
      return new FakeNextResponse(JSON.stringify(data), {
        status: init?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const moduleObj = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    if (specifier === "next/server") return { NextResponse: FakeNextResponse };
    if (specifier === "drizzle-orm") {
      return {
        desc: (col: unknown) => ({ __desc: col }),
        asc: (col: unknown) => ({ __asc: col }),
      };
    }
    if (specifier === "@/db") return { db: dbMock };
    if (specifier === "@/db/schema") return schemaMock;
    if (specifier === "@/lib/auth") {
      return {
        requireRoleAndPermission: async () => opts.guard ?? { ok: true, session: { id: "admin-1", role: "ADMIN", username: "admin_user" } },
        writeAudit: async (_sess: unknown, action: string, target: string, details: Record<string, unknown>) => {
          audits.push({ action, target, details });
        },
      };
    }
    throw new Error(`Unexpected require: ${specifier}`);
  };

  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: requireShim,
    console,
    process: { env: { VERCEL_GIT_COMMIT_SHA: "test-sha-12345" } },
    Date,
    Promise,
    JSON,
  });

  vm.runInContext(js, context);
  return {
    route: moduleObj.exports as {
      GET: () => Promise<FakeNextResponse>;
      BUSINESS_EXPORT_AUDIT_LOG_LIMIT: number;
      INCLUDED_BUSINESS_EXPORT_TABLES: readonly string[];
    },
    queries,
    audits,
  };
}

test("1. exportType identifies BUSINESS_DATA_EXPORT and exports valid JSON", async () => {
  const { route } = loadRoute({});
  const res = await route.GET();

  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.exportType, "BUSINESS_DATA_EXPORT");
  assert.equal(typeof data.generatedAt, "string");
  assert.equal(data.sourceCommitSha, "test-sha-12345");
});

test("2. isDisasterRecoveryBackup is explicitly false and includes warning metadata", async () => {
  const { route } = loadRoute({});
  const res = await route.GET();
  const data = JSON.parse(res.body);

  assert.equal(data.isDisasterRecoveryBackup, false);
  assert.ok(typeof data.excludedPurpose === "string");
  assert.match(data.excludedPurpose, /KHÔNG PHẢI là bản sao lưu toàn bộ cơ sở dữ liệu/);
  assert.ok(typeof data.warning === "string");
  assert.match(data.warning, /không bao gồm tài khoản/);
});

test("3. includedTables accurately matches the 17 exported tables", async () => {
  const { route } = loadRoute({});
  const res = await route.GET();
  const data = JSON.parse(res.body);

  assert.equal(Array.isArray(data.includedTables), true);
  assert.equal(data.includedTables.length, 17);

  const expectedTables = [
    "departments",
    "dw_data",
    "daily_applications",
    "form_questions",
    "field_definitions",
    "workflow_stages",
    "rules",
    "worker_profiles",
    "employment_sessions",
    "planning_periods",
    "planning_targets",
    "planning_allocations",
    "workforce_movements",
    "user_department_scopes",
    "role_permissions",
    "notifications",
    "audit_logs",
  ];

  assert.deepEqual(data.includedTables.sort(), expectedTables.sort());
  assert.deepEqual(Object.keys(data.tables).sort(), expectedTables.sort());
});

test("4. audit_logs query enforces deterministic newest-first ordering", async () => {
  const { route, queries } = loadRoute({});
  await route.GET();

  const auditQuery = queries.find((q) => q.tableName === "audit_logs");
  assert.ok(auditQuery, "audit_logs must be queried");
  assert.ok(auditQuery.orderByCalled.length >= 1, "audit_logs must be ordered");

  // Check that orderBy was called with desc on createdAt and id
  const hasDescCreatedAt = auditQuery.orderByCalled.some(
    (o) => typeof o === "object" && o !== null && (o as { __desc?: { name?: string } }).__desc?.name === "created_at",
  );
  assert.equal(hasDescCreatedAt, true, "Must order by desc(auditLogs.createdAt)");
});

test("5. audit_logs query is bounded by the named constant BUSINESS_EXPORT_AUDIT_LOG_LIMIT", async () => {
  const { route, queries } = loadRoute({});
  assert.equal(route.BUSINESS_EXPORT_AUDIT_LOG_LIMIT, 10_000);

  await route.GET();
  const auditQuery = queries.find((q) => q.tableName === "audit_logs");
  assert.equal(auditQuery?.limitCalled, 10_000);
});

test("6. metadata reports auditLogLimit matching the named constant", async () => {
  const { route } = loadRoute({});
  const res = await route.GET();
  const data = JSON.parse(res.body);

  assert.equal(data.auditLogLimit, 10_000);
});

test("7. metadata reports exported audit count", async () => {
  const { route } = loadRoute({ auditRowCount: 42 });
  const res = await route.GET();
  const data = JSON.parse(res.body);

  assert.equal(data.auditLogsExported, 42);
  assert.equal(data.tables.audit_logs.length, 42);
});

test("8. truncation flag behavior is correct (false when below limit, true when at/above limit)", async () => {
  // Below limit
  {
    const { route } = loadRoute({ auditRowCount: 50 });
    const res = await route.GET();
    const data = JSON.parse(res.body);
    assert.equal(data.auditLogsMayBeTruncated, false);
  }

  // At or above limit
  {
    const { route } = loadRoute({ auditRowCount: 12_000 });
    const res = await route.GET();
    const data = JSON.parse(res.body);
    assert.equal(data.auditLogsExported, 10_000);
    assert.equal(data.auditLogsMayBeTruncated, true);
  }
});

test("9. auth/RBAC remains unchanged: rejects non-admin or missing permission", async () => {
  const { route, queries } = loadRoute({
    guard: { ok: false, status: 403, error: "FORBIDDEN" },
  });
  const res = await route.GET();

  assert.equal(res.status, 403);
  const data = JSON.parse(res.body);
  assert.equal(data.error, "FORBIDDEN");
  assert.equal(queries.length, 0, "No database query should execute if guard fails");
});

test("10. no users or password hashes are added to payload", async () => {
  const { route } = loadRoute({});
  const res = await route.GET();
  const rawBody = res.body;
  const data = JSON.parse(rawBody);

  assert.equal("users" in data.tables, false);
  assert.equal(data.includedTables.includes("users"), false);
  assert.equal(rawBody.includes("password_hash"), false);
  assert.equal(rawBody.includes("passwordHash"), false);
});

test("11. no canonical/missing tables are silently claimed as backed up", async () => {
  const { route } = loadRoute({});
  const res = await route.GET();
  const data = JSON.parse(res.body);

  const missingTables = [
    "dw_codes",
    "dw_code_locations",
    "dw_code_assignments",
    "it_code_assignments",
    "recruitment_requests",
    "request_allocations",
    "merge_templates",
    "merge_template_versions",
    "candidate_documents",
    "document_confirmations",
    "scheduled_jobs",
    "schema_migrations",
  ];

  for (const table of missingTables) {
    assert.equal(table in data.tables, false, `${table} must not be in data.tables`);
    assert.equal(data.includedTables.includes(table), false, `${table} must not be in includedTables`);
  }
});

test("12. existing JSON download still works with attachment header and BusinessData filename", async () => {
  const { route, audits } = loadRoute({});
  const res = await route.GET();

  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "application/json; charset=utf-8");
  assert.match(res.headers["Content-Disposition"], /^attachment; filename="DalatHasfarm-BusinessData-\d{4}-\d{2}-\d{2}\.json"$/);

  // Audit log was written
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "EXPORT_DATABASE_BACKUP");
  assert.equal(audits[0].details.exportType, "BUSINESS_DATA_EXPORT");
  assert.equal(audits[0].details.auditLogLimit, 10_000);
});

test("13. UI and User Guide documentation truthfully label Business Data Export", () => {
  const pageSource = readFileSync(new URL("../../../(internal)/admin/system/page.tsx", import.meta.url), "utf8");
  assert.ok(!pageSource.includes('title="Backup"'), 'page.tsx must not use title="Backup"');
  assert.ok(!pageSource.includes("Export Database (JSON)"), "page.tsx must not use 'Export Database (JSON)'");
  assert.ok(pageSource.includes("Xuất dữ liệu nghiệp vụ (JSON)"), "page.tsx must use 'Xuất dữ liệu nghiệp vụ (JSON)'");
  assert.ok(pageSource.includes("Dữ liệu nghiệp vụ"), "page.tsx must use 'Dữ liệu nghiệp vụ'");
  assert.ok(!pageSource.includes("Neon → Branches để snapshot cấp database (khuyến nghị cho backup định kỳ thật sự)"), "Must not claim Neon PITR is recommended/enabled");

  const docSource = readFileSync(new URL("../../../../../docs/user-guide/12-backup.md", import.meta.url), "utf8");
  assert.ok(docSource.includes("Xuất dữ liệu nghiệp vụ (Business Data Export)"), "Doc title must be updated");
  assert.ok(docSource.includes("Đây KHÔNG PHẢI là bản sao lưu toàn bộ cơ sở dữ liệu"), "Doc must include safety warning");
  assert.ok(!docSource.includes("khuyến nghị dùng Neon Branches"), "Doc must not claim Neon Branches is active/recommended");
});
