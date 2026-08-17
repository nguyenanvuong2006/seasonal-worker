/**
 * Batch finalize — tests (Phase 10).
 * - buildZipBuffer: entry name 001_..., 002_... theo thứ tự.
 * - finalizeBatchOutputs: download theo storageKey → merge PDF → upload PDF tổng + ZIP
 *   → ghi job (urls + file ids + batch_expires_at) — dùng fake-drizzle + stub storage.
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
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

const schemaStub = {
  mergeJobs: makeTable("merge_jobs"),
  mergeJobRecords: makeTable("merge_job_records"),
};

type BatchFinalizeModule = {
  buildZipBuffer: (entries: { filename: string; bytes: Uint8Array }[]) => Promise<Buffer>;
  finalizeBatchOutputs: (
    jobId: string,
    opts?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

async function makePdfBytes(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  page.drawText(text);
  return doc.save();
}

async function load(db: FakeDb): Promise<BatchFinalizeModule> {
  const mod = await loadModule(new URL("./batch-finalize.ts", import.meta.url), {
    stubs: {
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
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
      "@/lib/storage/index.ts": {
        getStorageProvider: () => ({
          name: "local",
          get: async (key: string) => {
            const map = {
              "Candidate Documents/2026/08/17/a.pdf": await makePdfBytes("A"),
              "Candidate Documents/2026/08/17/b.pdf": await makePdfBytes("B"),
            };
            return map[key as keyof typeof map] ?? Buffer.alloc(0);
          },
          put: async (key: string, body: Uint8Array | Buffer) => ({
            key,
            url: `/files/${key}`,
            size: body.byteLength,
            contentType: "application/pdf",
          }),
        }),
      },
    },
    fallback: (spec) => {
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
      throw new Error(`Unexpected require("${spec}")`);
    },
  });
  return mod as unknown as BatchFinalizeModule;
}

test("buildZipBuffer: entry name 001_, 002_ theo thứ tự", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = await load(db);
  const zip = await mod.buildZipBuffer([
    { filename: "20260817_Nguyen-Van-An.pdf", bytes: new Uint8Array([1]) },
    { filename: "20260817_Tran-Thi-B.pdf", bytes: new Uint8Array([2]) },
  ]);
  assert.equal(
    zip.toString("utf8"),
    "001_20260817_Nguyen-Van-An.pdf002_20260817_Tran-Thi-B.pdf",
  );
});

test("finalizeBatchOutputs: gộp PDF + ZIP + ghi job (urls, file ids, batch TTL)", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_jobs") {
        return [{ id: "job-1", templateNameSnapshot: "Dang_ky_tap_nghe" }];
      }
      if (call.root === "select" && call.table === "merge_job_records") {
        return [
          { id: "r1", sortOrder: 1, storageKey: "Candidate Documents/2026/08/17/a.pdf", filename: "a.pdf" },
          { id: "r2", sortOrder: 2, storageKey: "Candidate Documents/2026/08/17/b.pdf", filename: "b.pdf" },
        ];
      }
      return undefined;
    },
  });
  const mod = await load(db);

  const result = await mod.finalizeBatchOutputs("job-1", { documentType: "Dang-ky-tap-nghe" });
  assert.equal(result.itemCount, 2);
  assert.match(String(result.pdfKey), /Batch Outputs\/2026\/08\/job-1\/Dang-ky-tap-nghe_2_ung-vien\.pdf/);
  assert.match(String(result.zipKey), /\.zip$/);

  // Job update: urls + file ids + batch_expires_at
  const jobUpdate = db.calls.find((c) => c.root === "update" && c.table === "merge_jobs");
  assert.ok(jobUpdate, "phải UPDATE merge_jobs");
  const setArgs = argOf(jobUpdate as QueryCall, "set") as Record<string, unknown>;
  assert.match(String(setArgs.outputPdfUrl), /Batch Outputs/);
  assert.match(String(setArgs.outputZipUrl), /\.zip/);
  assert.match(String(setArgs.outputPdfFileId), /Batch Outputs\/2026\/08\/job-1\/.*\.pdf$/);
  assert.match(String(setArgs.outputZipFileId), /\.zip$/);
  assert.ok(setArgs.batchExpiresAt instanceof Date, "batchExpiresAt phải là Date (TTL batch)");
});
