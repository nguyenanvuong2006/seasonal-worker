/**
 * createAsyncMergeJob — must freeze the IMMUTABLE CANONICAL SNAPSHOT
 * (templateId/templateVersion/htmlBody/printCss/mappings/formatting) from the
 * explicitly PUBLISHED merge_template_versions row into
 * merge_jobs.metadata.templates[tid]. The worker renders directly from that
 * snapshot via renderCanonicalDocument(); it never consults a static template
 * registry, Google Docs, or another version.
 *
 * Without a PUBLISHED canonical version the job must FAIL CLOSED at creation
 * with CANONICAL_TEMPLATE_NOT_PUBLISHED — never queue with a fallback body.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, argOf, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";
import * as canonicalDocument from "./canonical-document.ts";
import * as signingContext from "./signing-context.ts";

const schemaStub = {
  dailyApplications: makeTable("daily_applications"),
  mergeJobRecords: makeTable("merge_job_records"),
  mergeJobs: makeTable("merge_jobs"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

type AsyncJobModule = {
  createAsyncMergeJob: (input: Record<string, unknown>) => Promise<{ jobId: string; status: string; total: number; engine: string }>;
};

async function load(
  db: FakeDb,
  registry: {
    getRegisteredContractKeyByGoogleDocId?: (id: string | null | undefined) => string | null;
    getHtmlTemplateContractByGoogleDocId?: () => null;
  } = {},
  /**
   * Record data the required-field gate resolves against. Mirrors the shape
   * loadDailyApplicationRecords returns (flattened applicant merge record).
   */
  records: Record<string, Record<string, unknown>> = {},
  /**
   * Simulates DOCUMENT_MERGE_ENGINE — the SAME env var every other
   * production call site reads via getDocumentMergeEngine(). Defaults to
   * "GOOGLE_DOCS" (today's configured Production default) so every
   * pre-existing test, which always passes an explicit `engine` in its
   * input to override this, is unaffected.
   */
  defaultEngine: "GOOGLE_DOCS" | "HTML_PDF" = "GOOGLE_DOCS",
): Promise<AsyncJobModule> {
  const mod = await loadModule(new URL("./async-job.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "./engine-config.ts": { getDocumentMergeEngine: () => defaultEngine },
      "./template-routing.ts": {
        selectTemplateForApplicant: () => ({ template: null, kind: "GENERIC" }),
        documentKindLabel: (k: string) => k,
      },
      "./queue-types.ts": {
        ITEM_STATUS: { QUEUED: "QUEUED" },
        JOB_STATUS: { QUEUED: "QUEUED" },
      },
      "../../document-templates/registry.ts": {
        getRegisteredContractKeyByGoogleDocId: registry.getRegisteredContractKeyByGoogleDocId ?? (() => null),
        getHtmlTemplateContractByGoogleDocId: registry.getHtmlTemplateContractByGoogleDocId ?? (() => null),
      },
      // Real canonical module — pure logic, and the fail-closed behaviour under
      // test must be the production behaviour, not a stub.
      "./canonical-document.ts": canonicalDocument,
      // Real signing-context module — H3's validation/freeze behaviour under
      // test must be the production behaviour, not a stub.
      "./signing-context.ts": signingContext,
      "./template-contract.ts": {
        validateContractRequiredMappings: () => [],
        validateTemplateContract: () => ({ valid: true, missingFromHtml: [], unknownInHtml: [], duplicateKeys: [] }),
      },
      "./placeholder-extractor.ts": {
        extractUniquePlaceholders: (html: string) => Array.from(new Set(
          [...html.matchAll(/(?:<<\s*([^>]+?)\s*>>|\{\{\s*([^{}]+?)\s*\}\})/g)].map((m) => (m[1] ?? m[2]).trim()),
        )).sort(),
      },
      "./record-loader.ts": {
        loadDailyApplicationRecords: async (ids: string[]) =>
          new Map(ids.filter((id) => id in records).map((id) => [id, records[id]])),
      },
      // Resolve/validate exactly like production: read sourcePath off the
      // record, then treat blank values as missing for isRequired mappings.
      "./html-pipeline.ts": {
        resolveHtmlFieldValues: (
          fields: { placeholder: string; sourcePath: string | null }[],
          recordData: Record<string, unknown>,
        ) => Object.fromEntries(fields.map((f) => [
          f.placeholder,
          String((f.sourcePath ? recordData[f.sourcePath] : undefined) ?? ""),
        ])),
      },
      "./data-resolver.ts": {
        validateRequiredFields: (
          fields: { placeholder: string; isRequired: boolean }[],
          values: Record<string, string>,
        ) => {
          const missingFields = fields
            .filter((f) => f.isRequired && !(values[f.placeholder] ?? "").trim())
            .map((f) => f.placeholder);
          return { valid: missingFields.length === 0, missingFields };
        },
      },
    },
  });
  return mod as unknown as AsyncJobModule;
}

const TEMPLATE_ROW = { id: "tpl-1", isActive: true, htmlEnabled: true, name: "Đăng ký tập nghề", documentKind: "B", googleDocId: "gdoc-1", currentPublishedVersion: 2 };
const PUBLISHED_VERSION_ROW = {
  templateId: "tpl-1",
  version: 2,
  status: "PUBLISHED",
  retentionYears: 3,
  htmlBody: "<p><<Ho_ten>></p>",
  printCss: "p{color:red}",
};

type FieldRow = {
  templateId: string;
  placeholder: string;
  sourceType: string;
  sourceEntity: string | null;
  sourceField: string | null;
  sourcePath: string | null;
  optionValue: string | null;
  formatType: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
};

function fieldRow(overrides: Partial<FieldRow> = {}): FieldRow {
  return {
    templateId: "tpl-1",
    placeholder: "Ho_ten",
    sourceType: "CORE_FIELD",
    sourceEntity: null,
    sourceField: null,
    sourcePath: "fullName",
    optionValue: null,
    formatType: "RAW",
    fallbackValue: null,
    isRequired: false,
    ...overrides,
  };
}

function fixtureDb(
  publishedVersion: typeof PUBLISHED_VERSION_ROW | null,
  application: { permanentAddress?: string | null; residentialAddress?: string | null } = {},
  fieldRows: FieldRow[] = [fieldRow()],
): FakeDb {
  return createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "merge_templates") return [TEMPLATE_ROW];
      if (call.root === "select" && call.table === "daily_applications") {
        return [{
          id: "app-1",
          declaredType: "NEW",
          dwMatch: "NO_MATCH",
          permanentAddress: application.permanentAddress ?? null,
          residentialAddress: application.residentialAddress ?? null,
        }];
      }
      if (call.root === "select" && call.table === "merge_template_fields") {
        return fieldRows;
      }
      if (call.root === "select" && call.table === "merge_template_versions") {
        return publishedVersion ? [publishedVersion] : [];
      }
      if (call.root === "insert" && call.table === "merge_jobs") {
        return [{ id: "job-1", ...(argOf(call, "values") as Record<string, unknown>) }];
      }
      if (call.root === "insert" && call.table === "merge_job_records") return [];
      return undefined;
    },
  });
}

test("createAsyncMergeJob: snapshots htmlBody/printCss from the PUBLISHED version into metadata.templates[tid]", async () => {
  const db = fixtureDb(PUBLISHED_VERSION_ROW);
  const mod = await load(db);

  await mod.createAsyncMergeJob({
    templateId: "tpl-1",
    autoRoute: false,
    records: { entityType: "daily_applications", recordIds: ["app-1"] },
    createdBy: "admin",
    scopeDeptIds: null,
    engine: "GOOGLE_DOCS",
  });

  const jobInsert = db.calls.find((c) => c.root === "insert" && c.table === "merge_jobs");
  assert.ok(jobInsert, "phải INSERT merge_jobs");
  const values = argOf(jobInsert as QueryCall, "values") as { metadata: { templates: Record<string, { htmlBody: string | null; printCss: string | null; version: number | null }> } };
  const snap = values.metadata.templates["tpl-1"];
  assert.equal(snap.htmlBody, "<p><<Ho_ten>></p>");
  assert.equal(snap.printCss, "p{color:red}");
  assert.equal(snap.version, 2);
});

test("createAsyncMergeJob: no PUBLISHED version -> htmlBody/printCss are null (worker fails loud at TEMPLATE_LOADING instead of falling back to a stale/hardcoded template)", async () => {
  const db = fixtureDb(null);
  const mod = await load(db);

  await mod.createAsyncMergeJob({
    templateId: "tpl-1",
    autoRoute: false,
    records: { entityType: "daily_applications", recordIds: ["app-1"] },
    createdBy: "admin",
    scopeDeptIds: null,
    engine: "GOOGLE_DOCS",
  });

  const jobInsert = db.calls.find((c) => c.root === "insert" && c.table === "merge_jobs");
  const values = argOf(jobInsert as QueryCall, "values") as { metadata: { templates: Record<string, { htmlBody: string | null; printCss: string | null }> } };
  const snap = values.metadata.templates["tpl-1"];
  assert.equal(snap.htmlBody, null);
  assert.equal(snap.printCss, null);
});

test("createAsyncMergeJob: HTML_PDF accepts an explicit HTML-enabled template and snapshots it for the existing queue", async () => {
  const db = fixtureDb(PUBLISHED_VERSION_ROW);
  const mod = await load(db);

  const result = await mod.createAsyncMergeJob({
    templateId: "tpl-1",
    autoRoute: false,
    records: { entityType: "daily_applications", recordIds: ["app-1"] },
    createdBy: "admin",
    scopeDeptIds: null,
    engine: "HTML_PDF",
  });

  assert.equal(result.engine, "HTML_PDF");
  const jobInsert = db.calls.find((c) => c.root === "insert" && c.table === "merge_jobs");
  assert.ok(jobInsert, "HTML/PDF phải dùng cùng merge_jobs queue, không tạo job system riêng");
  const values = argOf(jobInsert as QueryCall, "values") as { engine: string; metadata: { renderedAt?: string } };
  assert.equal(values.engine, "HTML_PDF");
  assert.ok(values.metadata.renderedAt, "phải snapshot merge clock cho retry deterministic");
});

// 2026-09 HTML_PDF production engine switch: proves a NEW job with no
// explicit `engine` in its input follows DOCUMENT_MERGE_ENGINE (via
// getDocumentMergeEngine()) — the single, existing, supported
// engine-selection mechanism — rather than silently defaulting to
// GOOGLE_DOCS regardless of that env var's value. Every other test in this
// file passes an explicit `engine`, which always wins over the env var
// (`input.engine ?? getDocumentMergeEngine()`); this test is the one that
// actually exercises the ENV-driven fallback in isolation.
test("createAsyncMergeJob: with no explicit engine in the input, a new job follows DOCUMENT_MERGE_ENGINE=HTML_PDF (getDocumentMergeEngine()) — not a hardcoded GOOGLE_DOCS default", async () => {
  const db = fixtureDb(PUBLISHED_VERSION_ROW);
  const mod = await load(db, {}, {}, "HTML_PDF");

  const result = await mod.createAsyncMergeJob({
    templateId: "tpl-1",
    autoRoute: false,
    records: { entityType: "daily_applications", recordIds: ["app-1"] },
    createdBy: "admin",
    scopeDeptIds: null,
    // no `engine` field — production callers (the bulk Merge button and
    // candidate-document generate/reissue) never pass one either; they all
    // rely on the env-var default.
  });

  assert.equal(result.engine, "HTML_PDF");
  const jobInsert = db.calls.find((c) => c.root === "insert" && c.table === "merge_jobs");
  const values = argOf(jobInsert as QueryCall, "values") as { engine: string };
  assert.equal(values.engine, "HTML_PDF");
});

test("createAsyncMergeJob: with no explicit engine in the input, a new job still follows DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS (today's configured Production default)", async () => {
  const db = fixtureDb(PUBLISHED_VERSION_ROW);
  const mod = await load(db, {}, {}, "GOOGLE_DOCS");

  const result = await mod.createAsyncMergeJob({
    templateId: "tpl-1",
    autoRoute: false,
    records: { entityType: "daily_applications", recordIds: ["app-1"] },
    createdBy: "admin",
    scopeDeptIds: null,
  });

  assert.equal(result.engine, "GOOGLE_DOCS");
});

test("createAsyncMergeJob: HTML_PDF rejects auto-route or a missing explicit template before creating a job", async () => {
  const db = fixtureDb(PUBLISHED_VERSION_ROW);
  const mod = await load(db);

  await assert.rejects(
    () => mod.createAsyncMergeJob({
      autoRoute: true,
      records: { entityType: "daily_applications", recordIds: ["app-1"] },
      createdBy: "admin",
      scopeDeptIds: null,
      engine: "HTML_PDF",
    }),
    /template cụ thể.*Auto Route/,
  );
  assert.equal(db.calls.some((c) => c.root === "insert" && c.table === "merge_jobs"), false);
});

test("createAsyncMergeJob: HTML_PDF rejects an unmapped HTML token before it can reach the worker", async () => {
  const db = fixtureDb({ ...PUBLISHED_VERSION_ROW, htmlBody: "<p>{{Khong_co_mapping}}</p>" });
  const mod = await load(db);

  await assert.rejects(
    () => mod.createAsyncMergeJob({
      templateId: "tpl-1",
      autoRoute: false,
      records: { entityType: "daily_applications", recordIds: ["app-1"] },
      createdBy: "admin",
      scopeDeptIds: null,
      engine: "HTML_PDF",
    }),
    /placeholder chưa mapping: Khong_co_mapping/,
  );
  assert.equal(db.calls.some((c) => c.root === "insert" && c.table === "merge_jobs"), false);
});

const traineeRegistry = {
  // Metadata-only catalog lookup: returns a stable CONTRACT KEY, never a body.
  getRegisteredContractKeyByGoogleDocId: (id: string | null | undefined) =>
    id === "gdoc-1" ? "dang-ky-tap-nghe" : null,
};

/**
 * Required-field hotfix: merge_template_fields.isRequired is the single
 * runtime source of truth. There is no hard-coded permanentAddress rule, so
 * an EMPTY permanentAddress must queue when its mapping is optional and must
 * be rejected only when the mapping says required.
 */
const ADDRESS_HTML_VERSION = { ...PUBLISHED_VERSION_ROW, htmlBody: "<p><<Ho_ten>> <<Dia_chi_thuong_tru>></p>" };

const addressFields = (isRequired: boolean): FieldRow[] => [
  fieldRow(),
  fieldRow({ placeholder: "Dia_chi_thuong_tru", sourcePath: "permanentAddress", isRequired }),
];

test("createAsyncMergeJob: HTML_PDF queues when permanentAddress is empty but its mapping is OPTIONAL (no hard-coded rule)", async () => {
  const db = fixtureDb(ADDRESS_HTML_VERSION, { permanentAddress: "   " }, addressFields(false));
  const mod = await load(db, traineeRegistry, {
    "app-1": { fullName: "Nguyễn Văn A", permanentAddress: "   ", residentialAddress: "Tạm trú có giá trị" },
  });

  const result = await mod.createAsyncMergeJob({
    templateId: "tpl-1",
    autoRoute: false,
    records: { entityType: "daily_applications", recordIds: ["app-1"] },
    createdBy: "admin",
    scopeDeptIds: null,
    engine: "HTML_PDF",
  });

  assert.equal(result.engine, "HTML_PDF");
  assert.equal(db.calls.some((c) => c.root === "insert" && c.table === "merge_jobs"), true);
});

test("createAsyncMergeJob: HTML_PDF rejects with 422 when a REQUIRED mapping resolves empty", async () => {
  const db = fixtureDb(ADDRESS_HTML_VERSION, { permanentAddress: "   " }, addressFields(true));
  const mod = await load(db, traineeRegistry, {
    "app-1": { fullName: "Nguyễn Văn A", permanentAddress: "   ", residentialAddress: "Tạm trú có giá trị" },
  });

  await assert.rejects(
    () => mod.createAsyncMergeJob({
      templateId: "tpl-1",
      autoRoute: false,
      records: { entityType: "daily_applications", recordIds: ["app-1"] },
      createdBy: "admin",
      scopeDeptIds: null,
      engine: "HTML_PDF",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Dia_chi_thuong_tru/);
      assert.equal((error as { status?: number }).status, 422);
      return true;
    },
  );
  assert.equal(db.calls.some((c) => c.root === "insert" && c.table === "merge_jobs"), false);
});

test("createAsyncMergeJob: required Dia_chi_thuong_tru does NOT fall back to residentialAddress", async () => {
  // residentialAddress is populated; permanentAddress is not. The required
  // mapping points at permanentAddress, so the job must still be rejected.
  const db = fixtureDb(ADDRESS_HTML_VERSION, { permanentAddress: null }, addressFields(true));
  const mod = await load(db, traineeRegistry, {
    "app-1": { fullName: "Nguyễn Văn A", permanentAddress: null, residentialAddress: "99 Lê Lợi, Đà Lạt" },
  });

  await assert.rejects(
    () => mod.createAsyncMergeJob({
      templateId: "tpl-1",
      autoRoute: false,
      records: { entityType: "daily_applications", recordIds: ["app-1"] },
      createdBy: "admin",
      scopeDeptIds: null,
      engine: "HTML_PDF",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Dia_chi_thuong_tru/);
      return true;
    },
  );
});

test("createAsyncMergeJob: generic (non-registered) HTML template uses the same isRequired mechanism", async () => {
  const db = fixtureDb(ADDRESS_HTML_VERSION, { permanentAddress: null }, addressFields(true));
  // No registry entry -> generic template, yet the mapping still governs.
  const mod = await load(db, {}, {
    "app-1": { fullName: "Nguyễn Văn A", permanentAddress: null },
  });

  await assert.rejects(
    () => mod.createAsyncMergeJob({
      templateId: "tpl-1",
      autoRoute: false,
      records: { entityType: "daily_applications", recordIds: ["app-1"] },
      createdBy: "admin",
      scopeDeptIds: null,
      engine: "HTML_PDF",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Dia_chi_thuong_tru/);
      return true;
    },
  );
});

test("createAsyncMergeJob: GOOGLE_DOCS is unchanged — queues even when a required mapping is empty", async () => {
  const db = fixtureDb(PUBLISHED_VERSION_ROW, { permanentAddress: null, residentialAddress: null }, addressFields(true));
  const mod = await load(db, traineeRegistry, {
    "app-1": { fullName: "Nguyễn Văn A", permanentAddress: null },
  });

  const result = await mod.createAsyncMergeJob({
    templateId: "tpl-1",
    autoRoute: false,
    records: { entityType: "daily_applications", recordIds: ["app-1"] },
    createdBy: "admin",
    scopeDeptIds: null,
    engine: "GOOGLE_DOCS",
  });

  assert.equal(result.engine, "GOOGLE_DOCS");
  assert.equal(db.calls.some((c) => c.root === "insert" && c.table === "merge_jobs"), true);
});

test("createAsyncMergeJob: HTML_PDF refuses a template without a PUBLISHED HTML version", async () => {
  const db = fixtureDb(null);
  const mod = await load(db);

  await assert.rejects(
    () => mod.createAsyncMergeJob({
      templateId: "tpl-1",
      autoRoute: false,
      records: { entityType: "daily_applications", recordIds: ["app-1"] },
      createdBy: "admin",
      scopeDeptIds: null,
      engine: "HTML_PDF",
    }),
    /CANONICAL_TEMPLATE_NOT_PUBLISHED/,
  );
  assert.equal(db.calls.some((c) => c.root === "insert" && c.table === "merge_jobs"), false);
});

/* ------------------------------------------------------------------ *
 * H3 — Signing Context is resolved ONCE and frozen into job.metadata.
 * ------------------------------------------------------------------ */

test("H3: createAsyncMergeJob freezes the supplied signingContext verbatim into metadata.signingContext", async () => {
  const db = fixtureDb(PUBLISHED_VERSION_ROW);
  const mod = await load(db);

  await mod.createAsyncMergeJob({
    templateId: "tpl-1",
    autoRoute: false,
    records: { entityType: "daily_applications", recordIds: ["app-1"] },
    createdBy: "admin",
    scopeDeptIds: null,
    engine: "GOOGLE_DOCS",
    signingContext: { signingDate: "2026-08-26", signingLocation: "Đà Lạt" },
  });

  const jobInsert = db.calls.find((c) => c.root === "insert" && c.table === "merge_jobs");
  const values = argOf(jobInsert as QueryCall, "values") as { metadata: { signingContext: Record<string, unknown> } };
  assert.equal(values.metadata.signingContext.signingDate, "2026-08-26");
  assert.equal(values.metadata.signingContext.signingLocation, "Đà Lạt");
});

test("H3: createAsyncMergeJob freezes an empty (all-null) signingContext when none is supplied", async () => {
  const db = fixtureDb(PUBLISHED_VERSION_ROW);
  const mod = await load(db);

  await mod.createAsyncMergeJob({
    templateId: "tpl-1",
    autoRoute: false,
    records: { entityType: "daily_applications", recordIds: ["app-1"] },
    createdBy: "admin",
    scopeDeptIds: null,
    engine: "GOOGLE_DOCS",
  });

  const jobInsert = db.calls.find((c) => c.root === "insert" && c.table === "merge_jobs");
  const values = argOf(jobInsert as QueryCall, "values") as { metadata: { signingContext: Record<string, unknown> } };
  assert.equal(values.metadata.signingContext.signingDate, null);
  assert.equal(values.metadata.signingContext.signingLocation, null);
});

test("H3: createAsyncMergeJob rejects a malformed signingContext with 400 before any job is created", async () => {
  const db = fixtureDb(PUBLISHED_VERSION_ROW);
  const mod = await load(db);

  await assert.rejects(
    () => mod.createAsyncMergeJob({
      templateId: "tpl-1",
      autoRoute: false,
      records: { entityType: "daily_applications", recordIds: ["app-1"] },
      createdBy: "admin",
      scopeDeptIds: null,
      engine: "GOOGLE_DOCS",
      signingContext: { signingDate: "not-a-date" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Ngày ký/);
      assert.equal((error as { status?: number }).status, 400);
      return true;
    },
  );
  assert.equal(db.calls.some((c) => c.root === "insert" && c.table === "merge_jobs"), false);
});

test("H3: a REQUIRED COMPUTED mapping resolving to empty (no Signing Context) blocks the job before queueing", async () => {
  const computedField: FieldRow = {
    templateId: "tpl-1",
    placeholder: "Ngay_ky_day",
    sourceType: "COMPUTED",
    sourceEntity: null,
    sourceField: null,
    sourcePath: "day(SigningDate)",
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: true,
  };
  const db = fixtureDb(
    { ...PUBLISHED_VERSION_ROW, htmlBody: "<p><<Ho_ten>> <<Ngay_ky_day>></p>" },
    {},
    [fieldRow(), computedField],
  );
  // NOTE: the fake html-pipeline stub above only understands sourcePath as a
  // literal record-field lookup, so it resolves COMPUTED's sourcePath
  // ("day(SigningDate)") to an empty string exactly as an unresolvable/absent
  // value would — proving the required-field gate blocks it regardless of
  // which source type produced the empty value.
  const mod = await load(db, {}, { "app-1": { fullName: "Nguyễn Văn A" } });

  await assert.rejects(
    () => mod.createAsyncMergeJob({
      templateId: "tpl-1",
      autoRoute: false,
      records: { entityType: "daily_applications", recordIds: ["app-1"] },
      createdBy: "admin",
      scopeDeptIds: null,
      engine: "HTML_PDF",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Ngay_ky_day/);
      assert.equal((error as { status?: number }).status, 422);
      return true;
    },
  );
  assert.equal(db.calls.some((c) => c.root === "insert" && c.table === "merge_jobs"), false);
});
