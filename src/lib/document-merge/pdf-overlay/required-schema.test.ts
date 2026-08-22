/**
 * REQUIRED SCHEMA CONTRACT tests (PR5 root-cause hardening).
 *
 * Pure + deterministic — không cần DB thật:
 *   - schema đầy đủ → ok
 *   - thiếu bảng bắt buộc → SCHEMA_MISMATCH + chỉ rõ bảng
 *   - thiếu cột bắt buộc → SCHEMA_MISMATCH + chỉ rõ cột
 *   - probeOverlaySchema parse đúng rows từ information_schema (qua querier giả)
 *   - buildOverlaySchemaProbeSql liệt kê ĐỦ bảng bắt buộc (chống quên khi thêm bảng)
 *   - OverlaySchemaError mang code + chẩn đoán operator-readable
 *   - contract KHÔNG trùng cột / KHÔNG tên bảng rỗng (self-consistency)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_OVERLAY_SCHEMA,
  REQUIRED_OVERLAY_TABLES,
  buildOverlaySchemaProbeSql,
  probeOverlaySchema,
  evaluateOverlaySchema,
  checkOverlaySchema,
  formatOverlaySchemaMismatch,
  OverlaySchemaError,
  isOverlaySchemaError,
  type SchemaQuerier,
  type ObservedSchema,
} from "./required-schema.ts";

/** Dựng observed "đầy đủ" từ chính contract → luôn ok (single source of truth). */
function fullObserved(): ObservedSchema {
  return {
    schema: "public",
    tables: REQUIRED_OVERLAY_SCHEMA.map((t) => ({ table: t.table, columns: [...t.columns] })),
  };
}

/** Dựng rows information_schema cho 1 tập bảng/cột cho trước (mô phỏng DB). */
function rowsFor(present: { table: string; columns: string[] }[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const t of present) {
    for (const column of t.columns) {
      rows.push({ probe_schema: "public", table_name: t.table, column_name: column });
    }
  }
  return rows;
}

test("required-schema: contract self-consistency — bảng/cột duy nhất, tên hợp lệ", () => {
  const seenTables = new Set<string>();
  for (const t of REQUIRED_OVERLAY_SCHEMA) {
    assert.ok(t.table.length > 0, "tên bảng không rỗng");
    assert.ok(!seenTables.has(t.table), `bảng trùng: ${t.table}`);
    seenTables.add(t.table);
    assert.ok(t.columns.length > 0, `${t.table} phải có ≥1 cột`);
    const seenCols = new Set<string>();
    for (const c of t.columns) {
      assert.ok(!seenCols.has(c), `${t.table} cột trùng: ${c}`);
      seenCols.add(c);
    }
  }
  // REQUIRED_OVERLAY_TABLES dẫn xuất đúng.
  assert.deepEqual(REQUIRED_OVERLAY_TABLES, REQUIRED_OVERLAY_SCHEMA.map((t) => t.table));
});

test("required-schema: schema đầy đủ → ok (không thiếu)", () => {
  const result = evaluateOverlaySchema(fullObserved());
  assert.equal(result.ok, true);
  assert.equal(result.missingTables.length, 0);
  assert.equal(result.missingColumns.length, 0);
  assert.equal(result.requiredTableCount, REQUIRED_OVERLAY_SCHEMA.length);
  assert.equal(result.observedTableCount, REQUIRED_OVERLAY_SCHEMA.length);
});

test("required-schema: thiếu 1 bảng bắt buộc → !ok + chỉ rõ bảng", () => {
  const observed = fullObserved();
  const pruned: ObservedSchema = {
    schema: observed.schema,
    tables: observed.tables.filter((t) => t.table !== "merge_job_records"),
  };
  const result = evaluateOverlaySchema(pruned);
  assert.equal(result.ok, false);
  assert.deepEqual([...result.missingTables], ["merge_job_records"]);
  assert.equal(result.missingColumns.length, 0, "bảng thiếu thì không liệt kê cột");
});

test("required-schema: thiếu nhiều bảng → liệt kê đủ", () => {
  const result = evaluateOverlaySchema({ schema: "public", tables: [] });
  assert.equal(result.ok, false);
  assert.deepEqual([...result.missingTables], [...REQUIRED_OVERLAY_TABLES]);
});

test("required-schema: thiếu 1 cột bắt buộc (bảng còn nguyên) → !ok + chỉ rõ cột", () => {
  const observed = fullObserved();
  const tampered: ObservedSchema = {
    schema: observed.schema,
    tables: observed.tables.map((t) =>
      t.table === "merge_jobs"
        ? { table: t.table, columns: t.columns.filter((c) => c !== "engine") }
        : t,
    ),
  };
  const result = evaluateOverlaySchema(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.missingTables.length, 0);
  assert.equal(result.missingColumns.length, 1);
  assert.equal(result.missingColumns[0].table, "merge_jobs");
  assert.deepEqual([...result.missingColumns[0].columns], ["engine"]);
});

test("required-schema: thiếu nhiều cột trên nhiều bảng → gom đúng theo bảng", () => {
  const observed = fullObserved();
  const tampered: ObservedSchema = {
    schema: observed.schema,
    tables: observed.tables.map((t) => {
      if (t.table === "merge_jobs") return { table: t.table, columns: t.columns.filter((c) => c !== "engine" && c !== "status") };
      if (t.table === "document_history") return { table: t.table, columns: t.columns.filter((c) => c !== "sha256") };
      return t;
    }),
  };
  const result = evaluateOverlaySchema(tampered);
  assert.equal(result.ok, false);
  const byTable = new Map(result.missingColumns.map((m) => [m.table, [...m.columns].sort()]));
  assert.deepEqual(byTable.get("merge_jobs"), ["engine", "status"]);
  assert.deepEqual(byTable.get("document_history"), ["sha256"]);
});

test("required-schema: buildOverlaySchemaProbeSql liệt kê ĐỦ bảng bắt buộc (chống quên)", () => {
  const sql = buildOverlaySchemaProbeSql();
  for (const table of REQUIRED_OVERLAY_TABLES) {
    assert.ok(sql.includes(`'${table}'`), `probe SQL phải nhắc bảng ${table}`);
  }
  assert.ok(sql.includes("information_schema.columns"), "dùng information_schema");
  assert.ok(sql.includes("current_schema()"), "giới hạn current_schema()");
});

test("required-schema: probeOverlaySchema parse rows → observed đúng (qua querier giả)", async () => {
  const querier: SchemaQuerier = async () => rowsFor([
    { table: "merge_jobs", columns: ["id", "engine", "status"] },
    { table: "document_history", columns: ["id", "filename"] },
  ]);
  const observed = await probeOverlaySchema(querier);
  assert.equal(observed.schema, "public");
  const byTable = new Map(observed.tables.map((t) => [t.table, t.columns]));
  assert.deepEqual([...(byTable.get("merge_jobs") ?? [])].sort(), ["engine", "id", "status"]);
  assert.deepEqual([...(byTable.get("document_history") ?? [])].sort(), ["filename", "id"]);
  assert.ok(!byTable.has("merge_job_records"), "bảng không có row → không xuất hiện");
});

test("required-schema: probeOverlaySchema bỏ qua row malformed (không crash)", async () => {
  const querier: SchemaQuerier = async () => [
    { probe_schema: "public", table_name: "merge_jobs", column_name: "id" },
    { probe_schema: "public", table_name: "", column_name: "x" },
    { probe_schema: "public", table_name: "merge_jobs", column_name: "" },
    { table_name: "merge_jobs" },
  ];
  const observed = await probeOverlaySchema(querier);
  const jobs = observed.tables.find((t) => t.table === "merge_jobs");
  assert.deepEqual([...(jobs?.columns ?? [])], ["id"]);
});

test("required-schema: checkOverlaySchema end-to-end — đầy đủ → ok", async () => {
  const querier: SchemaQuerier = async () => rowsFor(REQUIRED_OVERLAY_SCHEMA.map((t) => ({ table: t.table, columns: [...t.columns] })));
  const result = await checkOverlaySchema(querier);
  assert.equal(result.ok, true);
});

test("required-schema: checkOverlaySchema end-to-end — thiếu bảng → SCHEMA_MISMATCH", async () => {
  const present = REQUIRED_OVERLAY_SCHEMA.filter((t) => t.table !== "document_history").map((t) => ({ table: t.table, columns: [...t.columns] }));
  const querier: SchemaQuerier = async () => rowsFor(present);
  const result = await checkOverlaySchema(querier);
  assert.equal(result.ok, false);
  assert.deepEqual([...result.missingTables], ["document_history"]);
});

test("required-schema: checkOverlaySchema end-to-end — thiếu cột → SCHEMA_MISMATCH", async () => {
  const present = REQUIRED_OVERLAY_SCHEMA.map((t) => ({
    table: t.table,
    columns: t.table === "merge_job_records" ? t.columns.filter((c) => c !== "retry_at" && c !== "leased_until") : [...t.columns],
  }));
  const querier: SchemaQuerier = async () => rowsFor(present);
  const result = await checkOverlaySchema(querier);
  assert.equal(result.ok, false);
  assert.equal(result.missingTables.length, 0);
  const mjr = result.missingColumns.find((m) => m.table === "merge_job_records");
  assert.ok(mjr, "phải báo merge_job_records thiếu cột");
  assert.deepEqual([...mjr.columns].sort(), ["leased_until", "retry_at"]);
});

test("required-schema: OverlaySchemaError — code SCHEMA_MISMATCH + chẩn đoán operator-readable", () => {
  const result = evaluateOverlaySchema({ schema: "public", tables: [] });
  const err = new OverlaySchemaError(result);
  assert.equal(err.code, "SCHEMA_MISMATCH");
  assert.ok(err.message.startsWith("SCHEMA_MISMATCH:"), "message mở đầu bằng SCHEMA_MISMATCH:");
  for (const table of REQUIRED_OVERLAY_TABLES) {
    assert.ok(err.message.includes(table), `chẩn đoán nhắc bảng thiếu: ${table}`);
  }
  assert.ok(err.message.includes("run-migrations.mjs"), "gợi ý chạy migration");
  assert.ok(err.message.includes("verify-required-schema.mjs"), "gợi ý verify lại");
  assert.ok(isOverlaySchemaError(err));
  assert.ok(!isOverlaySchemaError(new Error("other")));
});

test("required-schema: formatOverlaySchemaMismatch — nhắc đủ bảng thiếu + cột thiếu", () => {
  const result = evaluateOverlaySchema({
    schema: "public",
    tables: REQUIRED_OVERLAY_SCHEMA.map((t) =>
      t.table === "merge_jobs" ? { table: t.table, columns: t.columns.filter((c) => c !== "engine") } : t,
    ).filter((t) => t.table !== "document_history"),
  });
  const text = formatOverlaySchemaMismatch(result);
  assert.ok(text.includes("thiếu bảng document_history"));
  assert.ok(text.includes("bảng merge_jobs thiếu cột [engine]"));
});
