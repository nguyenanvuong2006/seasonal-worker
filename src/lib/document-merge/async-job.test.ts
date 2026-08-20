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
    },
  });
  return mod as unknown as AsyncJobModule;
}

const TEMPLATE_ROW = { id: "tpl-1", isActive: true, name: "Đăng ký tập nghề", documentKind: "B", googleDocId: "gdoc-1", currentPublishedVersion: 2 };
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
    engine: "HTML_PDF",
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
    engine: "HTML_PDF",
  });

  const jobInsert = db.calls.find((c) => c.root === "insert" && c.table === "merge_jobs");
  const values = argOf(jobInsert as QueryCall, "values") as { metadata: { templates: Record<string, { htmlBody: string | null; printCss: string | null }> } };
  const snap = values.metadata.templates["tpl-1"];
  assert.equal(snap.htmlBody, null);
  assert.equal(snap.printCss, null);
});
