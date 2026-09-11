/**
 * SHARED PREVIEW/PDF-PREVIEW RESOLVER — regression tests.
 *
 * resolveTemplateVersionPreview() is the ONE place that turns
 * (templateId, versionId, applicationId, signingContext, session, scope)
 * into a renderCanonicalDocument() result. Both the DOM "Quick Preview"
 * route and the "A4 PDF Preview" route call exactly this function, so a
 * behavioral proof here covers both routes at once — the routes themselves
 * (see draft-preview-route.test.ts, preview-pdf-route.test.ts) only need to
 * test their own auth guard / response mapping / error translation.
 *
 * Ported from the pre-refactor draft-preview-route.test.ts, which asserted
 * these same invariants directly against the route before this module was
 * extracted (2026-09, "A4 PDF Preview" feature).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, eqValue, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";
import * as draftPreviewModule from "./draft-preview.ts";
import type { ResolvedPreview } from "./preview-render.ts";

type PreviewRenderModule = {
  resolveTemplateVersionPreview: (input: Record<string, unknown>) => Promise<ResolvedPreview>;
  PreviewResolutionError: new (code: string, message: string, status: number, action?: string, templateId?: string | null) => Error & {
    code: string;
    status: number;
    action?: string;
    templateId?: string | null;
  };
};

const schemaStub = {
  dailyApplications: makeTable("daily_applications"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

const TEMPLATE = {
  id: "tpl-1",
  name: "Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế",
  googleDocId: "doc-1",
  documentKind: "B",
  isActive: true,
  currentPublishedVersion: 7,
};

function makeVersion(version: number, status: string, mappingSnapshot: unknown[] = [], id = `ver-${version}`) {
  return {
    id,
    templateId: "tpl-1",
    version,
    status,
    htmlBody: `<div class="paper"><p>{{Ho_ten}}</p></div><div class="paper regulations-page"><p>v${version}</p></div>`,
    printCss: ".paper { width: 210mm; }",
    sourceDocxName: null,
    retentionYears: 3,
    mappingSnapshot,
    createdBy: "admin",
    publishedAt: status === "PUBLISHED" ? new Date("2026-08-20T00:00:00Z") : null,
    archivedAt: null,
    supersededBy: null,
    createdAt: new Date("2026-08-24T00:00:00Z"),
    updatedAt: new Date("2026-08-24T00:00:00Z"),
  };
}

const CURRENT_FIELD = {
  id: "f1",
  templateId: "tpl-1",
  placeholder: "Ho_ten",
  sourceType: "CORE_FIELD",
  sourceEntity: null,
  sourceField: null,
  sourcePath: "fullName",
  optionValue: null,
  formatType: null,
  fallbackValue: null,
  isRequired: true,
  isOrphaned: false,
  isSuggested: false,
};

const FROZEN_SNAPSHOT_ROW = {
  placeholder: "Ho_ten",
  sourceType: "CORE_FIELD",
  sourceEntity: null,
  sourceField: null,
  sourcePath: "FROZEN_AT_PUBLISH",
  optionValue: null,
  formatType: null,
  fallbackValue: null,
  isRequired: true,
};

type Options = {
  versions?: ReturnType<typeof makeVersion>[];
  fields?: (typeof CURRENT_FIELD)[];
  scope?: string[] | null;
  candidateDeptId?: string | null;
  candidateExists?: boolean;
  templateExists?: boolean;
};

function makeHarness(opts: Options = {}) {
  const versions = opts.versions ?? [makeVersion(8, "DRAFT")];
  const fields = opts.fields ?? [CURRENT_FIELD];

  const db: FakeDb = createFakeDb({
    respond: (call) => {
      if (call.root !== "select") return undefined;
      if (call.table === "merge_templates") return opts.templateExists === false ? [] : [TEMPLATE];
      if (call.table === "merge_template_versions") {
        const wantedId = eqValue(call, "merge_template_versions.id");
        return versions.filter((row) => row.id === wantedId);
      }
      if (call.table === "merge_template_fields") return fields;
      if (call.table === "daily_applications") {
        if (opts.candidateExists === false) return [];
        return [{ id: "app-1", deptId: opts.candidateDeptId === undefined ? "dept-1" : opts.candidateDeptId }];
      }
      return [];
    },
  });

  const renderCalls: { templateVersion: number; mappings: { placeholder: string; sourcePath: string | null }[]; context: Record<string, unknown> }[] = [];
  const loaderCalls: string[][] = [];

  const mod = loadModule(new URL("./preview-render.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "./canonical-document": {
        CANONICAL_ACTION_VI: "ACTION",
        isCanonicalTemplateError: (e: unknown) => Boolean(e) && (e as { name?: string }).name === "CanonicalTemplateError",
        buildCanonicalSnapshot: (input: {
          templateId: string;
          version: ReturnType<typeof makeVersion>;
          mappings: { placeholder: string; sourcePath: string | null }[];
          formatting: Record<string, unknown>;
          allowUnpublishedForVerification?: boolean;
        }) => ({
          templateId: input.templateId,
          templateVersion: input.version.version,
          htmlBody: input.version.htmlBody,
          printCss: input.version.printCss,
          mappings: input.mappings,
          formatting: input.formatting,
          allowUnpublished: Boolean(input.allowUnpublishedForVerification),
        }),
        renderCanonicalDocument: (
          snapshot: { htmlBody: string; templateId: string; templateVersion: number; printCss: string | null; mappings: { placeholder: string; sourcePath: string | null }[] },
          _recordData: unknown,
          context: Record<string, unknown>,
        ) => {
          renderCalls.push({ templateVersion: snapshot.templateVersion, mappings: snapshot.mappings, context });
          return {
            html: `<!DOCTYPE html><html><body>${snapshot.htmlBody}</body></html>`,
            unreplaced: [],
            missingFields: [],
            valid: true,
            templateId: snapshot.templateId,
            templateVersion: snapshot.templateVersion,
            printCss: snapshot.printCss,
            margins: { topMm: 10, bottomMm: 10, leftMm: 12, rightMm: 12 },
          };
        },
      },
      "./record-loader": {
        loadDailyApplicationRecords: async (ids: string[]) => {
          loaderCalls.push(ids);
          return new Map([[ids[0], { id: ids[0], fullName: "Trần Văn Dũng", cccd: "068098012345" }]]);
        },
      },
      "@/document-templates/registry": { getHtmlTemplateContractByGoogleDocId: () => null },
      "./draft-preview": draftPreviewModule,
    },
  }) as unknown as PreviewRenderModule;

  return { mod, db, renderCalls, loaderCalls };
}

const SESSION = { id: "u-1", username: "ADMIN", fullName: "ADMIN", role: "ADMIN", deptId: null };

function resolve(mod: PreviewRenderModule, harness: ReturnType<typeof makeHarness>, overrides: Record<string, unknown> = {}) {
  return mod.resolveTemplateVersionPreview({
    templateId: "tpl-1",
    versionId: "ver-8",
    applicationId: "app-1",
    signingContext: {},
    session: SESSION,
    scope: harness === undefined ? null : undefined,
    ...overrides,
  });
}

test("renders the DRAFT version, echoes currentPublishedVersion but does not render from it", async () => {
  const h = makeHarness();
  const result = await resolve(h.mod, h, { scope: null });
  assert.equal(result.version.version, 8);
  assert.equal(result.template.currentPublishedVersion, 7);
  assert.equal(h.renderCalls.length, 1);
  assert.equal(h.renderCalls[0].templateVersion, 8);
});

test("loads the EXPLICITLY requested version id, cross-checked against templateId — never filters by status", async () => {
  const h = makeHarness({ versions: [makeVersion(8, "DRAFT", [], "ver-8"), makeVersion(7, "PUBLISHED", [FROZEN_SNAPSHOT_ROW], "ver-7")] });
  const result = await resolve(h.mod, h, { scope: null });
  assert.match((result.rendered as { html: string }).html, /v8/);
  assert.doesNotMatch((result.rendered as { html: string }).html, /v7/);

  const versionSelect = h.db.calls.find((c): c is QueryCall => c.root === "select" && c.table === "merge_template_versions");
  assert.ok(versionSelect);
  assert.equal(eqValue(versionSelect, "merge_template_versions.id"), "ver-8");
  assert.equal(eqValue(versionSelect, "merge_template_versions.templateId"), "tpl-1");
  assert.equal(eqValue(versionSelect, "merge_template_versions.status"), undefined);
});

test("a version id belonging to another template is rejected with PreviewResolutionError VERSION_NOT_FOUND", async () => {
  const h = makeHarness({ versions: [makeVersion(8, "DRAFT", [], "ver-8")] });
  await assert.rejects(
    () => resolve(h.mod, h, { versionId: "ver-from-other-template", scope: null }),
    (err: unknown) => err instanceof h.mod.PreviewResolutionError && (err as { code: string }).code === "VERSION_NOT_FOUND",
  );
  assert.equal(h.renderCalls.length, 0);
});

test("DRAFT resolves CURRENT non-orphaned merge_template_fields (mapping source CURRENT_MERGE_TEMPLATE_FIELDS)", async () => {
  const h = makeHarness({ fields: [CURRENT_FIELD, { ...CURRENT_FIELD, id: "f2", placeholder: "Ngay_sinh", sourcePath: "dob" }] });
  const result = await resolve(h.mod, h, { scope: null });
  assert.equal(result.mappingSource, "CURRENT_MERGE_TEMPLATE_FIELDS");
  assert.deepEqual(result.mappingSummary, { total: 2, mapped: 2, required: 2 });
  assert.deepEqual(h.renderCalls[0].mappings.map((m) => m.placeholder), ["Ho_ten", "Ngay_sinh"]);

  const fieldSelect = h.db.calls.find((c): c is QueryCall => c.root === "select" && c.table === "merge_template_fields");
  assert.ok(fieldSelect);
  assert.equal(eqValue(fieldSelect, "merge_template_fields.isOrphaned"), false);
});

test("PUBLISHED renders its FROZEN mapping_snapshot, ignoring live field edits", async () => {
  const h = makeHarness({
    versions: [makeVersion(7, "PUBLISHED", [FROZEN_SNAPSHOT_ROW], "ver-7")],
    fields: [{ ...CURRENT_FIELD, sourcePath: "EDITED_AFTER_PUBLISH" }],
  });
  const result = await resolve(h.mod, h, { versionId: "ver-7", scope: null });
  assert.equal(result.mappingSource, "PUBLISHED_MAPPING_SNAPSHOT");
  assert.equal(result.unpublished, false);
  assert.equal(h.renderCalls[0].mappings[0].sourcePath, "FROZEN_AT_PUBLISH");
});

test("candidate data scope: out-of-scope applicationId rejected, never even loaded", async () => {
  const h = makeHarness({ candidateDeptId: "dept-forbidden" });
  await assert.rejects(
    () => resolve(h.mod, h, { scope: ["dept-allowed"] }),
    (err: unknown) => err instanceof h.mod.PreviewResolutionError && (err as { code: string }).code === "APPLICATION_NOT_FOUND",
  );
  assert.equal(h.renderCalls.length, 0);
  assert.equal(h.loaderCalls.length, 0, "the candidate record is never even loaded when out of scope");
});

test("in-scope candidate renders; unrestricted scope (null) also renders", async () => {
  const h1 = makeHarness({ candidateDeptId: "dept-1" });
  await resolve(h1.mod, h1, { scope: ["dept-1"] });
  assert.equal(h1.renderCalls.length, 1);

  const h2 = makeHarness();
  await resolve(h2.mod, h2, { scope: null });
  assert.equal(h2.renderCalls.length, 1);
});

test("empty data scope can resolve nobody", async () => {
  const h = makeHarness({ candidateDeptId: "dept-1" });
  await assert.rejects(() => resolve(h.mod, h, { scope: [] }));
  assert.equal(h.renderCalls.length, 0);
});

test("unknown template → PreviewResolutionError TEMPLATE_NOT_FOUND, unknown candidate → APPLICATION_NOT_FOUND", async () => {
  const h1 = makeHarness({ templateExists: false });
  await assert.rejects(
    () => resolve(h1.mod, h1, { scope: null }),
    (err: unknown) => err instanceof h1.mod.PreviewResolutionError && (err as { code: string }).code === "TEMPLATE_NOT_FOUND",
  );

  const h2 = makeHarness({ candidateExists: false });
  await assert.rejects(
    () => resolve(h2.mod, h2, { scope: null }),
    (err: unknown) => err instanceof h2.mod.PreviewResolutionError && (err as { code: string }).code === "APPLICATION_NOT_FOUND",
  );
});

test("template without active mapping → PreviewResolutionError MAPPING_MISSING, never renders raw placeholders", async () => {
  const h = makeHarness({ fields: [] });
  await assert.rejects(
    () => resolve(h.mod, h, { scope: null }),
    (err: unknown) => err instanceof h.mod.PreviewResolutionError && (err as { code: string }).code === "MAPPING_MISSING",
  );
  assert.equal(h.renderCalls.length, 0);
});

test("Signing Context supplied reaches renderCanonicalDocument's context verbatim", async () => {
  const h = makeHarness();
  const signingContext = { signingDate: "2026-08-26", signingLocation: "Đà Lạt" };
  await resolve(h.mod, h, { scope: null, signingContext });
  const passedContext = h.renderCalls[0].context.signingContext as { signingDate: string; signingLocation: string };
  assert.equal(passedContext.signingDate, "2026-08-26");
  assert.equal(passedContext.signingLocation, "Đà Lạt");
});

test("uses loadDailyApplicationRecords — the SAME record loader the worker uses", async () => {
  const h = makeHarness();
  await resolve(h.mod, h, { scope: null });
  // JSON-compare, not deepEqual: array literals built inside the vm sandbox
  // have a different Array prototype identity than this file's Array.
  assert.equal(JSON.stringify(h.loaderCalls), JSON.stringify([["app-1"]]));
});
