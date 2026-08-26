/**
 * GET /api/document-merge/templates/[id]/versions/[versionId]/ai-export —
 * PRODUCTION-FAITHFUL regression for the Vietnamese-filenames HTTP 500 bug.
 *
 * The sibling ai-export-route.test.ts uses a fake plain-object NextResponse that
 * does NOT validate real HTTP headers, so it cannot reproduce the production
 * crash: `Content-Disposition: filename="<Vietnamese>..."` carries Unicode
 * beyond Latin-1/ByteString, which makes:
 *   - real `new Response(...)` throw `TypeError: Cannot convert argument to a
 *     ByteString ... value ... greater than 255`,
 *   - Node `http.setHeader`/`writeHead` throw `ERR_INVALID_CHAR`.
 * and the whole request becomes an HTTP 500.
 *
 * This test therefore runs the REAL route source with a NextResponse that
 * delegates to a real `Response` object, and PROVES (not just claims) the 10
 * requirements below against real Web `Response` + real Node HTTP validation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import http from "node:http";
import ts from "typescript";
import * as yazl from "yazl";
import { createFakeDb, drizzleStub, makeTable, type FakeDb, type QueryCall } from "../../../../lib/test-support/fake-drizzle.ts";
import * as draftPreview from "../../../../lib/document-merge/draft-preview.ts";
import * as aiTemplateExport from "../../../../lib/document-merge/ai-template-export.ts";

const routeSource = readFileSync(new URL("./[id]/versions/[versionId]/ai-export/route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

// The exact Vietnamese template name that triggered the production 500.
const VIETNAMESE_TEMPLATE_NAME = "Đăng ký tập nghề";
const VERSION_NUMBER = 11;

const schemaStub = {
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

const TEMPLATE = {
  id: "tpl-vn",
  name: VIETNAMESE_TEMPLATE_NAME,
  documentKind: "B",
  isActive: true,
  currentPublishedVersion: VERSION_NUMBER,
  htmlEnabled: true,
};

const VERSION = {
  id: "v-11",
  templateId: "tpl-vn",
  version: VERSION_NUMBER,
  status: "PUBLISHED",
  htmlBody: `<div class="page"><p><<Ho_ten>></p><p><<Dia_chi_thuong_tru>></p></div>`,
  printCss: ".page { width: 100%; }",
  mappingSnapshot: [
    { placeholder: "Ho_ten", sourceType: "CORE_FIELD", sourceEntity: null, sourceField: null, sourcePath: "fullName", optionValue: null, formatType: "RAW", fallbackValue: null, isRequired: true },
    { placeholder: "Dia_chi_thuong_tru", sourceType: "CORE_FIELD", sourceEntity: null, sourceField: null, sourcePath: "permanentAddress", optionValue: null, formatType: "RAW", fallbackValue: null, isRequired: false },
  ],
};

const LIVE_FIELD = {
  templateId: "tpl-vn",
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

type Options = { role?: string };

function makeContext(opts: Options = {}) {
  const role = opts.role ?? "ADMIN";

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "merge_templates") return [TEMPLATE];
      if (call.root === "select" && call.table === "merge_template_versions") return [VERSION];
      if (call.root === "select" && call.table === "merge_template_fields") return [LIVE_FIELD];
      return [];
    },
  });

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    // PRODUCTION-FAITHFUL: NextResponse delegates to a real `Response`, so the
    // route's header construction is validated against real ByteString rules.
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return {
            NextResponse: class extends Response {
              constructor(body: BodyInit | null, init?: ResponseInit) {
                super(body, init);
              }
              static json(body: unknown, init?: ResponseInit) {
                return new Response(JSON.stringify(body), {
                  ...init,
                  headers: { ...(init?.headers ?? {}), "Content-Type": "application/json" },
                });
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
    Response,
    console,
    Date,
    JSON,
    Buffer,
    Math,
    Uint8Array,
  });
  vm.runInContext(jsSource, context);
  return {
    GET: (moduleObj.exports as { GET: (req: Request, ctx: unknown) => Promise<Response> }).GET,
    db,
  };
}

function ctxFor(templateId = "tpl-vn", versionId = "v-11") {
  return { params: Promise.resolve({ id: templateId, versionId }) };
}

/** Raw, pre-fix filename value — the one that crashed Production with Unicode. */
const OLD_RAW_UNICODE_HEADER = `attachment; filename="Đăng-ký-tập-nghề-v${VERSION_NUMBER}-ai-package.zip"`;

/** The exact header the fixed route is expected to emit. */
const FIXED_HEADER = `attachment; filename="Dang-ky-tap-nghe-v${VERSION_NUMBER}-ai-package.zip"; filename*=UTF-8''${encodeURIComponent(
  `Đăng-ký-tập-nghề-v${VERSION_NUMBER}-ai-package.zip`,
)}`;

/**
 * Write a header through REAL Node HTTP. `res.setHeader` throws ERR_INVALID_CHAR
 * synchronously for a value containing chars outside Latin-1 (exactly what the
 * raw Vietnamese `filename=` used to do). Resolves if the header is writable,
 * rejects on the Node error. `closeAllConnections` is required so the keep-alive
 * client socket does not prevent `server.close()` from completing.
 */
function writeHeaderThroughNodeHttp(headerValue: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      let error: unknown = null;
      try {
        res.setHeader("Content-Disposition", headerValue);
      } catch (err) {
        error = err;
      }
      res.end();
      setImmediate(() => {
        server.closeAllConnections?.();
        server.close(() => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      http.get({ host: "127.0.0.1", port: (server.address() as { port: number }).port }, (res) => res.resume()).on("error", () => {});
    });
  });
}

async function unzipEntries(buf: Buffer): Promise<Map<string, string>> {
  const zlib = await import("node:zlib");
  return new Promise((resolve, reject) => {
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

// 1 — the OLD raw-Unicode header is genuinely invalid for real Web Response + Node HTTP.
test("ai-export production regression: old raw-Unicode filename is invalid in a real Response", () => {
  assert.throws(
    () => new Response(null, { headers: { "Content-Disposition": OLD_RAW_UNICODE_HEADER } }),
    /ByteString/i,
    "raw Vietnamese in filename= must fail real Web Response construction",
  );
});

test("ai-export production regression: old raw-Unicode filename is rejected by Node HTTP", async () => {
  await assert.rejects(() => writeHeaderThroughNodeHttp(OLD_RAW_UNICODE_HEADER), /ERR_INVALID_CHAR/);
});

// 2-10 — the FIXED route returns a real Response whose header passes real validation.
test("ai-export production regression: route returns 200 with a real Response and valid Content-Disposition", async () => {
  const { GET, db } = makeContext();
  const res = await GET(new Request("http://localhost/x"), ctxFor());

  // 2 — the returned object is a real Web Response and was constructed without throwing.
  assert.ok(res instanceof Response, "route must produce a real Response object");
  assert.equal(typeof res.arrayBuffer, "function");

  // 4 — HTTP 200
  assert.equal(res.status, 200);

  // 5 — Content-Type is ZIP
  assert.equal(res.headers.get("content-type"), "application/zip");

  // 6 — Content-Disposition carries both an ASCII-safe filename= and UTF-8 filename*=
  const cd = res.headers.get("content-disposition") ?? "";
  assert.equal(cd, FIXED_HEADER, "fixed Content-Disposition must match expected ASCII + RFC 5987 form");
  const filenameParam = /filename="([^"]*)"/.exec(cd)?.[1] ?? "";
  assert.match(filenameParam, /^[ -~]*$/, "filename= must be pure printable ASCII (no raw unicode)");
  assert.match(cd, /; filename\*=UTF-8''/, "must include RFC 5987 filename*=UTF-8''");
  assert.ok(cd.includes(encodeURIComponent(`Đăng-ký-tập-nghề-v${VERSION_NUMBER}-ai-package.zip`)), "filename*= must preserve the Vietnamese name");

  // 3 — the same fixed header can be written through real Node HTTP without ERR_INVALID_CHAR
  await assert.doesNotReject(() => writeHeaderThroughNodeHttp(cd), "fixed header must not fail Node http.writeHead");

  // 7 — ZIP is non-empty
  const zipBuffer = Buffer.from(new Uint8Array(await res.arrayBuffer()));
  assert.ok(zipBuffer.byteLength > 0, "ZIP must not be empty");

  // 8 — ZIP contains the 4 expected files
  const entries = await unzipEntries(zipBuffer);
  assert.deepEqual([...entries.keys()].sort(), ["README-AI.md", "print.css", "template-manifest.json", "template.html"]);
  const manifest = JSON.parse(entries.get("template-manifest.json")!);
  assert.equal(manifest.templateName, VIETNAMESE_TEMPLATE_NAME, "manifest must preserve the Vietnamese template name");

  // 9 — zero DB writes (SELECT only)
  assert.equal(db.calls.filter((c) => c.root !== "select").length, 0, "ZERO non-select DB calls");
  assert.equal(db.calls.some((c) => c.root === "insert" || c.root === "update" || c.root === "delete"), false);

  // 10 — no candidate PII in the package
  const combined = [...entries.values()].join("\n");
  assert.doesNotMatch(combined, /\b\d{12}\b/, "no CCCD-shaped value");
  assert.doesNotMatch(combined, /\b0\d{9}\b/, "no phone-shaped value");
});

void yazl; // keep import graph explicit (used indirectly via aiTemplateExport)
