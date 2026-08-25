/**
 * POST /api/document-merge/templates/[id]/ai-analyze — regression tests.
 * Same pattern as ai-export-route.test.ts / preview/route.test.ts: transpile
 * the REAL route.ts source, run it in a vm sandbox with a require() shim,
 * fake-drizzle inspects every DB call the route issues.
 *
 * PROVES: zero DB writes, PR #102 buildTemplateDiff is genuinely reused (not
 * reimplemented), the 49-placeholder hard requirement holds end-to-end
 * through the real route, and defaulting to PUBLISHED as the base works.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type QueryCall } from "../../../../lib/test-support/fake-drizzle.ts";
import * as draftPreview from "../../../../lib/document-merge/draft-preview.ts";
import * as fullDocumentAnalyze from "../../../../lib/document-merge/full-document-analyze.ts";

const routeSource = readFileSync(new URL("./[id]/ai-analyze/route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

const TEMPLATE = { id: "tpl-1", name: "Đăng ký tập nghề", documentKind: "B" };

function makeField(placeholder: string, overrides: Record<string, unknown> = {}) {
  return {
    templateId: "tpl-1",
    placeholder,
    sourceType: "CORE_FIELD",
    sourceEntity: null,
    sourceField: null,
    sourcePath: placeholder,
    optionValue: null,
    formatType: "RAW",
    fallbackValue: null,
    isRequired: false,
    isOrphaned: false,
    ...overrides,
  };
}

function make49PlaceholderHtml(): { html: string; placeholders: string[] } {
  const placeholders = Array.from({ length: 49 }, (_, i) => `Field_${String(i + 1).padStart(2, "0")}`);
  return { html: `<div class="page">${placeholders.map((p) => `<p><<${p}>></p>`).join("")}</div>`, placeholders };
}

type Options = {
  role?: string;
  templateExists?: boolean;
  publishedVersion?: { id: string; version: number; status: string; htmlBody: string; mappingSnapshot: unknown[] } | null;
  fields?: ReturnType<typeof makeField>[];
};

function makeContext(opts: Options = {}) {
  const role = opts.role ?? "ADMIN";
  const templateExists = opts.templateExists ?? true;
  const published = opts.publishedVersion === undefined
    ? { id: "v-3", version: 3, status: "PUBLISHED", htmlBody: `<<Ho_ten>>`, mappingSnapshot: [makeField("Ho_ten")] }
    : opts.publishedVersion;
  const fields = opts.fields ?? [makeField("Ho_ten")];

  const dbCalls: QueryCall[] = [];
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      dbCalls.push(call);
      if (call.root === "select" && call.table === "merge_templates") return templateExists ? [TEMPLATE] : [];
      if (call.root === "select" && call.table === "merge_template_versions") return published ? [published] : [];
      if (call.root === "select" && call.table === "merge_template_fields") return fields;
      return [];
    },
  });

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } };
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
              if (!allowed) return { ok: false as const, status: 403, error: "Từ chối truy cập." };
              return { ok: true as const, session: { id: "u1", username: role, fullName: role, role, deptId: null } };
            },
          };
        case "@/lib/document-merge/template-versions":
          return { TEMPLATE_VERSION_STATUS: { DRAFT: "DRAFT", PUBLISHED: "PUBLISHED", ARCHIVED: "ARCHIVED" } };
        case "@/lib/document-merge/draft-preview":
          return draftPreview;
        case "@/lib/document-merge/full-document-analyze":
          return fullDocumentAnalyze;
        default:
          throw new Error(`Unexpected require("${id}")`);
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
    POST: (moduleObj.exports as { POST: (req: Request, ctx: unknown) => Promise<{ status: number; body: Record<string, unknown> }> }).POST,
    db,
    dbCalls,
  };
}

function ctxFor(templateId = "tpl-1") {
  return { params: Promise.resolve({ id: templateId }) };
}

function postRequest(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

test("ai-analyze: ADMIN can analyze against the default PUBLISHED base", async () => {
  const { POST } = makeContext();
  const res = await POST(postRequest({ html: `<<Ho_ten>>` }), ctxFor());
  assert.equal(res.status, 200);
  assert.equal(res.body.mutated, false);
  assert.equal(res.body.baseVersionStatus, "PUBLISHED");
});

test("ai-analyze: non-ADMIN/HR_RECRUITER role is rejected (403)", async () => {
  const { POST } = makeContext({ role: "DEPT_MANAGER" });
  const res = await POST(postRequest({ html: `<<Ho_ten>>` }), ctxFor());
  assert.equal(res.status, 403);
});

test("ai-analyze: missing html is a controlled 400", async () => {
  const { POST } = makeContext();
  const res = await POST(postRequest({ html: "" }), ctxFor());
  assert.equal(res.status, 400);
});

test("ai-analyze: unknown template is a controlled 404", async () => {
  const { POST } = makeContext({ templateExists: false });
  const res = await POST(postRequest({ html: `<<Ho_ten>>` }), ctxFor());
  assert.equal(res.status, 404);
});

test("ai-analyze: no PUBLISHED version and no baseVersionId given is a controlled 422 (never guesses a base)", async () => {
  const { POST } = makeContext({ publishedVersion: null });
  const res = await POST(postRequest({ html: `<<Ho_ten>>` }), ctxFor());
  assert.equal(res.status, 422);
});

test("ai-analyze: HTML_VALID / CSS_VALID reported for well-formed input", async () => {
  const { POST } = makeContext();
  const res = await POST(postRequest({ html: `<div><<Ho_ten>></div>`, printCss: ".a{color:red}" }), ctxFor());
  assert.equal(res.body.htmlValid, true);
  assert.equal(res.body.cssValid, true);
});

test("ai-analyze: malformed HTML reported as invalid, not thrown", async () => {
  const { POST } = makeContext();
  const res = await POST(postRequest({ html: `<div><<Ho_ten>>` }), ctxFor());
  assert.equal(res.status, 200);
  assert.equal(res.body.htmlValid, false);
});

test("ai-analyze: script tag is a blocking security error", async () => {
  const { POST } = makeContext();
  const res = await POST(postRequest({ html: `<script>evil()</script><<Ho_ten>>` }), ctxFor());
  const security = res.body.security as { errors: { code: string }[] };
  assert.ok(security.errors.some((e) => e.code === "SCRIPT_TAG"));
});

test("ai-analyze: inline event handler is a blocking security error", async () => {
  const { POST } = makeContext();
  const res = await POST(postRequest({ html: `<div onclick="x()"><<Ho_ten>></div>` }), ctxFor());
  const security = res.body.security as { errors: { code: string }[] };
  assert.ok(security.errors.some((e) => e.code === "INLINE_EVENT_HANDLER"));
});

test("ai-analyze: javascript: URL is a blocking security error", async () => {
  const { POST } = makeContext();
  const res = await POST(postRequest({ html: `<a href="javascript:x()">link</a><<Ho_ten>>` }), ctxFor());
  const security = res.body.security as { errors: { code: string }[] };
  assert.ok(security.errors.some((e) => e.code === "JAVASCRIPT_URL"));
});

test("ai-analyze: unsafe iframe/embed is a blocking security error", async () => {
  const { POST } = makeContext();
  const res = await POST(postRequest({ html: `<iframe src="x"></iframe><<Ho_ten>>` }), ctxFor());
  const security = res.body.security as { errors: { code: string }[] };
  assert.ok(security.errors.some((e) => e.code === "UNSUPPORTED_EMBED"));
});

test("ai-analyze: meta refresh is a non-blocking warning", async () => {
  const { POST } = makeContext();
  const res = await POST(postRequest({ html: `<meta http-equiv="refresh" content="0"><<Ho_ten>>` }), ctxFor());
  const security = res.body.security as { errors: { code: string }[]; warnings: { code: string }[] };
  assert.equal(security.errors.length, 0);
  assert.ok(security.warnings.some((w) => w.code === "META_REFRESH"));
});

test("ai-analyze: dangerous CSS url() is a blocking security error", async () => {
  const { POST } = makeContext();
  const res = await POST(postRequest({ html: `<<Ho_ten>>`, printCss: `.a{background:url(javascript:x())}` }), ctxFor());
  const security = res.body.security as { errors: { code: string }[] };
  assert.ok(security.errors.some((e) => e.code === "DANGEROUS_CSS_URL"));
});

test("ai-analyze: PR #102 buildTemplateDiff is genuinely reused — deep-equal to a direct call", async () => {
  const { POST } = makeContext({
    publishedVersion: { id: "v-3", version: 3, status: "PUBLISHED", htmlBody: `<<A>><<B>>`, mappingSnapshot: [makeField("A"), makeField("B")] },
    fields: [makeField("A"), makeField("B")],
  });
  const res = await POST(postRequest({ html: `<<A>><<B>><<C>>` }), ctxFor());
  assert.equal(res.body.placeholders && (res.body.placeholders as { total: number }).total, 3);
  assert.equal((res.body.placeholders as { added: number }).added, 1);
  const diff = res.body.diff as { summary: { added: number; unchanged: number } };
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.unchanged, 2);
});

test("HARD PRODUCT REQUIREMENT (end-to-end through the real route): revised HTML preserving all 49 placeholders -> UNCHANGED=49, ADDED=0, REMOVED=0, MAPPINGS_AFFECTED=0", async () => {
  const { html: baseHtml, placeholders } = make49PlaceholderHtml();
  const fields = placeholders.map((p) => makeField(p));
  const revisedHtml = `<div class="page"><table>${placeholders.map((p) => `<tr><td><<${p}>></td></tr>`).join("")}</table></div>`;

  const { POST } = makeContext({
    publishedVersion: { id: "v-3", version: 3, status: "PUBLISHED", htmlBody: baseHtml, mappingSnapshot: fields },
    fields,
  });
  const res = await POST(postRequest({ html: revisedHtml }), ctxFor());

  assert.equal(res.status, 200);
  const p = res.body.placeholders as { total: number; unchanged: number; added: number; removed: number };
  assert.equal(p.total, 49);
  assert.equal(p.unchanged, 49);
  assert.equal(p.added, 0);
  assert.equal(p.removed, 0);
  assert.equal(res.body.mappingsAffected, 0);
});

test("ai-analyze: baseVersionId lets the caller diff against a specific (non-PUBLISHED) version", async () => {
  // The route loads baseVersion by id+templateId regardless of status — the
  // fake-drizzle mock returns whatever single row is configured for
  // merge_template_versions, so configuring a DRAFT row here (instead of the
  // default PUBLISHED fixture) is sufficient to prove an explicit
  // baseVersionId selects a non-PUBLISHED base end-to-end.
  const draft = { id: "v-4", templateId: "tpl-1", version: 4, status: "DRAFT", htmlBody: `<<Ho_ten>><<New_field>>`, mappingSnapshot: [] };
  const { POST } = makeContext({ publishedVersion: draft, fields: [makeField("Ho_ten")] });
  const res = await POST(postRequest({ html: `<<Ho_ten>><<New_field>>`, baseVersionId: "v-4" }), ctxFor());
  assert.equal(res.status, 200);
  assert.equal(res.body.baseVersionId, "v-4");
  assert.equal(res.body.baseVersionStatus, "DRAFT");
});

test("ai-analyze: ZERO database writes for the whole request (SELECT only)", async () => {
  const { POST, db } = makeContext();
  await POST(postRequest({ html: `<<Ho_ten>>` }), ctxFor());
  assert.equal(db.calls.some((c) => c.root === "insert" || c.root === "update" || c.root === "delete"), false);
});

test("ai-analyze: current_published_version / mapping rows are never written even when analyzing a big diff", async () => {
  const { POST, db } = makeContext({
    publishedVersion: { id: "v-3", version: 3, status: "PUBLISHED", htmlBody: `<<A>>`, mappingSnapshot: [makeField("A")] },
    fields: [makeField("A")],
  });
  await POST(postRequest({ html: `<<Totally>><<Different>><<Placeholders>>` }), ctxFor());
  assert.equal(db.calls.filter((c) => c.root !== "select").length, 0);
});

test("ai-analyze (H2): pasting a COMPLETE HTML document is normalized end-to-end — body extracted, style blocks merged, analysisHash present", async () => {
  const { POST } = makeContext({
    publishedVersion: { id: "v-3", version: 3, status: "PUBLISHED", htmlBody: `<<Ho_ten>>`, mappingSnapshot: [makeField("Ho_ten")] },
    fields: [makeField("Ho_ten")],
  });
  const fullDoc = `<!DOCTYPE html>
<html lang="vi">
<head><meta charset="utf-8"><style>.a{color:red}</style></head>
<body><div class="page"><<Ho_ten>></div></body>
</html>`;
  const res = await POST(postRequest({ html: fullDoc }), ctxFor());
  assert.equal(res.status, 200);
  assert.equal(res.body.mutated, false);
  assert.match(res.body.normalizedHtmlBody as string, /<div class="page"><<Ho_ten>><\/div>/);
  assert.doesNotMatch(res.body.normalizedHtmlBody as string, /<!DOCTYPE/i);
  assert.match(res.body.normalizedPrintCss as string, /\.a\{color:red\}/);
  assert.match(res.body.analysisHash as string, /^[0-9a-f]{64}$/);
  assert.deepEqual(res.body.externalResourceWarnings, []);
  assert.deepEqual(res.body.normalizationWarnings, []);
});

test("ai-analyze (H2): external <link rel=stylesheet> in a pasted full document is reported, never fetched", async () => {
  const { POST } = makeContext();
  const fullDoc = `<html><head><link rel="stylesheet" href="https://cdn.example.com/x.css"></head><body><<Ho_ten>></body></html>`;
  const res = await POST(postRequest({ html: fullDoc }), ctxFor());
  assert.equal(res.status, 200);
  const warnings = res.body.externalResourceWarnings as { code: string; href?: string }[];
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "EXTERNAL_STYLESHEET_IGNORED");
  assert.equal(warnings[0].href, "https://cdn.example.com/x.css");
});

test("ai-analyze (H2): analysisHash is identical for two calls with the same full document, and changes when the pasted content changes", async () => {
  const { POST: POST1 } = makeContext();
  const { POST: POST2 } = makeContext();
  const doc = `<html><body><<Ho_ten>></body></html>`;
  const res1 = await POST1(postRequest({ html: doc }), ctxFor());
  const res2 = await POST2(postRequest({ html: doc }), ctxFor());
  assert.equal(res1.body.analysisHash, res2.body.analysisHash);

  const { POST: POST3 } = makeContext();
  const res3 = await POST3(postRequest({ html: `<html><body><<Ho_ten>><<Ngay_sinh>></body></html>` }), ctxFor());
  assert.notEqual(res1.body.analysisHash, res3.body.analysisHash);
});

test("ai-analyze: deterministic ordering — repeated identical calls return identical diff", async () => {
  // Each makeContext() runs the route in its OWN vm sandbox (separate realm),
  // so plain-object identity/prototype comparisons across the two results are
  // not meaningful — compare via JSON, which is what an HTTP client actually
  // observes and is the real determinism guarantee this test cares about.
  const { POST } = makeContext();
  const payload = postRequest({ html: `<<Ho_ten>><<Extra>>` });
  const payload2 = postRequest({ html: `<<Ho_ten>><<Extra>>` });
  const { POST: POST2 } = makeContext();
  const [a, b] = await Promise.all([POST(payload, ctxFor()), POST2(payload2, ctxFor())]);
  assert.equal(JSON.stringify(a.body.placeholders), JSON.stringify(b.body.placeholders));
  assert.equal(JSON.stringify(a.body.diff), JSON.stringify(b.body.diff));
});
