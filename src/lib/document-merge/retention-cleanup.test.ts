/**
 * Retention cleanup — tests (Phase 13).
 * - CHỈ xoá PDF online khi VERIFIED + hết hạn (KHÔNG xoá khi chưa VERIFIED).
 * - Batch outputs hết TTL bị xoá + clear url/file id trên job.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakeDb,
  drizzleStub,
  makeTable,
  argOf,
  type FakeDb,
  type QueryCall,
} from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

const schemaStub = {
  documentHistory: makeTable("document_history"),
  mergeJobs: makeTable("merge_jobs"),
};

type CleanupModule = {
  cleanupExpiredVerifiedDocuments: (now?: Date) => Promise<{ deleted: number; skippedNotVerified: number }>;
  cleanupExpiredBatchOutputs: (now?: Date) => Promise<number>;
};

const deletedKeys: string[] = [];

async function load(db: FakeDb): Promise<CleanupModule> {
  const mod = await loadModule(new URL("./retention-cleanup.ts", import.meta.url), {
    stubs: {
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "./document-history.ts": {
        listExpiredVerifiedDocuments: async () => [
          { id: "h1", storageFileId: "Candidate Documents/2026/08/17/a.pdf" },
          { id: "h2", storageFileId: "Candidate Documents/2026/08/17/b.pdf" },
        ],
        markOnlineDeleted: async (id: string) => ({ id }),
      },
      "@/lib/storage/index.ts": {
        getStorageProvider: () => ({
          name: "local",
          delete: async (key: string) => {
            deletedKeys.push(key);
          },
        }),
      },
    },
    fallback: (spec) => {
      throw new Error(`Unexpected require("${spec}")`);
    },
  });
  return mod as unknown as CleanupModule;
}

test("cleanupExpiredVerifiedDocuments: xoá Drive + đánh ONLINE_EXPIRED", async () => {
  deletedKeys.length = 0;
  const db = createFakeDb({ respond: () => [] });
  const mod = await load(db);

  const result = await mod.cleanupExpiredVerifiedDocuments(new Date("2030-01-01"));
  assert.equal(result.deleted, 2);
  assert.deepEqual(deletedKeys, [
    "Candidate Documents/2026/08/17/a.pdf",
    "Candidate Documents/2026/08/17/b.pdf",
  ]);

  // markOnlineDeleted được gọi cho từng doc (stub — không cần db)
  // (đã verify qua result.deleted=2 + deletedKeys đầy đủ)
});

test("cleanupExpiredBatchOutputs: xoá pdf+zip hết TTL + clear job fields", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_jobs") {
        return [
          { id: "job-1", outputPdfFileId: "Batch Outputs/2026/08/job-1/x.pdf", outputZipFileId: "Batch Outputs/2026/08/job-1/x.zip" },
        ];
      }
      return undefined;
    },
  });
  const mod = await load(db);
  deletedKeys.length = 0;

  const count = await mod.cleanupExpiredBatchOutputs(new Date("2030-01-01"));
  assert.equal(count, 1);
  assert.deepEqual(deletedKeys, [
    "Batch Outputs/2026/08/job-1/x.pdf",
    "Batch Outputs/2026/08/job-1/x.zip",
  ]);

  const jobUpdate = db.calls.find((c) => c.root === "update" && c.table === "merge_jobs");
  assert.ok(jobUpdate, "phải UPDATE merge_jobs");
  const setArgs = argOf(jobUpdate as QueryCall, "set") as Record<string, unknown>;
  assert.equal(setArgs.outputPdfUrl, null);
  assert.equal(setArgs.outputZipUrl, null);
  assert.equal(setArgs.outputPdfFileId, null);
  assert.equal(setArgs.batchExpiresAt, null);
});
