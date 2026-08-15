import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// import-staging-cleanup.ts import "server-only" + "@/db" + "@/db/schema" — không resolve
// được bằng Node thuần ngoài Next.js. Theo đúng pattern của auth.test.ts / cron route.test.ts:
// transpile CHÍNH source thật sang CommonJS rồi chạy trong vm sandbox với require giả lập,
// mock CHỈ tầng DB (pool/db) — toàn bộ logic retention/idempotency/self-guarding là thật.
const source = readFileSync(new URL("./import-staging-cleanup.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

type QueryCall = { sql: string; params: unknown[] };

function makeModule(opts: {
  candidateRows?: Record<string, unknown>[];
  deleteRowCounts?: number[]; // rowCount trả về cho từng câu DELETE, theo thứ tự
}) {
  const queries: QueryCall[] = [];
  const auditInserts: Record<string, unknown>[] = [];
  const txEvents: string[] = [];
  let deleteIdx = 0;

  const clientQuery = async (sql: string, params?: unknown[]) => {
    const s = sql.trim();
    if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") {
      txEvents.push(s);
      return { rows: [], rowCount: 0 };
    }
    queries.push({ sql: s, params: params ?? [] });
    if (s.startsWith("DELETE FROM")) {
      const rowCount = opts.deleteRowCounts?.[deleteIdx] ?? 0;
      deleteIdx++;
      return { rows: [], rowCount };
    }
    if (s.startsWith("SELECT j.id")) {
      return { rows: opts.candidateRows ?? [], rowCount: (opts.candidateRows ?? []).length };
    }
    return { rows: [], rowCount: 0 };
  };

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      if (id === "server-only") return {};
      if (id === "@/db") {
        return {
          pool: {
            query: clientQuery,
            connect: async () => ({ query: clientQuery, release: () => {} }),
          },
          db: {
            insert: () => ({
              values: async (v: Record<string, unknown>) => {
                auditInserts.push(v);
              },
            }),
          },
        };
      }
      if (id === "@/db/schema") return { auditLogs: {} };
      throw new Error(`Unexpected require("${id}")`);
    },
    console: { log: () => {} },
  });
  vm.runInContext(jsSource, context);
  return { exports: moduleObj.exports as Record<string, CallableFunction>, queries, auditInserts, txEvents };
}

test("cleanupJobStaging chỉ DELETE 3 bảng staging — không bao giờ đụng import_jobs/import_job_errors/bảng nghiệp vụ", async () => {
  const m = makeModule({ deleteRowCounts: [0, 5, 0] });
  await m.exports.cleanupJobStaging("job-1");
  const deletes = m.queries.filter((q) => q.sql.startsWith("DELETE FROM"));
  assert.equal(deletes.length, 3);
  const targets = deletes.map((q) => q.sql.match(/DELETE FROM (\w+)/)?.[1]);
  assert.deepEqual(targets, ["staging_department", "staging_dw_data", "staging_daily_application"]);
  for (const q of m.queries) {
    assert.ok(!/DELETE FROM (import_jobs|import_job_errors|audit_logs|dw_data|daily_applications|departments)\b/.test(q.sql), `Câu SQL nguy hiểm: ${q.sql}`);
  }
});

test("mỗi DELETE đều self-guarding: JOIN import_jobs, chỉ terminal DONE/CANCELLED quá 24h", async () => {
  const m = makeModule({ deleteRowCounts: [0, 0, 0] });
  await m.exports.cleanupJobStaging("job-1");
  for (const q of m.queries.filter((x) => x.sql.startsWith("DELETE FROM"))) {
    assert.match(q.sql, /USING import_jobs j/);
    assert.match(q.sql, /j\.status IN \('DONE','CANCELLED'\)/);
    assert.match(q.sql, /interval '24 hours'/);
    assert.match(q.sql, /s\.job_id = \$1/);
    // Không dùng deepEqual: params là Array tạo trong vm realm khác (prototype khác) — so từng phần tử.
    assert.equal(q.params.length, 1);
    assert.equal(q.params[0], "job-1");
  }
  // Không có điều kiện nào cho phép QUEUED/RUNNING/PAUSED/FAILED lọt qua.
  for (const st of ["QUEUED", "RUNNING", "PAUSED", "FAILED"]) {
    for (const q of m.queries) assert.ok(!q.sql.includes(`'${st}'`), `status ${st} không được xuất hiện trong điều kiện xoá`);
  }
});

test("idempotent: chạy lần 2 khớp 0 dòng — không lỗi, transaction COMMIT bình thường", async () => {
  const m = makeModule({ deleteRowCounts: [0, 0, 0] });
  const r = (await m.exports.cleanupJobStaging("job-1")) as { deletedTotal: number };
  assert.equal(r.deletedTotal, 0);
  assert.deepEqual(m.txEvents, ["BEGIN", "COMMIT"]);
});

test("cleanupJobStaging trả về đúng số dòng đã xoá từng bảng", async () => {
  const m = makeModule({ deleteRowCounts: [1, 13522, 822] });
  const r = (await m.exports.cleanupJobStaging("job-1")) as Record<string, number>;
  assert.equal(r.deletedDepartment, 1);
  assert.equal(r.deletedDwData, 13522);
  assert.equal(r.deletedDailyApplication, 822);
  assert.equal(r.deletedTotal, 14345);
});

test("findStagingCleanupCandidates chỉ chọn job terminal quá hạn CÒN staging rows", async () => {
  const m = makeModule({ candidateRows: [{ id: "a", job_type: "dw_data", status: "DONE", file_name: "f.csv" }] });
  const rows = (await m.exports.findStagingCleanupCandidates()) as { id: string }[];
  assert.equal(rows.length, 1);
  const sel = m.queries.find((q) => q.sql.startsWith("SELECT j.id"));
  assert.ok(sel);
  assert.match(sel.sql, /j\.status IN \('DONE','CANCELLED'\)/);
  assert.match(sel.sql, /interval '24 hours'/);
  assert.match(sel.sql, /EXISTS \(SELECT 1 FROM staging_department/);
  assert.match(sel.sql, /EXISTS \(SELECT 1 FROM staging_dw_data/);
  assert.match(sel.sql, /EXISTS \(SELECT 1 FROM staging_daily_application/);
});

test("cleanupTerminalStaging: ghi audit IMPORT_STAGING_CLEANED cho job có dòng bị xoá, bỏ qua job 0 dòng", async () => {
  const m = makeModule({
    candidateRows: [
      { id: "a", job_type: "dw_data", status: "DONE", file_name: "dw.csv" },
      { id: "b", job_type: "daily_application", status: "CANCELLED", file_name: "da.csv" },
    ],
    // job a: 3 câu DELETE (0, 13522, 0); job b: 3 câu DELETE (0, 0, 0) — đã bị dọn trước đó (race).
    deleteRowCounts: [0, 13522, 0, 0, 0, 0],
  });
  const r = (await m.exports.cleanupTerminalStaging()) as { candidates: number; cleaned: number; deletedRows: number };
  assert.equal(r.candidates, 2);
  assert.equal(r.cleaned, 1); // job b khớp 0 dòng — không tính, không log rác
  assert.equal(r.deletedRows, 13522);
  assert.equal(m.auditInserts.length, 1);
  const audit = m.auditInserts[0] as { action: string; username: string; category: string; details: { jobId: string; deletedTotal: number } };
  assert.equal(audit.action, "IMPORT_STAGING_CLEANED");
  assert.equal(audit.username, "system");
  assert.equal(audit.category, "IMPORT");
  assert.equal(audit.details.jobId, "a");
  assert.equal(audit.details.deletedTotal, 13522);
});

test("lỗi giữa transaction → ROLLBACK, không COMMIT nửa vời", async () => {
  const m = makeModule({});
  // Ép câu DELETE thứ 2 nổ lỗi bằng cách vá lại query của mock qua exports? Đơn giản hơn:
  // tạo module riêng có client ném lỗi ở DELETE thứ 2.
  const moduleObj = { exports: {} as Record<string, unknown> };
  const txEvents: string[] = [];
  let deleteCount = 0;
  const failingQuery = async (sql: string) => {
    const s = sql.trim();
    if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") {
      txEvents.push(s);
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith("DELETE FROM")) {
      deleteCount++;
      if (deleteCount === 2) throw new Error("boom");
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      if (id === "server-only") return {};
      if (id === "@/db") return { pool: { query: failingQuery, connect: async () => ({ query: failingQuery, release: () => {} }) }, db: { insert: () => ({ values: async () => {} }) } };
      if (id === "@/db/schema") return { auditLogs: {} };
      throw new Error(`Unexpected require("${id}")`);
    },
    console: { log: () => {} },
  });
  vm.runInContext(jsSource, context);
  const mod = moduleObj.exports as { cleanupJobStaging: (id: string) => Promise<unknown> };
  await assert.rejects(() => mod.cleanupJobStaging("job-x"), /boom/);
  assert.deepEqual(txEvents, ["BEGIN", "ROLLBACK"]);
  void m;
});
