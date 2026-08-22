/**
 * PDF template version lifecycle — tests (PR2).
 * Chạy trên version-service.ts qua loadModule + fake-drizzle, stub ./pdf-storage.ts
 * (storage/pdf-lib đã test riêng). Bao phủ: lifecycle transitions, chỉ-1-PUBLISHED,
 * published immutability, integrity gate, transaction, storage failure, rollback.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createFakeDb,
  drizzleStub,
  makeTable,
  argOf,
  eqValue,
  type FakeDb,
  type QueryCall,
} from "../../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../../test-support/load-module.ts";

const schemaStub = {
  pdfTemplateVersions: makeTable("pdf_template_versions"),
};

type StoredFake = {
  key: string;
  sha256: string;
  pageCount: number;
  pageLayout: { pageNumber: number; width: number; height: number; rotation: number }[];
  size: number;
};

const STORED: StoredFake = {
  key: "document-templates/pdf/tpl-1/v1.pdf",
  sha256: "a".repeat(64),
  pageCount: 1,
  pageLayout: [{ pageNumber: 1, width: 595.28, height: 841.89, rotation: 0 }],
  size: 1234,
};

class BlankPdfErrorFake extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BlankPdfError";
    this.status = status;
  }
}

type PdfStorageStub = {
  BlankPdfError: typeof BlankPdfErrorFake;
  storeBlankPdf: (templateId: string, version: number, bytes: Uint8Array, opts?: unknown) => Promise<StoredFake>;
  verifyBlankPdfIntegrity: (key: string, sha: string, opts?: unknown) => Promise<{ ok: boolean; sha256: string; expectedSha256: string }>;
};

function makePdfStorageStub(overrides: Partial<PdfStorageStub> = {}): PdfStorageStub {
  return {
    BlankPdfError: BlankPdfErrorFake,
    storeBlankPdf: async () => STORED,
    verifyBlankPdfIntegrity: async (_k, sha) => ({ ok: true, sha256: sha, expectedSha256: sha }),
    ...overrides,
  };
}

type VersionModule = {
  PDF_TEMPLATE_VERSION_STATUS: Record<string, string>;
  PDF_VERSION_TRANSITIONS: Record<string, string[]>;
  canTransition: (from: string, to: string) => boolean;
  createPdfTemplateVersion: (
    templateId: string,
    createdBy: string,
    input: { blankPdfBytes: Uint8Array; blankPdfFileName?: string; sourceNote?: string | null },
    opts?: { storage?: unknown },
  ) => Promise<Record<string, unknown>>;
  listPdfTemplateVersions: (templateId: string) => Promise<Record<string, unknown>[]>;
  getPdfTemplateVersion: (templateId: string, versionId: string) => Promise<Record<string, unknown> | null>;
  getPublishedPdfTemplateVersion: (templateId: string) => Promise<Record<string, unknown> | null>;
  publishPdfTemplateVersion: (templateId: string, versionId: string, createdBy: string, opts?: { storage?: unknown }) => Promise<Record<string, unknown>>;
  archivePdfTemplateVersion: (templateId: string, versionId: string) => Promise<Record<string, unknown>>;
  PdfTemplateVersionError: new (message: string, status?: number) => Error & { status: number };
};

function makeDefaultStorage(): { name: string; delete: (k: string) => Promise<void> } {
  return { name: "default", delete: async () => {} };
}

async function load(db: FakeDb, pdfStorage: PdfStorageStub = makePdfStorageStub()): Promise<VersionModule> {
  const mod = await loadModule(new URL("./version-service.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/storage": {
        getStorageProvider: () => makeDefaultStorage(),
      },
      "./pdf-storage.ts": pdfStorage,
    },
  });
  return mod as unknown as VersionModule;
}

function draftVersion(id = "v1", version = 1, status = "DRAFT"): Record<string, unknown> {
  return {
    id,
    templateId: "tpl-1",
    version,
    status,
    pdfStorageKey: `document-templates/pdf/tpl-1/v${version}.pdf`,
    sha256: "a".repeat(64),
    pageCount: 1,
    pageLayout: [{ pageNumber: 1, width: 595.28, height: 841.89, rotation: 0 }],
    createdBy: "admin",
  };
}

test("PDF_VERSION_TRANSITIONS: DRAFT→PUBLISHED/ARCHIVED, PUBLISHED→ARCHIVED, ARCHIVED→PUBLISHED; ARCHIVED không về DRAFT", async () => {
  const mod = await load(createFakeDb({ respond: () => [] }));
  assert.deepEqual([...mod.PDF_VERSION_TRANSITIONS.DRAFT].sort(), ["ARCHIVED", "PUBLISHED"]);
  assert.deepEqual([...mod.PDF_VERSION_TRANSITIONS.ARCHIVED], ["PUBLISHED"]);
  assert.equal(mod.canTransition("DRAFT", "PUBLISHED"), true);
  assert.equal(mod.canTransition("ARCHIVED", "PUBLISHED"), true); // rollback
  assert.equal(mod.canTransition("ARCHIVED", "DRAFT"), false); // archived không thể âm thầm editable
  assert.equal(mod.canTransition("PUBLISHED", "DRAFT"), false); // published immutable
});

test("createPdfTemplateVersion: tạo DRAFT + upload blank PDF + lưu sha256/page metadata", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select") return []; // chưa có version nào
      if (call.root === "insert") {
        return [{ ...draftVersion("v-new", 1, "DRAFT") }];
      }
      return undefined;
    },
  });
  const mod = await load(db);

  const created = await mod.createPdfTemplateVersion("tpl-1", "admin", { blankPdfBytes: new Uint8Array([1, 2, 3]) });
  assert.equal(created.version, 1);
  assert.equal(created.status, "DRAFT");

  const insert = db.calls.find((c) => c.root === "insert");
  assert.ok(insert, "phải INSERT version");
  const values = argOf(insert as QueryCall, "values") as Record<string, unknown>;
  assert.equal(values.templateId, "tpl-1");
  assert.equal(values.status, "DRAFT");
  assert.equal(values.sha256, STORED.sha256);
  assert.equal(values.pageCount, STORED.pageCount);
  assert.equal(values.pdfStorageKey, STORED.key);
});

test("createPdfTemplateVersion: version tăng dần (max+1)", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select") return [{ version: 1 }, { version: 3 }];
      if (call.root === "insert") return [{ ...draftVersion("v4", 4, "DRAFT") }];
      return undefined;
    },
  });
  const mod = await load(db);
  const created = await mod.createPdfTemplateVersion("tpl-1", "admin", { blankPdfBytes: new Uint8Array(1) });
  assert.equal(created.version, 4);
});

test("createPdfTemplateVersion: storage failure → lan truyền, KHÔNG insert DB", async () => {
  const db = createFakeDb({ respond: (call) => (call.root === "select" ? [] : undefined) });
  const storage = makePdfStorageStub({
    storeBlankPdf: async () => {
      throw new Error("STORAGE_UPLOAD_FAIL");
    },
  });
  const mod = await load(db, storage);

  await assert.rejects(() => mod.createPdfTemplateVersion("tpl-1", "admin", { blankPdfBytes: new Uint8Array(1) }), /STORAGE_UPLOAD_FAIL/);
  assert.equal(db.calls.filter((c) => c.root === "insert").length, 0, "không được INSERT khi upload thất bại");
});

test("createPdfTemplateVersion: DB insert thất bại → best-effort xoá object đã upload", async () => {
  const deleted: string[] = [];
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select") return [];
      if (call.root === "insert") throw new Error("DB_INSERT_FAIL");
      return undefined;
    },
  });
  const storage = makePdfStorageStub();
  const mod = await load(db, storage);
  // inject storage có ghi nhận delete
  const wrappedStorage = { delete: async (k: string) => { deleted.push(k); } };
  await assert.rejects(
    () => mod.createPdfTemplateVersion("tpl-1", "admin", { blankPdfBytes: new Uint8Array(1) }, { storage: wrappedStorage }),
    /DB_INSERT_FAIL/,
  );
  assert.deepEqual(deleted, [STORED.key]);
});

test("publishPdfTemplateVersion: DRAFT → PUBLISHED, archive PUBLISHED cũ, atomic", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select") {
        const id = eqValue(call, "pdf_template_versions.id");
        // target version (query theo id) → v2 DRAFT
        if (id === "v2") return [draftVersion("v2", 2, "DRAFT")];
        // previous PUBLISHED (query chỉ theo templateId + status, không id) → v1
        return [draftVersion("v1", 1, "PUBLISHED")];
      }
      if (call.root === "update") {
        return [draftVersion("v2", 2, "PUBLISHED")];
      }
      return undefined;
    },
  });
  const mod = await load(db);

  const published = await mod.publishPdfTemplateVersion("tpl-1", "v2", "admin");
  assert.equal(published.status, "PUBLISHED");
  assert.equal(db.transactions, 1, "publish phải chạy trong 1 transaction (atomic)");

  // version cũ v1 → ARCHIVED + supersededBy = 2
  const v1Update = db.calls.find(
    (c) => c.root === "update" && eqValue(c, "pdf_template_versions.id") === "v1",
  );
  assert.ok(v1Update, "phải UPDATE version cũ");
  const setArgs = argOf(v1Update as QueryCall, "set") as Record<string, unknown>;
  assert.equal(setArgs.status, "ARCHIVED");
  assert.equal(setArgs.supersededBy, 2);
});

test("publishPdfTemplateVersion: integrity gate — blank PDF corrupt → reject, KHÔNG mở transaction/ghi DB", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" ? [draftVersion("v2", 2, "DRAFT")] : undefined),
  });
  const storage = makePdfStorageStub({
    verifyBlankPdfIntegrity: async () => ({ ok: false, sha256: "b".repeat(64), expectedSha256: "a".repeat(64) }),
  });
  const mod = await load(db, storage);

  await assert.rejects(
    () => mod.publishPdfTemplateVersion("tpl-1", "v2", "admin"),
    (err: Error & { status?: number }) => err.status === 409,
  );
  assert.equal(db.transactions, 0, "gate thất bại → không mở transaction");
  assert.equal(db.writes.length, 0, "gate thất bại → không ghi DB");
});

test("publishPdfTemplateVersion: idempotent khi đã PUBLISHED (không ghi lại)", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" ? [draftVersion("v1", 1, "PUBLISHED")] : undefined),
  });
  const mod = await load(db);

  const result = await mod.publishPdfTemplateVersion("tpl-1", "v1", "admin");
  assert.equal(result.status, "PUBLISHED");
  assert.equal(db.writes.length, 0, "đã PUBLISHED → no-op, không ghi");
});

test("publishPdfTemplateVersion: 404 khi version không tồn tại", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = await load(db);
  await assert.rejects(
    () => mod.publishPdfTemplateVersion("tpl-1", "missing", "admin"),
    (err: Error & { status?: number }) => err.status === 404,
  );
});

test("archivePdfTemplateVersion: DRAFT → ARCHIVED", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select") return [draftVersion("v2", 2, "DRAFT")];
      if (call.root === "update") return [draftVersion("v2", 2, "ARCHIVED")];
      return undefined;
    },
  });
  const mod = await load(db);
  const archived = await mod.archivePdfTemplateVersion("tpl-1", "v2");
  assert.equal(archived.status, "ARCHIVED");
  assert.equal(db.transactions, 1);
});

test("archivePdfTemplateVersion: TỪ CHỐI archive version đang PUBLISHED", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" ? [draftVersion("v1", 1, "PUBLISHED")] : undefined),
  });
  const mod = await load(db);
  await assert.rejects(
    () => mod.archivePdfTemplateVersion("tpl-1", "v1"),
    (err: Error) => err.message.includes("đang PUBLISHED"),
  );
});

test("getPublishedPdfTemplateVersion: trả version PUBLISHED hoặc null", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" ? [draftVersion("v1", 1, "PUBLISHED")] : undefined),
  });
  const mod = await load(db);
  assert.equal((await mod.getPublishedPdfTemplateVersion("tpl-1"))?.status, "PUBLISHED");
});
