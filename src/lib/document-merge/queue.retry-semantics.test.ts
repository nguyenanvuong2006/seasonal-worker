/**
 * Shared queue retry semantics: future retry_at is not a claim stall, and
 * job-level fail must preserve an item's original INCOMPLETE error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, argOf, type FakeDb } from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

const schemaStub = {
  mergeJobRecords: makeTable("merge_job_records"),
  mergeJobs: makeTable("merge_jobs"),
};

type QueueModule = {
  allRemainingItemsAwaitingRetry: (jobId: string) => Promise<boolean>;
  failAllNonTerminalItems: (jobId: string, info: { errorCode: string; errorMessage: string }) => Promise<number>;
  failItem: (
    itemId: string,
    info: { errorCode?: string | null; errorMessage?: string | null },
    opts: { attemptCount: number; maxAttempts?: number },
  ) => Promise<string>;
};

async function load(db: FakeDb, opts: { shouldRetry?: boolean } = {}): Promise<QueueModule> {
  const mod = await loadModule(new URL("./queue.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "../../db": { db },
      "../../db/schema": schemaStub,
      "./queue-types.ts": {
        DEFAULT_MAX_ATTEMPTS: 3,
        ITEM_STATUS: {
          QUEUED: "QUEUED",
          RETRY: "RETRY",
          PROCESSING: "PROCESSING",
          COMPLETED: "COMPLETED",
          FAILED: "FAILED",
          PAUSED: "PAUSED",
          CANCELLED: "CANCELLED",
        },
        isTerminalItemStatus: (status: string) => status === "COMPLETED" || status === "FAILED" || status === "CANCELLED",
        retryBackoffSeconds: () => 30,
        shouldRetry: () => opts.shouldRetry ?? true,
        isRetryableItemError: (errorCode?: string | null, explicit?: boolean) => {
          if (typeof explicit === "boolean") return explicit;
          if (!errorCode) return true;
          return !["INCOMPLETE", "INVALID_MAPPING", "INVALID_TEMPLATE", "UNSUPPORTED_SOURCE_PATH", "TEMPLATE_NOT_PUBLISHED", "RECORD_NOT_FOUND"].includes(errorCode);
        },
      },
    },
  });
  return mod as unknown as QueueModule;
}

test("allRemainingItemsAwaitingRetry: every pending item is RETRY with future retry_at → true", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_job_records") {
        return [
          { status: "RETRY", retryAt: new Date(Date.now() + 60_000) },
          { status: "COMPLETED", retryAt: null },
        ];
      }
      return undefined;
    },
  });
  const mod = await load(db);
  assert.equal(await mod.allRemainingItemsAwaitingRetry("job-1"), true);
});

test("allRemainingItemsAwaitingRetry: QUEUED item with no retry_at → false (true stall)", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_job_records") {
        return [{ status: "QUEUED", retryAt: null }];
      }
      return undefined;
    },
  });
  const mod = await load(db);
  assert.equal(await mod.allRemainingItemsAwaitingRetry("job-1"), false);
});

test("allRemainingItemsAwaitingRetry: RETRY whose retry_at is already due → false", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_job_records") {
        return [{ status: "RETRY", retryAt: new Date(Date.now() - 1_000) }];
      }
      return undefined;
    },
  });
  const mod = await load(db);
  assert.equal(await mod.allRemainingItemsAwaitingRetry("job-1"), false);
});

test("allRemainingItemsAwaitingRetry: mix of future RETRY and QUEUED → false", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_job_records") {
        return [
          { status: "RETRY", retryAt: new Date(Date.now() + 60_000) },
          { status: "QUEUED", retryAt: null },
        ];
      }
      return undefined;
    },
  });
  const mod = await load(db);
  assert.equal(await mod.allRemainingItemsAwaitingRetry("job-1"), false);
});

test("allRemainingItemsAwaitingRetry: no pending items → false", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_job_records") {
        return [{ status: "FAILED", retryAt: null }];
      }
      return undefined;
    },
  });
  const mod = await load(db);
  assert.equal(await mod.allRemainingItemsAwaitingRetry("job-1"), false);
});

test("failItem: DATA_RESOLUTION INCOMPLETE on attempt 1 is FAILED immediately (not RETRY)", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "update" && call.table === "merge_job_records") return [{ id: "item-1" }];
      return undefined;
    },
  });
  const mod = await load(db, { shouldRetry: true });
  const status = await mod.failItem(
    "item-1",
    { errorCode: "INCOMPLETE", errorMessage: "Thiếu: Dia_chi_thuong_tru" },
    { attemptCount: 1 },
  );
  assert.equal(status, "FAILED");
  const update = db.calls.find((c) => c.root === "update" && c.table === "merge_job_records");
  assert.ok(update);
  const set = argOf(update!, "set") as {
    status: string;
    errorCode: string;
    errorMessage: string;
    retryAt: Date | null;
    completedAt: Date | null;
    leasedUntil: Date | null;
  };
  assert.equal(set.status, "FAILED");
  assert.equal(set.errorCode, "INCOMPLETE");
  assert.match(set.errorMessage, /Dia_chi_thuong_tru/);
  assert.equal(set.retryAt, null);
  assert.ok(set.completedAt instanceof Date);
  assert.equal(set.leasedUntil, null);
});

test("failItem: transient RENDER_FAILED still RETRY while attempts remain", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "update" && call.table === "merge_job_records") return [{ id: "item-1" }];
      return undefined;
    },
  });
  const mod = await load(db, { shouldRetry: true });
  const status = await mod.failItem(
    "item-1",
    { errorCode: "RENDER_FAILED", errorMessage: "ECONNRESET" },
    { attemptCount: 1 },
  );
  assert.equal(status, "RETRY");
  const set = argOf(db.calls.find((c) => c.root === "update")!, "set") as { status: string; retryAt: Date | null };
  assert.equal(set.status, "RETRY");
  assert.ok(set.retryAt instanceof Date);
});

test("failItem: exhausted INCOMPLETE becomes FAILED and keeps the original error", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "update" && call.table === "merge_job_records") return [{ id: "item-1" }];
      return undefined;
    },
  });
  const mod = await load(db, { shouldRetry: false });
  const status = await mod.failItem(
    "item-1",
    { errorCode: "INCOMPLETE", errorMessage: "Thiếu: Dia_chi_thuong_tru" },
    { attemptCount: 3 },
  );
  assert.equal(status, "FAILED");
  const set = argOf(db.calls.find((c) => c.root === "update")!, "set") as { status: string; errorCode: string; retryAt: Date | null };
  assert.equal(set.status, "FAILED");
  assert.equal(set.errorCode, "INCOMPLETE");
  assert.equal(set.retryAt, null);
});

test("failAllNonTerminalItems: COALESCE preserves an existing item error instead of overwriting with CLAIM_STALLED", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "update" && call.table === "merge_job_records") return [{ id: "item-1" }];
      return undefined;
    },
  });
  const mod = await load(db);
  const count = await mod.failAllNonTerminalItems("job-1", {
    errorCode: "CLAIM_STALLED",
    errorMessage: "CLAIM_STALLED: còn 1 item",
  });
  assert.equal(count, 1);
  const set = argOf(db.calls.find((c) => c.root === "update")!, "set") as { errorCode: { op?: string; text?: string }; errorMessage: { op?: string; text?: string } };
  assert.equal(set.errorCode.op, "sql");
  assert.match(String(set.errorCode.text), /COALESCE/i);
  assert.equal(set.errorMessage.op, "sql");
  assert.match(String(set.errorMessage.text), /COALESCE/i);
});
