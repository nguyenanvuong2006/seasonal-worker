/**
 * Blank PDF storage + integrity — tests (PR2).
 * Chạy trên pdf-storage.ts qua loadModule (stub "@/lib/storage"), pdf-lib THẬT
 * để verify validate nội dung PDF. Bao phủ: SHA-256, magic bytes, page layout,
 * chống ghi đè, storage failure, corrupted/replaced PDF detection.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";

import { loadModule } from "../../test-support/load-module.ts";
import type { StorageProvider, StoredObject } from "@/lib/storage/types";

/** Fake in-memory StorageProvider — soi hành vi + bơm lỗi. */
function makeFakeStorage(): StorageProvider & {
  objects: Map<string, Uint8Array>;
  failPut?: boolean;
  failGet?: boolean;
} {
  const objects = new Map<string, Uint8Array>();
  const storage = {
    name: "fake",
    objects,
    failPut: false,
    failGet: false,
    async put(key: string, body: Uint8Array | Buffer, contentType?: string): Promise<StoredObject> {
      if (storage.failPut) throw new Error("STORAGE_PUT_FAIL");
      objects.set(key, new Uint8Array(body));
      return { key, url: `fake://${key}`, size: body.byteLength, contentType };
    },
    async get(key: string): Promise<Buffer> {
      if (storage.failGet) throw new Error("STORAGE_GET_FAIL");
      const v = objects.get(key);
      if (!v) throw new Error(`STORAGE_NOT_FOUND: ${key}`);
      return Buffer.from(v);
    },
    async delete(key: string): Promise<void> {
      objects.delete(key);
    },
    async exists(key: string): Promise<boolean> {
      return objects.has(key);
    },
    async getSignedUrl(key: string): Promise<string> {
      return `fake://${key}`;
    },
    async getMetadata(key: string) {
      const v = objects.get(key);
      return v ? { size: v.byteLength } : null;
    },
  };
  return storage;
}

type StorageModule = {
  sha256Hex: (bytes: Uint8Array | Buffer) => string;
  pdfStorageKey: (templateId: string, version: number) => string;
  assertPdfMagic: (bytes: Uint8Array) => void;
  inspectBlankPdf: (bytes: Uint8Array) => Promise<{ pageCount: number; pageLayout: { pageNumber: number; width: number; height: number; rotation: number }[] }>;
  storeBlankPdf: (templateId: string, version: number, bytes: Uint8Array, opts?: { storage?: StorageProvider }) => Promise<{ key: string; sha256: string; pageCount: number; pageLayout: unknown[]; size: number }>;
  retrieveBlankPdf: (key: string, opts?: { storage?: StorageProvider }) => Promise<Buffer>;
  verifyBlankPdfIntegrity: (key: string, expectedSha256: string, opts?: { storage?: StorageProvider; expectedPageCount?: number }) => Promise<{ ok: boolean; sha256: string; expectedSha256: string; pageCount?: number }>;
  BlankPdfError: new (message: string, status?: number) => Error & { status: number };
};

async function load(): Promise<StorageModule> {
  const mod = await loadModule(new URL("./pdf-storage.ts", import.meta.url), {
    stubs: {
      "node:crypto": crypto,
      "pdf-lib": { PDFDocument },
      "@/lib/storage": {
        getStorageProvider: () => {
          throw new Error("getStorageProvider không được gọi trong test — luôn inject storage.");
        },
      },
    },
  });
  return mod as unknown as StorageModule;
}

async function makeValidPdf(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([595.28, 841.89]);
  return doc.save();
}

test("sha256Hex: khớp giá trị SHA-256 đã biết", async () => {
  const mod = await load();
  // SHA-256("abc") chuẩn.
  assert.equal(
    mod.sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("pdfStorageKey: versioned + deterministic", async () => {
  const mod = await load();
  assert.equal(mod.pdfStorageKey("tpl-1", 3), "document-templates/pdf/tpl-1/v3.pdf");
  assert.notEqual(mod.pdfStorageKey("tpl-1", 1), mod.pdfStorageKey("tpl-1", 2));
});

test("assertPdfMagic: chặn bytes không phải PDF", async () => {
  const mod = await load();
  assert.doesNotThrow(() => mod.assertPdfMagic(new TextEncoder().encode("%PDF-1.7\n...")));
  assert.throws(() => mod.assertPdfMagic(new Uint8Array(0)), mod.BlankPdfError);
  assert.throws(() => mod.assertPdfMagic(new TextEncoder().encode("not a pdf at all")), mod.BlankPdfError);
});

test("inspectBlankPdf: trích page_count + layout từ PDF hợp lệ", async () => {
  const mod = await load();
  const pdf = await makeValidPdf(2);
  const { pageCount, pageLayout } = await mod.inspectBlankPdf(pdf);
  assert.equal(pageCount, 2);
  assert.equal(pageLayout.length, 2);
  assert.equal(pageLayout[0].pageNumber, 1);
  assert.ok(Math.abs(pageLayout[0].width - 595.28) < 0.5);
  assert.ok(Math.abs(pageLayout[0].height - 841.89) < 0.5);
});

test("inspectBlankPdf: ném BlankPdfError với file hỏng/corrupt", async () => {
  const mod = await load();
  const corrupt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0x01, 0x02]);
  await assert.rejects(() => mod.inspectBlankPdf(corrupt), mod.BlankPdfError);
});

test("storeBlankPdf: lưu + tính SHA-256 + page metadata", async () => {
  const mod = await load();
  const storage = makeFakeStorage();
  const pdf = await makeValidPdf(1);
  const result = await mod.storeBlankPdf("tpl-1", 1, pdf, { storage });
  assert.equal(result.key, "document-templates/pdf/tpl-1/v1.pdf");
  assert.equal(result.sha256, mod.sha256Hex(pdf));
  assert.equal(result.pageCount, 1);
  assert.equal(storage.objects.has(result.key), true);
});

test("storeBlankPdf: KHÔNG ghi đè key đã tồn tại (immutable)", async () => {
  const mod = await load();
  const storage = makeFakeStorage();
  const pdf = await makeValidPdf(1);
  await mod.storeBlankPdf("tpl-1", 1, pdf, { storage });
  // version khác → key khác → OK
  await mod.storeBlankPdf("tpl-1", 2, pdf, { storage });
  // cùng key (version 1 lại) → phải reject 409
  await assert.rejects(() => mod.storeBlankPdf("tpl-1", 1, pdf, { storage }), (e: Error) => {
    return e instanceof mod.BlankPdfError && (e as Error & { status: number }).status === 409;
  });
});

test("storeBlankPdf: storage failure lan truyền (không nuốt)", async () => {
  const mod = await load();
  const storage = makeFakeStorage();
  storage.failPut = true;
  const pdf = await makeValidPdf(1);
  await assert.rejects(() => mod.storeBlankPdf("tpl-1", 1, pdf, { storage }), /STORAGE_PUT_FAIL/);
});

test("retrieveBlankPdf: đọc bytes theo key", async () => {
  const mod = await load();
  const storage = makeFakeStorage();
  const pdf = await makeValidPdf(1);
  await mod.storeBlankPdf("tpl-1", 1, pdf, { storage });
  const bytes = await mod.retrieveBlankPdf("document-templates/pdf/tpl-1/v1.pdf", { storage });
  assert.deepEqual(new Uint8Array(bytes), pdf);
});

test("verifyBlankPdfIntegrity: ok khi bytes khớp SHA-256 đã lưu", async () => {
  const mod = await load();
  const storage = makeFakeStorage();
  const pdf = await makeValidPdf(1);
  const stored = await mod.storeBlankPdf("tpl-1", 1, pdf, { storage });
  const result = await mod.verifyBlankPdfIntegrity(stored.key, stored.sha256, { storage, expectedPageCount: 1 });
  assert.equal(result.ok, true);
});

test("verifyBlankPdfIntegrity: PHÁT HIỆN PDF bị thay/corrupt (SHA-256 không khớp)", async () => {
  const mod = await load();
  const storage = makeFakeStorage();
  const pdf = await makeValidPdf(1);
  const stored = await mod.storeBlankPdf("tpl-1", 1, pdf, { storage });
  // thay nội dung object bằng PDF KHÁC (kích thước trang khác → bytes khác)
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const other = await doc.save();
  storage.objects.set(stored.key, other);
  const result = await mod.verifyBlankPdfIntegrity(stored.key, stored.sha256, { storage });
  assert.equal(result.ok, false);
  assert.notEqual(result.sha256, result.expectedSha256);
});

test("verifyBlankPdfIntegrity: PHÁT HIỆN page_count không khớp", async () => {
  const mod = await load();
  const storage = makeFakeStorage();
  const pdf = await makeValidPdf(1);
  const stored = await mod.storeBlankPdf("tpl-1", 1, pdf, { storage });
  const result = await mod.verifyBlankPdfIntegrity(stored.key, stored.sha256, { storage, expectedPageCount: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.pageCount, 1);
});

test("verifyBlankPdfIntegrity: storage failure lan truyền", async () => {
  const mod = await load();
  const storage = makeFakeStorage();
  const pdf = await makeValidPdf(1);
  const stored = await mod.storeBlankPdf("tpl-1", 1, pdf, { storage });
  storage.failGet = true;
  await assert.rejects(() => mod.verifyBlankPdfIntegrity(stored.key, stored.sha256, { storage }), /STORAGE_GET_FAIL/);
});
