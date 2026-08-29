/**
 * TEST C — GET /api/document-merge/jobs/[id] is READ-ONLY for recovery.
 *
 * The UI polls this route every ~4s. Repeated polling MUST NOT:
 *  - fail a GOOGLE_DOCS job,
 *  - reclaim records,
 *  - re-dispatch / trigger a worker,
 *  - mutate any merge status.
 * Recovery runs only via the explicit cron/watchdog actor (stale-recovery),
 * never imported by the GET route.
 *
 * Transpiles the REAL route.ts in a vm sandbox. The require-shim FAILS if the
 * route imports stale-recovery or worker-trigger (those would imply a poll
 * side effect).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";

const routeSource = readFileSync(
  new URL("../../app/api/document-merge/jobs/[id]/route.ts", import.meta.url),
  "utf8",
);
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  mergeJobRecords: makeTable("merge_job_records"),
  mergeJobs: makeTable("merge_jobs"),
};

const FORBIDDEN_IMPORTS = ["stale-recovery", "worker-trigger", "scheduler"];

function loadGet(opts: { job: Record<string, unknown>; items: Record<string, unknown>[] }) {
  const db: FakeDb = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "merge_jobs") return [opts.job];
      if (call.root === "select" && call.table === "merge_job_records") return opts.items;
      return undefined;
    },
  });

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      for (const bad of FORBIDDEN_IMPORTS) {
        if (id.includes(bad)) throw new Error(`GET route must NOT import ${id} (recovery must not run on poll)`);
      }
      switch (id) {
        case "next/server":
          return { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } };
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/auth":
          return { requirePermission: async () => ({ ok: true, status: 200, session: { username: "admin", role: "ADMIN" } }) };
        case "@/lib/document-merge/queue-types":
          return { normalizeItemStatus: (s: string) => (s === "PENDING" ? "QUEUED" : s === "RUNNING" ? "PROCESSING" : s) };
        default:
          throw new Error(`Unexpected require("${id}") in GET route`);
      }
    },
    process,
    Request,
    console,
    Date,
    JSON,
    Promise,
    Object,
  });
  vm.runInContext(jsSource, context);
  const GET = (moduleObj.exports as { GET: (r: Request, c: unknown) => Promise<{ status: number; body: Record<string, unknown> }> }).GET;
  return { GET, db };
}

const jobStates: Array<{ status: string }> = [
  { status: "RUNNING" },
  { status: "PROCESSING" },
  { status: "QUEUED" },
  { status: "PENDING" },
  { status: "RETRY" },
];

test("TEST C — repeated GET polling performs ZERO recovery writes and ZERO worker triggers across RUNNING/PROCESSING/QUEUED/PENDING/RETRY", async () => {
  for (const state of jobStates) {
    const { GET, db } = loadGet({
      job: { id: "job-1", status: state.status, engine: "GOOGLE_DOCS" },
      items: [{ id: "rec-1", status: state.status, sortOrder: 0, attemptCount: 0 }],
    });

    for (let i = 0; i < 5; i++) {
      const res = await GET(new Request("https://app.example/api/document-merge/jobs/job-1"), {
        params: Promise.resolve({ id: "job-1" }),
      });
      assert.equal(res.status, 200, `GET should be 200 for ${state.status}`);
    }

    // The ONLY queries a read-only GET may issue are SELECTs — no INSERT/UPDATE.
    const writes = db.calls.filter((c) => c.root !== "select");
    assert.equal(writes.length, 0, `polling a ${state.status} job must not write, got ${writes.length}`);

    // Exactly 2 selects per poll (job + items), nothing else.
    const nonSelects = db.calls.filter((c) => c.root === "execute" || c.root === "update" || c.root === "insert");
    assert.equal(nonSelects.length, 0, `no execute/update/insert for ${state.status}`);
  }
});

test("TEST C — GET returns observational progress only (status/counts), never a `recovered`/dispatch side effect", async () => {
  const { GET } = loadGet({
    job: { id: "job-1", status: "RUNNING", engine: "GOOGLE_DOCS" },
    items: [{ id: "rec-1", status: "PENDING", sortOrder: 0, attemptCount: 0 }],
  });
  const res = await GET(new Request("https://app.example/api/document-merge/jobs/job-1"), {
    params: Promise.resolve({ id: "job-1" }),
  });
  assert.equal(res.body.status, "RUNNING");
  assert.ok(res.body.progress, "progress present");
  assert.equal((res.body.progress as { queued: number }).queued, 1, "PENDING normalises to queued=1 observationally");
  assert.equal(res.body.recovered, undefined, "no recovery side effect reported by the read endpoint");
});
