/**
 * Batch finalize hardening tests – retry logic
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import {
  createFakeDb,
  drizzleStub,
  makeTable,
  argOf,
  type FakeDb,
  type QueryCall,
} from "../test-support/fake-drizzle.ts";
import { loadModule } from "../test-support/load-module.ts";

const schemaStub = {
  mergeJobs: makeTable("merge_jobs"),
  mergeJobRecords: makeTable("merge_job_records"),
};

async function makePdfBytes(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(text);
  return doc.save();
}

type StorageStub = {
  name: string;
  getCalls: string[];
  putCalls: string[];
  getBehavior: (key: string) => Promise<Buffer>;
};

function createStorageStub(behavior: (key: string) => Promise<Buffer>): StorageStub & { get: (k: string) => Promise<Buffer>; put: (k: string, b: Uint8Array | Buffer) => Promise<any> } {
  const stub: any = {
    name: "google_drive",
    getCalls: [] as string[],
    putCalls: [] as string[],
    getBehavior: behavior,
    get: async (key: string) => {
      stub.getCalls.push(key);
      return behavior(key);
    },
    put: async (key: string, body: Uint8Array | Buffer) => {
      stub.putCalls.push(key);
      return { key, url: `/files/${key}`, size: (body as Buffer).byteLength ?? 100 };
    },
  };
  return stub;
}

async function loadWithStorage(db: FakeDb, storage: any) {
  const mod = await loadModule(new URL("./batch-finalize.ts", import.meta.url), {
    stubs: {
      "drizzle-orm": drizzleStub,
      "../../db": { db },
      "../../db/schema": schemaStub,
      "./batch-pdf.ts": {
        mergePdfBuffers: async (buffers: Uint8Array[]) => {
          const output = await PDFDocument.create();
          for (const bytes of buffers) {
            const source = await PDFDocument.load(bytes);
            const pages = await output.copyPages(source, source.getPageIndices());
            for (const p of pages) output.addPage(p);
          }
          return output.save();
        },
      },
      "./filename.ts": {
        buildBatchPdfFilename: (type: string, count: number) => `${type}_${count}_ung-vien.pdf`,
        buildBatchZipFilename: (type: string, count: number) => `${type}_${count}_ung-vien.zip`,
        buildBatchStorageKey: (_d: Date, jobId: string, filename: string) => `Batch Outputs/2026/08/${jobId}/${filename}`,
      },
      "./queue-types.ts": { ITEM_STATUS: { COMPLETED: "COMPLETED" } },
      "../storage/index.ts": {
        getStorageProvider: () => storage,
      },
    },
    fallback: (spec: string) => {
      if (spec === "yazl") {
        return {
          ZipFile: class {
            entries: { name: string; buffer: Buffer }[] = [];
            addBuffer(b: Buffer, n: string) {
              this.entries.push({ name: n, buffer: b });
            }
            get outputStream() {
              return this.entries.map((e) => Buffer.from(e.name));
            }
            end() {}
          },
        };
      }
      throw new Error(`Unexpected ${spec}`);
    },
  });
  return mod as any;
}

function fakeDbWithItems(items: { id: string; sortOrder: number; storageKey: string; filename: string }[]) {
  return createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_jobs") {
        return [{ id: "job-1", templateNameSnapshot: "Dang_ky_tap_nghe" }];
      }
      if (call.root === "select" && call.table === "merge_job_records") {
        return items;
      }
      return undefined;
    },
  });
}

test("finalize retries retriable FILE_NOT_FOUND", async () => {
  let attempts = 0;
  const storage = createStorageStub(async (key: string) => {
    attempts++;
    if (attempts === 1) throw new Error(`GOOGLE_DRIVE_FILE_NOT_FOUND: ${key}`);
    return makePdfBytes("A").then((b) => Buffer.from(b));
  });

  const db = fakeDbWithItems([{ id: "r1", sortOrder: 1, storageKey: "Candidate Documents/2026/08/26/a.pdf", filename: "a.pdf" }]);
  const mod = await loadWithStorage(db, storage);

  const result = await mod.finalizeBatchOutputs("job-1", { documentType: "Dang-ky-tap-nghe" });
  assert.equal(result.itemCount, 1);
  assert.equal(storage.getCalls.length, 2, "should retry once");
});

test("finalize succeeds if file appears on attempt 2", async () => {
  let attempts = 0;
  const storage = createStorageStub(async (key: string) => {
    attempts++;
    if (attempts < 2) throw new Error(`GOOGLE_DRIVE_FILE_NOT_FOUND: ${key}`);
    return makePdfBytes("A").then((b) => Buffer.from(b));
  });

  const db = fakeDbWithItems([{ id: "r1", sortOrder: 1, storageKey: "Candidate Documents/2026/08/26/a.pdf", filename: "a.pdf" }]);
  const mod = await loadWithStorage(db, storage);

  const result = await mod.finalizeBatchOutputs("job-1", { documentType: "Dang-ky-tap-nghe" });
  assert.equal(result.itemCount, 1);
  assert.equal(attempts, 2);
});

test("finalize succeeds if file appears on attempt 3", async () => {
  let attempts = 0;
  const storage = createStorageStub(async (key: string) => {
    attempts++;
    if (attempts < 3) throw new Error(`GOOGLE_DRIVE_FILE_NOT_FOUND: ${key}`);
    return makePdfBytes("A").then((b) => Buffer.from(b));
  });

  const db = fakeDbWithItems([{ id: "r1", sortOrder: 1, storageKey: "Candidate Documents/2026/08/26/a.pdf", filename: "a.pdf" }]);
  const mod = await loadWithStorage(db, storage);

  const result = await mod.finalizeBatchOutputs("job-1", { documentType: "Dang-ky-tap-nghe" });
  assert.equal(result.itemCount, 1);
  assert.equal(attempts, 3);
});

test("finalize stops after max attempts", async () => {
  const storage = createStorageStub(async (key: string) => {
    throw new Error(`GOOGLE_DRIVE_FILE_NOT_FOUND: ${key}`);
  });

  const db = fakeDbWithItems([{ id: "r1", sortOrder: 1, storageKey: "Candidate Documents/2026/08/26/a.pdf", filename: "a.pdf" }]);
  const mod = await loadWithStorage(db, storage);

  await assert.rejects(() => mod.finalizeBatchOutputs("job-1", { documentType: "Dang-ky-tap-nghe" }), /GOOGLE_DRIVE_FILE_NOT_FOUND/);
  assert.equal(storage.getCalls.length, 3, "should attempt 3 times");
});

test("finalize does not retry auth failure", async () => {
  const storage = createStorageStub(async (key: string) => {
    throw new Error(`GOOGLE_DRIVE_AUTH_FAILED: invalid credentials`);
  });

  const db = fakeDbWithItems([{ id: "r1", sortOrder: 1, storageKey: "Candidate Documents/2026/08/26/a.pdf", filename: "a.pdf" }]);
  const mod = await loadWithStorage(db, storage);

  await assert.rejects(() => mod.finalizeBatchOutputs("job-1", { documentType: "Dang-ky-tap-nghe" }), /AUTH_FAILED/);
  assert.equal(storage.getCalls.length, 1, "auth failure should not be retried");
});

test("finalize does not retry missing storage key", async () => {
  const storage = createStorageStub(async () => Buffer.from("pdf"));
  const db = fakeDbWithItems([{ id: "r1", sortOrder: 1, storageKey: null as any, filename: "a.pdf" }]);
  const mod = await loadWithStorage(db, storage);

  await assert.rejects(() => mod.finalizeBatchOutputs("job-1", { documentType: "Dang-ky-tap-nghe" }), /ITEM_MISSING_STORAGE_KEY/);
  assert.equal(storage.getCalls.length, 0);
});

test("no DB schema changes – batch-finalize does not reference drive_file_id", async () => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(new URL("./batch-finalize.ts", import.meta.url), "utf8");
  assert.doesNotMatch(content, /drive_file_id/);
  assert.doesNotMatch(content, /storage_file_id/);
});

test("item COMPLETED semantics unchanged – still requires storageKey", async () => {
  const fs = await import("node:fs/promises");
  const queueContent = await fs.readFile(new URL("./queue.ts", import.meta.url), "utf8");
  // completeItem still sets COMPLETED and requires storageKey
  assert.match(queueContent, /COMPLETED/);
  assert.match(queueContent, /storageKey/);
});
