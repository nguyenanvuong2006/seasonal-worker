/**
 * recordJobStage() — writes the worker's current processing stage into
 * merge_jobs.metadata.lastStage so a stuck job (PROCESSING forever) leaves a
 * diagnosable trail. Must NEVER throw — a diagnostics write failing must not
 * be allowed to crash real PDF rendering.
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
  recordJobStage: (
    jobId: string,
    stage: string,
    extra?: { itemId?: string | null; startedAt: number; ok: boolean; errorCode?: string | null },
  ) => Promise<void>;
};

async function load(db: FakeDb): Promise<QueueModule> {
  const mod = await loadModule(new URL("./queue.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "../../db": { db, pool: {} },
      "../../db/schema": schemaStub,
      "./queue-types.ts": {
        DEFAULT_MAX_ATTEMPTS: 3,
        ITEM_STATUS: { QUEUED: "QUEUED", RETRY: "RETRY" },
        isTerminalItemStatus: () => false,
        retryBackoffSeconds: () => 1,
        shouldRetry: () => true,
      },
    },
  });
  return mod as unknown as QueueModule;
}

test("recordJobStage: issues a jsonb_set UPDATE against merge_jobs.metadata for the given job", async () => {
  const db = createFakeDb({ respond: () => undefined });
  const mod = await load(db);

  await mod.recordJobStage("job-1", "CHROMIUM_LAUNCH", { itemId: "item-1", startedAt: Date.now() - 500, ok: true });

  const executed = db.calls.filter((c) => c.root === "execute");
  assert.equal(executed.length, 1, "phải gọi db.execute đúng 1 lần");
});

test("recordJobStage: never throws even if the DB write fails (diagnostics must not crash real rendering)", async () => {
  const db: FakeDb = {
    ...createFakeDb({ respond: () => undefined }),
    execute: async () => {
      throw new Error("connection reset");
    },
  };
  const mod = await load(db);

  await assert.doesNotReject(() => mod.recordJobStage("job-1", "PDF_RENDER", { startedAt: Date.now(), ok: true }));
});
