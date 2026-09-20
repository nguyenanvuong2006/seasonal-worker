/**
 * Tests for Import Engine v3 DW Data Isolation (Post-Go-Live Canonical Contract).
 *
 * Requirements:
 * 1. New worker + spreadsheet CODE -> dw_data.code is NULL
 * 2. New worker + spreadsheet IT CODE -> dw_data.it_code is NULL
 * 3. Unknown/RETIRED-looking imported code cannot become current mirror
 * 4. Existing current mirrors preserved (ON CONFLICT DO NOTHING)
 * 5. Existing NULL mirrors remain NULL
 * 6. Unrelated imported fields still work
 * 7. Upload and paste paths both use safe engine merge
 * 8. Staging/validation behavior preserves raw spreadsheet CODE / IT CODE
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";
import { createFakeDb, makeTable, type FakeDb } from "./test-support/fake-drizzle.ts";

const importJobs = makeTable("import_jobs");
const importJobErrors = makeTable("import_job_errors");
const stagingDwData = makeTable("staging_dw_data");
const stagingDepartment = makeTable("staging_department");
const stagingDailyApplication = makeTable("staging_daily_application");
const formQuestions = makeTable("form_questions");

type ExecutedQuery = { text: string; params: unknown[] };

const fakeDefs = [
  { fieldKey: "dw_code", groupName: "dw_data", importColumnName: "Mã CODE", aliases: ["Mã NV", "CODE"], sortOrder: 1 },
  { fieldKey: "dw_it_code", groupName: "dw_data", importColumnName: "Mã IT", aliases: ["IT CODE", "Mã vân tay"], sortOrder: 2 },
  { fieldKey: "dw_old_code", groupName: "dw_data", importColumnName: "Mã cũ", aliases: [], sortOrder: 3 },
  { fieldKey: "dw_id_vlookup", groupName: "dw_data", importColumnName: "ID VLOOKUP", aliases: [], sortOrder: 4 },
  { fieldKey: "dw_full_name", groupName: "dw_data", importColumnName: "Họ và tên", aliases: ["Họ tên"], sortOrder: 5 },
  { fieldKey: "dw_gender", groupName: "dw_data", importColumnName: "Giới tính", aliases: [], sortOrder: 6 },
  { fieldKey: "dw_bod", groupName: "dw_data", importColumnName: "Ngày sinh", aliases: [], sortOrder: 7 },
  { fieldKey: "dw_profile", groupName: "dw_data", importColumnName: "Hồ sơ", aliases: [], sortOrder: 8 },
  { fieldKey: "dw_dktn", groupName: "dw_data", importColumnName: "ĐKTN", aliases: [], sortOrder: 9 },
  { fieldKey: "dw_cccd", groupName: "dw_data", importColumnName: "Số CCCD", aliases: ["CCCD"], sortOrder: 10 },
  { fieldKey: "dw_date_of_issue", groupName: "dw_data", importColumnName: "Ngày cấp", aliases: [], sortOrder: 11 },
  { fieldKey: "dw_place_of_issue", groupName: "dw_data", importColumnName: "Nơi cấp", aliases: [], sortOrder: 12 },
  { fieldKey: "dw_permanent_address", groupName: "dw_data", importColumnName: "Địa chỉ thường trú", aliases: [], sortOrder: 13 },
  { fieldKey: "dw_residential_address", groupName: "dw_data", importColumnName: "Nơi ở hiện tại", aliases: [], sortOrder: 14 },
  { fieldKey: "dw_phone", groupName: "dw_data", importColumnName: "Số điện thoại", aliases: ["SĐT"], sortOrder: 15 },
];

function createTestHarness() {
  const queries: ExecutedQuery[] = [];

  const pool: any = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      if (text.startsWith("INSERT INTO staging_dw_data")) {
        return { rowCount: (params[1] as number[])?.length ?? 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO dw_data")) {
        // Return 1 inserted row
        return { rowCount: 1, rows: [{ id: "dw-new-1" }] };
      }
      if (text.includes("SELECT count(*)::int c FROM staging_dw_data")) {
        return { rows: [{ c: 1 }] };
      }
      if (text.startsWith("UPDATE staging_dw_data")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO import_job_errors")) {
        return { rowCount: 0, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "field_definitions") {
        return fakeDefs;
      }
      return undefined;
    },
  });

  return { pool, db, queries };
}

const fieldDefinitions = makeTable("field_definitions");

async function loadMetadataModule(db: FakeDb) {
  return loadModule(new URL("./metadata.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": await import("drizzle-orm"),
      "@/db": { db },
      "@/db/schema": { fieldDefinitions, formQuestions },
    },
  });
}

async function loadImportJobsModule(pool: any, db: FakeDb) {
  const metadataMod = await loadMetadataModule(db);
  return loadModule(new URL("./import-jobs.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": await import("drizzle-orm"),
      "next/server": {
        after: (fn: () => void) => fn(),
      },
      "@/db": { db, pool },
      "@/db/schema": {
        importJobs,
        importJobErrors,
        stagingDwData,
        stagingDepartment,
        stagingDailyApplication,
        formQuestions,
      },
      "@/lib/metadata": metadataMod,
      "@/lib/date-parser": await import("./date-parser.ts"),
      "@/lib/person-name": await import("./person-name.ts"),
      "@/lib/validators": await import("./validators.ts"),
    },
  }) as unknown as {
    stageRows: (jobId: string, jobType: string, rows: Record<string, string>[], mapping?: Record<string, string> | null) => Promise<void>;
    runNextStep: (jobId: string) => Promise<{ done: boolean; stage: string; job: any }>;
  };
}

test("1 & 8: stageRows preserves raw spreadsheet CODE / IT CODE in staging_dw_data as evidence", async () => {
  const harness = createTestHarness();
  const mod = await loadImportJobsModule(harness.pool, harness.db);

  const sampleRow = {
    "Mã CODE": "DW-99999",
    "Mã IT": "IT-88888",
    "Mã cũ": "OLD-77777",
    "ID VLOOKUP": "VL-01",
    "Họ và tên": "Nguyễn Văn A",
    "Giới tính": "Nam",
    "Ngày sinh": "1990-01-01",
    "Hồ sơ": "Đầy đủ",
    "ĐKTN": "Có",
    "Số CCCD": "012345678901",
    "Ngày cấp": "2020-01-01",
    "Nơi cấp": "Hà Nội",
    "Địa chỉ thường trú": "Thôn 1",
    "Nơi ở hiện tại": "Xã 2",
    "Số điện thoại": "0987654321",
  };

  await mod.stageRows("job-1", "dw_data", [sampleRow]);

  const stagingInsert = harness.queries.find((q) => q.text.includes("INSERT INTO staging_dw_data"));
  assert.ok(stagingInsert, "must insert into staging_dw_data");

  // Verify staging has the raw code and it_code in params ($3 is code[], $4 is it_code[])
  const codeParam = stagingInsert.params[2] as string[];
  const itCodeParam = stagingInsert.params[3] as string[];
  const oldCodeParam = stagingInsert.params[4] as string[];

  assert.equal(codeParam[0], "DW-99999", "raw CODE must be in staging_dw_data for audit/evidence");
  assert.equal(itCodeParam[0], "IT-88888", "raw IT CODE must be in staging_dw_data for audit/evidence");
  assert.equal(oldCodeParam[0], "OLD-77777", "old_dw_code preserved");
});

test("2, 3, 4, 5, 6: mergeStagedDwData sets code=NULL and it_code=NULL on insert and preserves existing mirrors with DO NOTHING", async () => {
  const harness = createTestHarness();

  // Mock db.select for importJobs to return a job in MERGING stage
  let jobState = {
    id: "job-1",
    jobType: "dw_data",
    status: "RUNNING",
    currentStage: "MERGING",
    totalRows: 1,
    processedRows: 0,
    startedAt: new Date(),
  };

  harness.db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "field_definitions") {
        return fakeDefs;
      }
      if (call.root === "select" && call.table === "import_jobs") {
        return [jobState];
      }
      if (call.root === "update" && call.table === "import_jobs") {
        return [jobState];
      }
      return undefined;
    },
  });

  const mod = await loadImportJobsModule(harness.pool, harness.db);

  await mod.runNextStep("job-1");

  const mergeQuery = harness.queries.find((q) => q.text.includes("INSERT INTO dw_data"));
  assert.ok(mergeQuery, "must execute INSERT INTO dw_data merge query");

  // Critical Post-Go-Live assertions:
  // 1. SELECT NULL, NULL for code, it_code
  assert.match(
    mergeQuery.text,
    /SELECT\s+NULL,\s+NULL,\s+old_dw_code/i,
    "Merge query MUST select NULL, NULL for (code, it_code)"
  );

  // 2. Target columns begin with code, it_code
  assert.match(
    mergeQuery.text,
    /INSERT INTO dw_data\s*\(\s*code,\s*it_code,\s*old_dw_code/i,
    "Target columns must begin with code, it_code, old_dw_code"
  );

  // 3. ON CONFLICT (cccd) WHERE deleted_at IS NULL DO NOTHING
  // This guarantees existing current mirrors (whether active or NULL) are untouched
  assert.match(
    mergeQuery.text,
    /ON CONFLICT\s*\(\s*cccd\s*\)\s*WHERE\s+deleted_at IS NULL\s+DO NOTHING/i,
    "Must use ON CONFLICT (cccd) WHERE deleted_at IS NULL DO NOTHING to preserve existing mirrors"
  );

  // 4. Other fields are selected correctly from staging_dw_data
  assert.ok(mergeQuery.text.includes("old_dw_code"), "old_dw_code included");
  assert.ok(mergeQuery.text.includes("id_vlookup"), "id_vlookup included");
  assert.ok(mergeQuery.text.includes("full_name"), "full_name included");
  assert.ok(mergeQuery.text.includes("gender"), "gender included");
  assert.ok(mergeQuery.text.includes("bod"), "bod included");
  assert.ok(mergeQuery.text.includes("profile"), "profile included");
  assert.ok(mergeQuery.text.includes("dktn"), "dktn included");
  assert.ok(mergeQuery.text.includes("cccd"), "cccd included");
  assert.ok(mergeQuery.text.includes("date_of_issue"), "date_of_issue included");
  assert.ok(mergeQuery.text.includes("place_of_issue"), "place_of_issue included");
  assert.ok(mergeQuery.text.includes("permanent_address"), "permanent_address included");
  assert.ok(mergeQuery.text.includes("residential_address"), "residential_address included");
  assert.ok(mergeQuery.text.includes("phone"), "phone included");
});

test("7: legacy import-engine mergeNextChunk also isolates dw_data.code and it_code with NULL, NULL", async () => {
  const harness = createTestHarness();

  const sampleRow = {
    "Mã CODE": "ILLEGAL-DW-99",
    "Mã IT": "ILLEGAL-IT-88",
    "Mã cũ": "OLD-01",
    "ID VLOOKUP": "VL-01",
    "Họ và tên": "Trần Thị B",
    "Giới tính": "Nữ",
    "Ngày sinh": "1995-05-05",
    "Hồ sơ": "Đủ",
    "ĐKTN": "Đạt",
    "Số CCCD": "098765432109",
    "Ngày cấp": "2021-01-01",
    "Nơi cấp": "TP HCM",
    "Địa chỉ thường trú": "Địa chỉ 1",
    "Nơi ở hiện tại": "Địa chỉ 2",
    "Số điện thoại": "0912345678",
  };

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      harness.queries.push({ text, params });
      if (text.includes("FROM import_staging_rows") && text.includes("LIMIT")) {
        return { rows: [{ id: "row-1", raw_data: sampleRow }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO dw_data")) {
        return { rowCount: 1, rows: [{ id: "dw-1" }] };
      }
      if (text.startsWith("UPDATE import_staging_rows")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("BEGIN") || text.startsWith("COMMIT") || text.startsWith("ROLLBACK")) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  harness.pool.connect = async () => client;

  const metadataMod = await loadMetadataModule(harness.db);
  const engineMod = await loadModule(new URL("./import-engine.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": await import("drizzle-orm"),
      "@/db": { db: harness.db, pool: harness.pool },
      "@/db/schema": {
        importBatches: makeTable("import_batches"),
        importStagingRows: makeTable("import_staging_rows"),
        formQuestions: makeTable("form_questions"),
      },
      "@/lib/metadata": metadataMod,
      "@/lib/person-name": await import("./person-name.ts"),
      "@/lib/validators": await import("./validators.ts"),
    },
  }) as unknown as {
    mergeNextChunk: (batchId: string, importType: string) => Promise<{ inserted: number; updated: number; error: number; duplicate: number; done: boolean }>;
  };

  await engineMod.mergeNextChunk("batch-1", "dw_data");

  const legacyQuery = harness.queries.find((q) => q.text.includes("INSERT INTO dw_data"));
  assert.ok(legacyQuery, "must execute INSERT INTO dw_data");

  assert.match(
    legacyQuery.text,
    /VALUES\s*\(\s*NULL,\s*NULL,/i,
    "Legacy import-engine MUST use VALUES (NULL, NULL, ...) for (code, it_code)"
  );
  assert.match(
    legacyQuery.text,
    /ON CONFLICT\s*\(\s*cccd\s*\)\s*WHERE\s+deleted_at IS NULL\s+DO NOTHING/i,
    "Legacy import-engine MUST use ON CONFLICT DO NOTHING"
  );
});

