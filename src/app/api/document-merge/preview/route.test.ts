/**
 * POST /api/document-merge/preview — regression tests cho nhánh HTML VERSION
 * PREVIEW (chỉ-đọc, ADMIN-only) + đảm bảo nhánh Google Docs cũ KHÔNG đổi.
 *
 * Cùng khuôn mẫu run-test/route.test.ts: transpile ĐÚNG source route.ts thật,
 * chạy trong vm sandbox với require() giả cho mọi import ngoài; drizzle dùng
 * fake-drizzle chung của repo để soi TOÀN BỘ lệnh ghi (writes) phát ra.
 *
 * Khi nhánh htmlVersion chạy, các module Google Docs / Drive / mail / worker
 * KHÔNG được require và KHÔNG được gọi — require shim sẽ ném lỗi nếu route
 * import module ngoài danh sách cho phép, và test còn soi calls/writes tường
 * minh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  createFakeDb,
  drizzleStub,
  makeTable,
  eqValue,
  type FakeDb,
  type QueryCall,
} from "../../../../lib/test-support/fake-drizzle.ts";

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  dailyApplications: makeTable("daily_applications"),
  departments: makeTable("departments"),
  dwData: makeTable("dw_data"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
  workerProfiles: makeTable("worker_profiles"),
};

const TEMPLATE = {
  id: "tpl-1",
  name: "MẪU ĐĂNG KÝ TẬP NGHỀ",
  description: null,
  googleDocId: "doc-1",
  outputFolderId: null,
  outputFileNamePattern: null,
  defaultMergeMode: "ONE_DOCUMENT",
  dataSources: [],
  documentKind: "A",
  isActive: true,
  currentPublishedVersion: null,
  retentionYears: null,
  htmlEnabled: true,
  createdBy: "admin",
  updatedBy: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function makeVersionRow(version: number, status: string) {
  return {
    id: `v-${version}`,
    templateId: "tpl-1",
    version,
    status,
    htmlBody: `<div class="page"><p><<Ho_ten>></p></div><div class="page"><p>Trang ${version}</p></div>`,
    printCss: "body { color: #000; }",
    sourceDocxName: `v${version}.docx`,
    retentionYears: null,
    mappingSnapshot: [],
    createdBy: "admin",
    publishedAt: status === "PUBLISHED" ? new Date("2026-01-01T00:00:00Z") : null,
    archivedAt: status === "ARCHIVED" ? new Date("2026-01-01T00:00:00Z") : null,
    supersededBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const FIELD = {
  id: "f1",
  templateId: "tpl-1",
  placeholder: "Ho_ten",
  sourceType: "CORE_FIELD",
  sourceEntity: null,
  sourceField: null,
  sourcePath: "fullName",
  optionValue: null,
  formatType: "RAW",
  fallbackValue: null,
  isRequired: true,
  isOrphaned: false,
  isSuggested: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const APP_ROW = {
  application: {
    id: "app-1",
    cccd: "123456789",
    fullName: "Bùi Nguyễn Phương Vy",
    gender: "Nữ",
    dob: "2000-01-01",
    phone: "0900000000",
    ethnicity: "Kinh",
    permanentAddress: "A",
    residentialAddress: "B",
    declaredType: "NEW",
    dwMatch: "NEW",
    dwCode: "DW-1",
    itCode: null,
    workDuration: null,
    referralChannel: null,
    status: "ACTIVE",
    regDate: "2026-01-01",
    startingDate: "2026-02-01",
    customAnswers: null,
  },
  deptName: "Phòng A",
  groupName: null,
  vnName: null,
  location: null,
  division: null,
  section: null,
  supervisor: null,
  supervisorPhone: null,
  dw: null,
  worker: null,
};

type Options = {
  role?: string;
  versionRows?: ReturnType<typeof makeVersionRow>[];
  env?: Record<string, string>;
};

type Context = {
  POST: (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  db: FakeDb;
  renderCalls: { version: ReturnType<typeof makeVersionRow>; fields: unknown[]; recordData: Record<string, unknown> }[];
  loaderCalls: string[][];
  googleCalls: string[];
  requiredIds: string[];
};

function makeContext(opts: Options = {}): Context {
  const role = opts.role ?? "ADMIN";
  const versionRows = opts.versionRows ?? [makeVersionRow(3, "DRAFT")];
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_templates") return [TEMPLATE];
      if (call.root === "select" && call.table === "merge_template_versions") {
        const requested = eqValue(call, "merge_template_versions.version");
        return versionRows.filter((row) => row.version === requested);
      }
      if (call.root === "select" && call.table === "merge_template_fields") return [FIELD];
      if (call.root === "select" && call.table === "daily_applications") return [APP_ROW];
      return [];
    },
  });

  const renderCalls: Context["renderCalls"] = [];
  const loaderCalls: Context["loaderCalls"] = [];
  const googleCalls: Context["googleCalls"] = [];
  const requiredIds: string[] = [];

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      requiredIds.push(id);
      switch (id) {
        case "next/server":
          return {
            NextResponse: {
              json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
            },
          };
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/auth":
          return {
            requirePermission: async (roles: string[]) => {
              const allowed = role === "ADMIN" || roles.includes(role);
              if (!allowed) {
                return { ok: false as const, status: 403, error: "Từ chối truy cập! Quyền hạn không hợp lệ." };
              }
              return {
                ok: true as const,
                session: { id: role === "ADMIN" ? "admin-1" : "hr-1", username: role, fullName: role, role, deptId: null },
              };
            },
          };
        case "@/lib/document-merge/google-docs-service":
          return {
            createGoogleDocsService: () => ({
              getDocumentContent: async () => {
                googleCalls.push("getDocumentContent");
                return { content: "GOOGLE_DOCS_CONTENT" };
              },
            }),
          };
        case "@/lib/document-merge/data-resolver":
          return {
            resolveAllFields: (fields: { placeholder: string }[]) =>
              Object.fromEntries(fields.map((f) => [f.placeholder, `FILLED:${f.placeholder}`])),
            validateRequiredFields: () => ({ missingFields: [], valid: true }),
          };
        case "@/lib/document-merge/preview-merge":
          return {
            applyFallbackPlaceholders: (_record: unknown, mapped: unknown) => mapped,
            buildPreviewContent: (content: unknown, _values: unknown) => ({
              content: `PREVIEW:${String((content as { content?: unknown }).content ?? content)}`,
              unreplaced: [],
            }),
          };
        case "@/lib/document-merge/applicant-record":
          return { buildApplicantMergeRecord: (sources: { application: { id: string; fullName: string } }) => sources.application };
        case "@/lib/document-merge/html-pipeline":
          return {
            renderApplicantDocumentFromVersion: (
              version: ReturnType<typeof makeVersionRow>,
              fields: unknown[],
              recordData: Record<string, unknown>,
            ) => {
              renderCalls.push({ version, fields, recordData });
              return {
                html: `<!DOCTYPE html><html><body>${version.htmlBody ?? ""}</body></html>`,
                unreplaced: [],
                missingFields: [],
                valid: true,
              };
            },
          };
        case "@/document-templates/registry":
          return { getHtmlTemplateContractByGoogleDocId: () => null };
        case "@/lib/document-merge/record-loader":
          return {
            loadDailyApplicationRecords: async (ids: string[]) => {
              loaderCalls.push(ids);
              return new Map([[ids[0], { id: ids[0], fullName: "Bùi Nguyễn Phương Vy", cccd: "123456789" }]]);
            },
          };
        case "@/lib/document-merge/template-routing":
          return {
            documentKindLabel: (kind: string) => `Label ${kind}`,
            resolveDocumentKind: () => "A",
            resolveDwClassification: () => "NEW",
            selectTemplateForApplicant: (_templates: unknown, _info: unknown) => ({ template: TEMPLATE }),
          };
        default:
          throw new Error(`Unexpected require("${id}") — route không được phụ thuộc module này.`);
      }
    },
    process,
    Request,
    console,
    Date,
    JSON,
    Buffer,
    Math,
  });
  vm.runInContext(jsSource, context);
  return {
    POST: (moduleObj.exports as { POST: (req: Request) => Promise<{ status: number; body: Record<string, unknown> }> }).POST,
    db,
    renderCalls,
    loaderCalls,
    googleCalls,
    requiredIds,
  };
}

function requestFor(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/document-merge/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const HTML_PAYLOAD = {
  templateId: "tpl-1",
  applicationId: "app-1",
  autoRoute: false,
  htmlVersion: 3,
};

// A. Existing preview WITHOUT htmlVersion — hành vi Google Docs cũ giữ nguyên.
test("preview: không htmlVersion → nhánh Google Docs cũ (content, không render HTML, không đụng version)", async () => {
  const ctx = makeContext({ role: "ADMIN" });
  const res = await ctx.POST(requestFor({ templateId: "tpl-1", applicationId: "app-1", autoRoute: false }));

  assert.equal(res.status, 200);
  assert.equal(res.body.content, "PREVIEW:GOOGLE_DOCS_CONTENT");
  assert.equal(res.body.templateId, "tpl-1");
  assert.equal(res.body.valid, true);
  assert.equal(ctx.googleCalls.length, 1, "nhánh cũ vẫn gọi Google Docs");
  assert.equal(ctx.renderCalls.length, 0, "nhánh cũ KHÔNG gọi HTML renderer");
  assert.equal(
    ctx.db.calls.filter((c) => c.root === "select" && c.table === "merge_template_versions").length,
    0,
    "nhánh cũ KHÔNG truy vấn merge_template_versions",
  );
  assert.equal(ctx.db.writes.length, 0);
});

// B. Non-admin (HR_SUPPORT) không preview được HTML DRAFT.
test("preview: htmlVersion + HR_SUPPORT → 403, không render, không load record", async () => {
  const ctx = makeContext({ role: "HR_SUPPORT" });
  const res = await ctx.POST(requestFor(HTML_PAYLOAD));

  assert.equal(res.status, 403);
  assert.equal(ctx.renderCalls.length, 0);
  assert.equal(ctx.loaderCalls.length, 0);
  assert.equal(ctx.db.writes.length, 0);
});

// C. htmlVersion=3 loads exactly version 3 (DRAFT allowed in this branch).
test("preview: htmlVersion=3 → load đúng version 3 (DRAFT) và render qua shared renderer", async () => {
  const ctx = makeContext({
    role: "ADMIN",
    versionRows: [makeVersionRow(3, "DRAFT"), makeVersionRow(2, "ARCHIVED")],
  });
  const res = await ctx.POST(requestFor(HTML_PAYLOAD));

  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "HTML_VERSION_PREVIEW");
  assert.equal(res.body.version, 3);
  assert.equal(res.body.versionStatus, "DRAFT");
  assert.equal(res.body.templateId, "tpl-1");
  assert.equal(res.body.recordId, "app-1");
  assert.equal(res.body.fullName, "Bùi Nguyễn Phương Vy");
  assert.deepEqual(res.body.unresolved, []);
  assert.equal(res.body.pageCount, 2);
  assert.match(String(res.body.renderedHtml), /Trang 3/);
  assert.doesNotMatch(String(res.body.renderedHtml), /Trang 2/);

  const versionSelect = ctx.db.calls.find(
    (c): c is QueryCall => c.root === "select" && c.table === "merge_template_versions",
  );
  assert.ok(versionSelect, "phải truy vấn merge_template_versions một lần");
  assert.equal(eqValue(versionSelect, "merge_template_versions.templateId"), "tpl-1");
  assert.equal(eqValue(versionSelect, "merge_template_versions.version"), 3, "điều kiện version = 3");
  assert.equal(
    ctx.db.calls.filter((c) => c.root === "select" && c.table === "merge_template_versions").length,
    1,
  );

  assert.equal(ctx.loaderCalls.length, 1);
  assert.equal(ctx.loaderCalls[0].length, 1);
  assert.equal(ctx.loaderCalls[0][0], "app-1");
  assert.equal(ctx.renderCalls.length, 1);
  assert.equal(ctx.renderCalls[0].version.version, 3);
  assert.equal(ctx.renderCalls[0].version.status, "DRAFT");
});

// C2. htmlVersion=2 → đúng version 2, không phải version khác.
test("preview: htmlVersion=2 → load đúng version 2", async () => {
  const ctx = makeContext({
    role: "ADMIN",
    versionRows: [makeVersionRow(2, "DRAFT"), makeVersionRow(3, "DRAFT")],
  });
  const res = await ctx.POST(requestFor({ ...HTML_PAYLOAD, htmlVersion: 2 }));

  assert.equal(res.status, 200);
  assert.equal(res.body.version, 2);
  assert.match(String(res.body.renderedHtml), /Trang 2/);
  assert.doesNotMatch(String(res.body.renderedHtml), /Trang 3/);
});

// D. autoRoute phải là false.
test("preview: htmlVersion + autoRoute:true → 400 HTML_VERSION_AUTO_ROUTE_FORBIDDEN", async () => {
  const ctx = makeContext({ role: "ADMIN" });
  const res = await ctx.POST(requestFor({ ...HTML_PAYLOAD, autoRoute: true }));

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "HTML_VERSION_AUTO_ROUTE_FORBIDDEN");
  assert.equal(ctx.renderCalls.length, 0);
  assert.equal(ctx.db.writes.length, 0);
});

test("preview: htmlVersion + thiếu autoRoute (mặc định true) → 400", async () => {
  const ctx = makeContext({ role: "ADMIN" });
  const res = await ctx.POST(requestFor({ templateId: "tpl-1", applicationId: "app-1", htmlVersion: 3 }));

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "HTML_VERSION_AUTO_ROUTE_FORBIDDEN");
});

// E. Thiếu templateId.
test("preview: htmlVersion + thiếu templateId → 400 TEMPLATE_REQUIRED", async () => {
  const ctx = makeContext({ role: "ADMIN" });
  const res = await ctx.POST(requestFor({ applicationId: "app-1", autoRoute: false, htmlVersion: 3 }));

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "TEMPLATE_REQUIRED");
  assert.equal(
    ctx.db.calls.filter((c) => c.root === "select" && c.table === "merge_template_versions").length,
    0,
  );
  assert.equal(ctx.renderCalls.length, 0);
});

// F. Thiếu applicationId.
test("preview: htmlVersion + thiếu applicationId → 400 APPLICATION_REQUIRED", async () => {
  const ctx = makeContext({ role: "ADMIN" });
  const res = await ctx.POST(requestFor({ templateId: "tpl-1", autoRoute: false, htmlVersion: 3 }));

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "APPLICATION_REQUIRED");
  assert.equal(ctx.renderCalls.length, 0);
});

// htmlVersion phải là số nguyên > 0. (null được coi như "không truyền" → nhánh
// Google Docs cũ, giống như undefined — xem test A; không phải lỗi.)
test("preview: htmlVersion không phải số nguyên > 0 → 400", async () => {
  for (const bad of [0, -1, 1.5, "3"]) {
    const ctx = makeContext({ role: "ADMIN" });
    const res = await ctx.POST(requestFor({ ...HTML_PAYLOAD, htmlVersion: bad }));
    assert.equal(res.status, 400, `htmlVersion=${String(bad)} phải bị từ chối`);
    assert.equal(res.body.code, "HTML_VERSION_INVALID");
    assert.equal(ctx.renderCalls.length, 0);
  }
});

// G/H/I/L. Nhánh htmlVersion KHÔNG ghi gì xuống DB (jobs / records / history / source records / template).
test("preview: htmlVersion thành công → 0 lệnh ghi (merge_jobs, merge_job_records, document_history, daily_applications, merge_templates, versions)", async () => {
  const ctx = makeContext({ role: "ADMIN" });
  const res = await ctx.POST(requestFor(HTML_PAYLOAD));

  assert.equal(res.status, 200);
  assert.equal(ctx.db.writes.length, 0, `writes = ${JSON.stringify(ctx.db.writes.map((w) => `${w.root}:${w.table}`))}`);
  assert.equal(ctx.db.writesTo("merge_jobs").length, 0);
  assert.equal(ctx.db.writesTo("merge_job_records").length, 0);
  assert.equal(ctx.db.writesTo("document_history").length, 0);
  assert.equal(ctx.db.writesTo("daily_applications").length, 0);
  assert.equal(ctx.db.writesTo("merge_templates").length, 0);
  assert.equal(ctx.db.writesTo("merge_template_versions").length, 0);
});

// J/K. Không gọi Google Docs / Drive.
test("preview: htmlVersion → không gọi Google Docs, không require module Drive", async () => {
  const ctx = makeContext({ role: "ADMIN" });
  const res = await ctx.POST(requestFor(HTML_PAYLOAD));

  assert.equal(res.status, 200);
  assert.equal(ctx.googleCalls.length, 0, "nhánh htmlVersion KHÔNG gọi Google Docs");
  assert.equal(
    ctx.requiredIds.filter((id) => /drive/i.test(id)).length,
    0,
    "không require module Drive",
  );
});

// M. Không email/dispatch/cloud.
test("preview: htmlVersion → không require module mail/email/dispatch/cloud-run", async () => {
  const ctx = makeContext({ role: "ADMIN" });
  const res = await ctx.POST(requestFor(HTML_PAYLOAD));

  assert.equal(res.status, 200);
  const forbidden = ctx.requiredIds.filter((id) => /mail|email|dispatch|cloud|worker/i.test(id));
  assert.deepEqual(forbidden, [], `route không được phụ thuộc: ${forbidden.join(", ")}`);
});

// N. DOCUMENT_MERGE_ENGINE = GOOGLE_DOCS — nhánh htmlVersion vẫn chạy.
test("preview: DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS → htmlVersion preview vẫn hoạt động", async () => {
  const prev = process.env.DOCUMENT_MERGE_ENGINE;
  process.env.DOCUMENT_MERGE_ENGINE = "GOOGLE_DOCS";
  try {
    const ctx = makeContext({ role: "ADMIN", env: { DOCUMENT_MERGE_ENGINE: "GOOGLE_DOCS" } });
    const res = await ctx.POST(requestFor(HTML_PAYLOAD));
    assert.equal(res.status, 200);
    assert.equal(res.body.version, 3);
  } finally {
    if (prev === undefined) delete process.env.DOCUMENT_MERGE_ENGINE;
    else process.env.DOCUMENT_MERGE_ENGINE = prev;
  }
});

// O. Route dùng đúng module shared mà worker HTML_PDF dùng.
test("preview: renderer = renderApplicantDocumentFromVersion từ @/lib/document-merge/html-pipeline (module worker dùng)", () => {
  assert.match(routeSource, /from "@\/lib\/document-merge\/html-pipeline"/);
  assert.match(routeSource, /renderApplicantDocumentFromVersion/);

  const workerSource = readFileSync(new URL("../../../../../worker/src/index.ts", import.meta.url), "utf8");
  assert.match(
    workerSource,
    /renderApplicantDocumentFromParts.*from "\.\.\/\.\.\/src\/lib\/document-merge\/html-pipeline\.ts"/,
    "worker phải import từ CÙNG html-pipeline.ts",
  );

  const pipelineSource = readFileSync(new URL("../../../../lib/document-merge/html-pipeline.ts", import.meta.url), "utf8");
  assert.match(
    pipelineSource,
    /renderApplicantDocumentFromVersion[\s\S]*renderApplicantDocumentFromParts/,
    "renderApplicantDocumentFromVersion phải delegate tới renderApplicantDocumentFromParts (worker path)",
  );
});

// P. DRAFT chỉ được phép trong nhánh htmlVersion; flow sản xuất (không htmlVersion) không đụng version/renderer.
test("preview: DRAFT không thể lọt vào flow sản xuất (không htmlVersion → 0 version query + 0 render)", async () => {
  const ctx = makeContext({ role: "ADMIN", versionRows: [makeVersionRow(3, "DRAFT")] });
  const res = await ctx.POST(requestFor({ templateId: "tpl-1", applicationId: "app-1", autoRoute: false }));

  assert.equal(res.status, 200);
  assert.equal(res.body.content, "PREVIEW:GOOGLE_DOCS_CONTENT");
  assert.equal(
    ctx.db.calls.filter((c) => c.root === "select" && c.table === "merge_template_versions").length,
    0,
  );
  assert.equal(ctx.renderCalls.length, 0);
});

// Version không tồn tại → 404.
test("preview: htmlVersion không tồn tại → 404 VERSION_NOT_FOUND", async () => {
  const ctx = makeContext({ role: "ADMIN", versionRows: [] });
  const res = await ctx.POST(requestFor(HTML_PAYLOAD));

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "VERSION_NOT_FOUND");
  assert.equal(ctx.renderCalls.length, 0);
});
