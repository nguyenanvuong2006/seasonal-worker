/**
 * claimItems() — rewritten as ONE atomic SQL statement (CTE SELECT ... FOR
 * UPDATE SKIP LOCKED -> UPDATE ... FROM ... RETURNING) instead of a manual
 * client.query("BEGIN"/"COMMIT") sequence over a checked-out pool connection.
 *
 * The old multi-statement approach is the leading suspect for a live staging
 * failure: a job's single QUEUED item repeatedly failed to be claimed (even
 * across retries) while every other single-statement query in the same app
 * worked fine — consistent with PgBouncer transaction-pooling silently
 * routing statements within one manual transaction to different backend
 * sessions, breaking FOR UPDATE's lock/visibility guarantees. A single SQL
 * statement is immune to that class of bug regardless of whether that theory
 * is the exact live cause.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, type FakeDb } from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

const schemaStub = {
  mergeJobRecords: makeTable("merge_job_records"),
  mergeJobs: makeTable("merge_jobs"),
};

type QueueModule = {
  claimItems: (jobId: string, limit?: number) => Promise<{ id: string; mergeJobId: string; status: string; attemptCount: number }[]>;
  failAllNonTerminalItems: (jobId: string, info: { errorCode: string; errorMessage: string }) => Promise<number>;
};

async function load(db: FakeDb): Promise<QueueModule> {
  const mod = await loadModule(new URL("./queue.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "../../db": { db },
      "../../db/schema": schemaStub,
      "./queue-types.ts": {
        DEFAULT_MAX_ATTEMPTS: 3,
        ITEM_STATUS: { QUEUED: "QUEUED", RETRY: "RETRY", PROCESSING: "PROCESSING", COMPLETED: "COMPLETED", FAILED: "FAILED" },
        isTerminalItemStatus: () => false,
        retryBackoffSeconds: () => 1,
        shouldRetry: () => true,
      },
    },
  });
  return mod as unknown as QueueModule;
}

// Hạ tầng fake-drizzle chung KHÔNG cho respond() can thiệp db.execute() (luôn
// trả {rows:[]} cố định — xem fake-drizzle.ts) — override execute trực tiếp
// trên object trả về để kiểm soát kết quả RETURNING trong test này (đúng
// pattern đã dùng ở queue.recordJobStage.test.ts).
function fakeDbWithExecuteResult(rows: unknown[]): FakeDb {
  const db = createFakeDb({ respond: () => undefined });
  const calls = db.calls;
  return {
    ...db,
    calls,
    execute: async (...args: unknown[]) => {
      calls.push({ root: "execute", table: "", ops: [{ fn: "execute", args }] });
      return { rows };
    },
  };
}

test("claimItems: issues exactly ONE db.execute call — no separate BEGIN/COMMIT round trips", async () => {
  const db = fakeDbWithExecuteResult([
    { id: "item-1", merge_job_id: "job-1", source_entity: "daily_applications", source_record_id: "app-1", template_id: "tpl-1", sort_order: 1, status: "PROCESSING", attempt_count: 1 },
  ]);
  const mod = await load(db);

  const items = await mod.claimItems("job-1", 1);

  const executeCalls = db.calls.filter((c) => c.root === "execute");
  assert.equal(executeCalls.length, 1, "claim phải là đúng 1 câu SQL atomic, không phải nhiều round-trip BEGIN/SELECT/UPDATE/COMMIT");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "item-1");
  assert.equal(items[0].status, "PROCESSING");
  assert.equal(items[0].attemptCount, 1, "RETURNING trả giá trị ĐÃ update (attempt_count đã tăng), không cần override thủ công ở JS");
});

test("claimItems: no claimable rows -> empty array, still just 1 db.execute call", async () => {
  const db = fakeDbWithExecuteResult([]);
  const mod = await load(db);

  const items = await mod.claimItems("job-1", 1);

  assert.deepEqual(items, []);
  assert.equal(db.calls.filter((c) => c.root === "execute").length, 1);
});

test("failAllNonTerminalItems: marks non-terminal items FAILED with the given error, returns the count", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "update" && call.table === "merge_job_records") {
        return [{ id: "item-1" }];
      }
      return undefined;
    },
  });
  const mod = await load(db);

  const count = await mod.failAllNonTerminalItems("job-1", { errorCode: "CLAIM_STALLED", errorMessage: "test" });

  assert.equal(count, 1);
  const update = db.calls.find((c) => c.root === "update" && c.table === "merge_job_records");
  assert.ok(update, "phải UPDATE merge_job_records");
});
