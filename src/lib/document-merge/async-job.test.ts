/**
 * createAsyncMergeJob — must snapshot htmlBody/printCss (not just the version
 * number) from the PUBLISHED merge_template_versions row into
 * merge_jobs.metadata.templates[tid], because the worker's HTML_PDF engine
 * renders directly from that snapshot (see worker/src/index.ts processItem) —
 * it no longer looks up a hardcoded template registry by googleDocId. Without
 * this snapshot, every HTML_PDF job would fail at TEMPLATE_LOADING regardless
 * of how correctly the template was published.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, argOf, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

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

async function load(db: FakeDb): Promise<AsyncJobModule> {
  const mod = await loadModule(new URL("./async-job.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "./engine-config.ts": { getDocumentMergeEngine: () => "GOOGLE_DOCS" },
      "./template-routing.ts": {
        selectTemplateForApplicant: () => ({ template: null, kind: "GENERIC" }),
        documentKindLabel: (k: string) => k,
      },
      "./queue-types.ts": {
        ITEM_STATUS: { QUEUED: "QUEUED" },
        JOB_STATUS: { QUEUED: "QUEUED" },
      },
      "../../document-templates/registry.ts": {
        getHtmlTemplateByGoogleDocId: () => null,
        getHtmlTemplateContractByGoogleDocId: () => null,
      },
      "./template-contract.ts": {
        validateContractRequiredMappings: () => [],
        validateTemplateContract: () => ({ valid: true, missingFromHtml: [], unknownInHtml: [], duplicateKeys: [] }),
      },
      "./placeholder-extractor.ts": {
        extractUniquePlaceholders: (html: string) => Array.from(new Set(
          [...html.matchAll(/(?:<<\s*([^>]+?)\s*>>|\{\{\s*([^{}]+?)\s*\}\})/g)].map((m) => (m[1] ?? m[2]).trim()),
        )).sort(),
      },
    },
  });
  return mod as unknown as AsyncJobModule;
}

const TEMPLATE_ROW = { id: "tpl-1", isActive: true, htmlEnabled: true, name: "Đăng ký tập nghề", documentKind: "B", googleDocId: "gdoc-1", currentPublishedVersion: 2 };
const PUBLISHED_VERSION_ROW = {
  templateId: "tpl-1",
  version: 2,
  retentionYears: 3,
  htmlBody: "<p><<Ho_ten>></p>",
  printCss: "p{color:red}",
};

function fixtureDb(publishedVersion: typeof PUBLISHED_VERSION_ROW | null): FakeDb {
  return createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "merge_templates") return [TEMPLATE_ROW];
      if (call.root === "select" && call.table === "daily_applications") return [{ id: "app-1", declaredType: "NEW", dwMatch: "NO_MATCH" }];
      if (call.root === "select" && call.table === "merge_template_fields") {
        return [{ templateId: "tpl-1", placeholder: "Ho_ten", sourceType: "CORE_FIELD", sourceEntity: null, sourceField: null, sourcePath: "fullName", optionValue: null, formatType: "RAW", fallbackValue: null, isRequired: false }];
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
    /HTML PUBLISHED/,
  );
  assert.equal(db.calls.some((c) => c.root === "insert" && c.table === "merge_jobs"), false);
});
