/**
 * Field-position management — tests (PR2).
 * Chạy trên position-service.ts qua loadModule + fake-drizzle, validation.ts THẬT
 * (inject làm stub) để test tích hợp validate. Bao phủ: CRUD, immutability theo
 * status version, duplicate, invalid geometry/page, bulk upsert, transaction.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createFakeDb,
  drizzleStub,
  makeTable,
  eqValue,
  argOf,
  type FakeDb,
  type QueryCall,
} from "../../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../../test-support/load-module.ts";
import * as validation from "./validation.ts";

const schemaStub = {
  pdfTemplateVersions: makeTable("pdf_template_versions"),
  pdfFieldPositions: makeTable("pdf_field_positions"),
};

type PositionModule = {
  createPdfFieldPosition: (versionId: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  listPdfFieldPositions: (versionId: string) => Promise<Record<string, unknown>[]>;
  getPdfFieldPosition: (versionId: string, positionId: string) => Promise<Record<string, unknown> | null>;
  updatePdfFieldPosition: (versionId: string, positionId: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deletePdfFieldPosition: (versionId: string, positionId: string) => Promise<void>;
  upsertPdfFieldPositions: (versionId: string, inputs: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>;
  PdfFieldPositionError: new (message: string, status?: number) => Error & { status: number };
};

async function load(db: FakeDb): Promise<PositionModule> {
  const mod = await loadModule(new URL("./position-service.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "./validation.ts": validation,
    },
  });
  return mod as unknown as PositionModule;
}

function versionRow(status = "DRAFT"): Record<string, unknown> {
  return {
    id: "ver-1",
    templateId: "tpl-1",
    version: 1,
    status,
    pdfStorageKey: "document-templates/pdf/tpl-1/v1.pdf",
    sha256: "a".repeat(64),
    pageCount: 1,
    pageLayout: [{ pageNumber: 1, width: 595.28, height: 841.89, rotation: 0 }],
  };
}

const POS = {
  placeholder: "Ho_ten",
  pageNumber: 1,
  x: 50,
  y: 700,
  width: 200,
  height: 20,
  type: "TEXT",
};

function positionRow(id = "p1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    pdfTemplateVersionId: "ver-1",
    placeholder: "Ho_ten",
    pageNumber: 1,
    x: 50,
    y: 700,
    width: 200,
    height: 20,
    type: "TEXT",
    fontSize: 10,
    align: "left",
    valign: "top",
    overflowPolicy: "FAIL",
    renderOrder: 0,
    ...overrides,
  };
}

/** respond mặc định: version DRAFT + không có position nào. */
function defaultRespond(call: QueryCall): unknown {
  if (call.table === "pdf_template_versions") return [versionRow("DRAFT")];
  if (call.table === "pdf_field_positions") {
    if (call.root === "insert") return [positionRow("p-new")];
    if (call.root === "update") return [positionRow()];
    return [];
  }
  return undefined;
}

test("createPdfFieldPosition: tạo trên version DRAFT (validate + defaults)", async () => {
  const db = createFakeDb({ respond: defaultRespond });
  const mod = await load(db);

  const created = await mod.createPdfFieldPosition("ver-1", { ...POS });
  assert.equal(created.id, "p-new");

  const insert = db.calls.find((c) => c.root === "insert" && c.table === "pdf_field_positions");
  assert.ok(insert);
  const values = argOf(insert as QueryCall, "values") as Record<string, unknown>;
  assert.equal(values.pdfTemplateVersionId, "ver-1");
  assert.equal(values.placeholder, "Ho_ten");
  assert.equal(values.type, "TEXT");
});

test("createPdfFieldPosition: TỪ CHỐI trên version PUBLISHED (immutability)", async () => {
  const db = createFakeDb({
    respond: (call) => (call.table === "pdf_template_versions" ? [versionRow("PUBLISHED")] : undefined),
  });
  const mod = await load(db);

  await assert.rejects(
    () => mod.createPdfFieldPosition("ver-1", { ...POS }),
    (err: Error & { status?: number }) => err.status === 409 && err.message.includes("DRAFT"),
  );
  assert.equal(db.calls.filter((c) => c.root === "insert").length, 0, "không insert trên version PUBLISHED");
});

test("createPdfFieldPosition: TỪ CHỐI trên version ARCHIVED", async () => {
  const db = createFakeDb({
    respond: (call) => (call.table === "pdf_template_versions" ? [versionRow("ARCHIVED")] : undefined),
  });
  const mod = await load(db);
  await assert.rejects(
    () => mod.createPdfFieldPosition("ver-1", { ...POS }),
    (err: Error & { status?: number }) => err.status === 409,
  );
});

test("createPdfFieldPosition: invalid geometry bị validation chặn (không insert)", async () => {
  const db = createFakeDb({ respond: defaultRespond });
  const mod = await load(db);
  // box nằm ngoài trang (x + width vượt quá width trang)
  await assert.rejects(
    () => mod.createPdfFieldPosition("ver-1", { ...POS, x: 5000 }),
    (err: Error & { status?: number }) => err.status === 400,
  );
  assert.equal(db.calls.filter((c) => c.root === "insert").length, 0);
});

test("createPdfFieldPosition: invalid page number bị chặn", async () => {
  const db = createFakeDb({ respond: defaultRespond });
  const mod = await load(db);
  await assert.rejects(
    () => mod.createPdfFieldPosition("ver-1", { ...POS, pageNumber: 99 }),
    (err: Error & { status?: number }) => err.status === 400,
  );
});

test("createPdfFieldPosition: duplicate position bị chặn (409)", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.table === "pdf_template_versions") return [versionRow("DRAFT")];
      // duplicate check thấy position đã tồn tại
      if (call.table === "pdf_field_positions" && call.root === "select") return [positionRow()];
      return undefined;
    },
  });
  const mod = await load(db);
  await assert.rejects(
    () => mod.createPdfFieldPosition("ver-1", { ...POS }),
    (err: Error & { status?: number }) => err.status === 409,
  );
  assert.equal(db.calls.filter((c) => c.root === "insert").length, 0);
});

test("updatePdfFieldPosition: merge + validate + update trên DRAFT", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.table === "pdf_template_versions") return [versionRow("DRAFT")];
      if (call.table === "pdf_field_positions") {
        if (call.root === "select") {
          const id = eqValue(call, "pdf_field_positions.id");
          return id === "p1" ? [positionRow("p1")] : [];
        }
        if (call.root === "update") return [positionRow("p1", { width: 300 })];
      }
      return undefined;
    },
  });
  const mod = await load(db);

  const updated = await mod.updatePdfFieldPosition("ver-1", "p1", { width: 300 });
  assert.equal(updated.width, 300);

  const update = db.calls.find((c) => c.root === "update" && c.table === "pdf_field_positions");
  const setArgs = argOf(update as QueryCall, "set") as Record<string, unknown>;
  assert.equal(setArgs.width, 300);
});

test("updatePdfFieldPosition: TỪ CHỐI trên version PUBLISHED", async () => {
  const db = createFakeDb({
    respond: (call) => (call.table === "pdf_template_versions" ? [versionRow("PUBLISHED")] : undefined),
  });
  const mod = await load(db);
  await assert.rejects(
    () => mod.updatePdfFieldPosition("ver-1", "p1", { width: 300 }),
    (err: Error & { status?: number }) => err.status === 409,
  );
});

test("deletePdfFieldPosition: xoá trên DRAFT", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.table === "pdf_template_versions") return [versionRow("DRAFT")];
      if (call.table === "pdf_field_positions") return [positionRow("p1")];
      return undefined;
    },
  });
  const mod = await load(db);
  await mod.deletePdfFieldPosition("ver-1", "p1");
  const del = db.calls.find((c) => c.root === "delete" && c.table === "pdf_field_positions");
  assert.ok(del, "phải DELETE position");
});

test("deletePdfFieldPosition: TỪ CHỐI trên version PUBLISHED", async () => {
  const db = createFakeDb({
    respond: (call) => (call.table === "pdf_template_versions" ? [versionRow("PUBLISHED")] : undefined),
  });
  const mod = await load(db);
  await assert.rejects(
    () => mod.deletePdfFieldPosition("ver-1", "p1"),
    (err: Error & { status?: number }) => err.status === 409,
  );
});

test("upsertPdfFieldPositions: bulk trong transaction, insert mới + update tồn tại", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.table === "pdf_template_versions") return [versionRow("DRAFT")];
      if (call.table === "pdf_field_positions") {
        if (call.root === "select") {
          // upsert item thứ nhất đã tồn tại (placeholder Ho_ten), item 2 chưa
          const placeholder = eqValue(call, "pdf_field_positions.placeholder");
          return placeholder === "Ho_ten" ? [positionRow("p1")] : [];
        }
        if (call.root === "update") return [positionRow("p1")];
        if (call.root === "insert") return [positionRow("p-new", { placeholder: "So_CCCD" })];
      }
      return undefined;
    },
  });
  const mod = await load(db);

  const out = await mod.upsertPdfFieldPositions("ver-1", [
    { ...POS },
    { ...POS, placeholder: "So_CCCD" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(db.transactions, 1, "bulk upsert phải chạy trong transaction");
});

test("upsertPdfFieldPositions: duplicate trong batch bị chặn trước khi ghi", async () => {
  const db = createFakeDb({
    respond: (call) => (call.table === "pdf_template_versions" ? [versionRow("DRAFT")] : undefined),
  });
  const mod = await load(db);
  await assert.rejects(
    () => mod.upsertPdfFieldPositions("ver-1", [{ ...POS }, { ...POS }]),
    (err: Error & { status?: number }) => err.status === 409,
  );
  assert.equal(db.transactions, 0, "duplicate trong batch → không mở transaction");
});

test("listPdfFieldPositions: 404 khi version không tồn tại", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = await load(db);
  await assert.rejects(
    () => mod.listPdfFieldPositions("ver-missing"),
    (err: Error & { status?: number }) => err.status === 404,
  );
});

test("getPdfFieldPosition: trả position hoặc null", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.table === "pdf_field_positions") return [positionRow("p1")];
      return undefined;
    },
  });
  const mod = await load(db);
  assert.equal((await mod.getPdfFieldPosition("ver-1", "p1"))?.id, "p1");
});
