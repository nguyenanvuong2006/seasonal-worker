/**
 * GET /api/document-merge/templates/[id]/versions/[versionId]/ai-export —
 * regression tests. Same pattern as preview/route.test.ts: transpile the
 * REAL route.ts source, run it in a vm sandbox with a require() shim, use
 * fake-drizzle to inspect every DB call the route issues.
 *
 * PROVES (not just claims): zero DB writes, PUBLISHED uses frozen
 * mapping_snapshot, DRAFT uses current fields, package contains no PII/secrets.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as yazl from "yazl";
import { createFakeDb, drizzleStub, makeTable, type FakeDb, type QueryCall } from "../../../../lib/test-support/fake-drizzle.ts";
import * as draftPreview from "../../../../lib/document-merge/draft-preview.ts";
import * as aiTemplateExport from "../../../../lib/document-merge/ai-template-export.ts";

const routeSource = readFileSync(new URL("./[id]/versions/[versionId]/ai-export/route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

const TEMPLATE = {
  id: "tpl-1",
  name: "Đăng ký tập nghề",
  documentKind: "B",
  isActive: true,
  currentPublishedVersion: 3,
  htmlEnabled: true,
};

const PUBLISHED_VERSION = {
  id: "v-3",
  templateId: "tpl-1",
  version: 3,
  status: "PUBLISHED",
  htmlBody: `<div class="page"><p><<Ho_ten>></p><p><<Dia_chi_thuong_tru>></p></div>`,
  printCss: ".page { width: 100%; }",
  mappingSnapshot: [
    { placeholder: "Ho_ten", sourceType: "CORE_FIELD", sourceEntity: null, sourceField: null, sourcePath: "fullName", optionValue: null, formatType: "RAW", fallbackValue: null, isRequired: true },
    { placeholder: "Dia_chi_thuong_tru", sourceType: "CORE_FIELD", sourceEntity: null, sourceField: null, sourcePath: "permanentAddress", optionValue: null, formatType: "RAW", fallbackValue: null, isRequired: false },
  ],
};

const DRAFT_VERSION = {
  id: "v-4",
  templateId: "tpl-1",
  version: 4,
  status: "DRAFT",
  htmlBody: `<div class="page"><p><<Ho_ten>></p></div>`,
  printCss: "",
  mappingSnapshot: [],
};

const LIVE_FIELD = {
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
};

type Options = { role?: string; version?: typeof PUBLISHED_VERSION | typeof DRAFT_VERSION | null; templateExists?: boolean };

function makeContext(opts: Options = {}) {
  const role = opts.role ?? "ADMIN";
  const version = opts.version === undefined ? PUBLISHED_VERSION : opts.version;
  const templateExists = opts.templateExists ?? true;

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "merge_templates") return templateExists ? [TEMPLATE] : [];
      if (call.root === "select" && call.table === "merge_template_versions") return version ? [version] : [];
      if (call.root === "select" && call.table === "merge_template_fields") return [LIVE_FIELD];
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
          return {
            NextResponse: class {
              status: number;
              headers: Record<string, string>;
              body: unknown;
              constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
                this.body = body;
                this.status = init?.status ?? 200;
                this.headers = init?.headers ?? {};
              }
              static json(body: unknown, init?: { status?: number }) {
                return { status: init?.status ?? 200, isJson: true, body };
              }
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
              if (!allowed) return { ok: false as const, status: 403, error: "Từ chối truy cập." };
              return { ok: true as const, session: { id: "u1", username: role, fullName: role, role, deptId: null } };
            },
          };
        case "@/lib/document-merge/draft-preview":
          return draftPreview;
        case "@/lib/document-merge/ai-template-export":
          return aiTemplateExport;
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
    Uint8Array,
  });
  vm.runInContext(jsSource, context);
  return {
    GET: (moduleObj.exports as { GET: (req: Request, ctx: unknown) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> }).GET,
    db,
  };
}

function ctxFor(templateId = "tpl-1", versionId = "v-3") {
  return { params: Promise.resolve({ id: templateId, versionId }) };
}

test("ai-export: ADMIN can export a PUBLISHED version — returns a ZIP with correct headers", async () => {
  const { GET, db } = makeContext();
  const res = await GET(new Request("http://localhost/x"), ctxFor());
  assert.equal(res.status, 200);
  assert.equal(res.headers?.["Content-Type"], "application/zip");
  assert.match(res.headers?.["Content-Disposition"] ?? "", /attachment; filename=".*\.zip"/);
  assert.equal(db.calls.filter((c) => c.root !== "select").length, 0, "ZERO non-select DB calls");
});

test("ai-export: non-ADMIN/HR_RECRUITER role is rejected (403)", async () => {
  const { GET } = makeContext({ role: "DEPT_MANAGER" });
  const res = await GET(new Request("http://localhost/x"), ctxFor());
  assert.equal(res.status, 403);
});

test("ai-export: HR_RECRUITER role is allowed", async () => {
  const { GET } = makeContext({ role: "HR_RECRUITER" });
  const res = await GET(new Request("http://localhost/x"), ctxFor());
  assert.equal(res.status, 200);
});

test("ai-export: unknown template returns 404", async () => {
  const { GET } = makeContext({ templateExists: false });
  const res = await GET(new Request("http://localhost/x"), ctxFor());
  assert.equal(res.status, 404);
});

test("ai-export: unknown version returns 404", async () => {
  const { GET } = makeContext({ version: null });
  const res = await GET(new Request("http://localhost/x"), ctxFor());
  assert.equal(res.status, 404);
});

test("ai-export: version with no htmlBody returns a controlled 400, not a crash", async () => {
  const { GET } = makeContext({ version: { ...DRAFT_VERSION, htmlBody: "" } });
  const res = await GET(new Request("http://localhost/x"), ctxFor());
  assert.equal(res.status, 400);
});

test("ai-export: ZERO database writes for the whole request (SELECT only)", async () => {
  const { GET, db } = makeContext();
  await GET(new Request("http://localhost/x"), ctxFor());
  assert.equal(db.calls.some((c) => c.root === "insert" || c.root === "update" || c.root === "delete"), false);
});

async function unzipEntries(buf: Buffer): Promise<Map<string, string>> {
  const zlib = await import("node:zlib");
  return new Promise((resolve, reject) => {
    // yazl only writes; use a tiny manual central-directory-free scan since we
    // control the writer (yazl) — read local file headers sequentially.
    const entries = new Map<string, string>();
    let offset = 0;
    while (offset < buf.length) {
      if (buf.readUInt32LE(offset) !== 0x04034b50) break; // local file header signature
      const nameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const compSize = buf.readUInt32LE(offset + 18);
      const method = buf.readUInt16LE(offset + 8);
      const name = buf.toString("utf-8", offset + 30, offset + 30 + nameLen);
      const dataStart = offset + 30 + nameLen + extraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) {
        entries.set(name, raw.toString("utf-8"));
      } else {
        entries.set(name, zlib.inflateRawSync(raw).toString("utf-8"));
      }
      offset = dataStart + compSize;
    }
    resolve(entries);
  });
}

test("ai-export: PUBLISHED export uses the frozen mapping_snapshot (not live fields)", async () => {
  const { GET } = makeContext({ version: PUBLISHED_VERSION });
  const res = await GET(new Request("http://localhost/x"), ctxFor()) as unknown as { body: Uint8Array; status: number };
  const zipBuf = Buffer.from(res.body);
  const entries = await unzipEntries(zipBuf);
  const manifest = JSON.parse(entries.get("template-manifest.json")!);
  assert.equal(manifest.mappingSource, "PUBLISHED_MAPPING_SNAPSHOT");
  const addr = manifest.placeholders.find((p: { key: string }) => p.key === "Dia_chi_thuong_tru");
  assert.equal(addr.sourcePath, "permanentAddress");
});

test("ai-export: DRAFT export uses current live merge_template_fields (empty snapshot)", async () => {
  const { GET } = makeContext({ version: DRAFT_VERSION });
  const res = await GET(new Request("http://localhost/x"), ctxFor("tpl-1", "v-4")) as unknown as { body: Uint8Array };
  const entries = await unzipEntries(Buffer.from(res.body));
  const manifest = JSON.parse(entries.get("template-manifest.json")!);
  assert.equal(manifest.mappingSource, "CURRENT_MERGE_TEMPLATE_FIELDS");
});

test("ai-export: package contains exactly the 4 expected files, no more", async () => {
  const { GET } = makeContext();
  const res = await GET(new Request("http://localhost/x"), ctxFor()) as unknown as { body: Uint8Array };
  const entries = await unzipEntries(Buffer.from(res.body));
  assert.deepEqual([...entries.keys()].sort(), ["README-AI.md", "print.css", "template-manifest.json", "template.html"]);
});

test("ai-export: package contains no candidate PII (no real CCCD/phone-shaped values)", async () => {
  const { GET } = makeContext();
  const res = await GET(new Request("http://localhost/x"), ctxFor()) as unknown as { body: Uint8Array };
  const entries = await unzipEntries(Buffer.from(res.body));
  const combined = [...entries.values()].join("\n");
  assert.doesNotMatch(combined, /\b\d{12}\b/);
  assert.doesNotMatch(combined, /\b0\d{9}\b/);
});

test("ai-export: package contains no secret/env values", async () => {
  const { GET } = makeContext();
  const res = await GET(new Request("http://localhost/x"), ctxFor()) as unknown as { body: Uint8Array };
  const entries = await unzipEntries(Buffer.from(res.body));
  const combined = [...entries.values()].join("\n");
  assert.doesNotMatch(combined, /DATABASE_URL/i);
  assert.doesNotMatch(combined, /postgres(ql)?:\/\//i);
});

void yazl; // keep import graph explicit (used indirectly via aiTemplateExport)
