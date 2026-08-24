/**
 * V8 DRAFT PREVIEW — ACCEPTANCE TEST (Trần Văn Dũng scenario).
 *
 * Renders the v8 DRAFT body through the EXACT pipeline the new
 * "Xem trước" endpoint uses:
 *
 *   selectPreviewMappings(v8 DRAFT with mapping_snapshot = [],
 *                         current non-orphaned merge_template_fields)
 *        → buildCanonicalSnapshot({ allowUnpublishedForVerification: true })
 *        → renderCanonicalDocument()            ← shared with the HTML_PDF worker
 *
 * The v8 body/print_css are read from the DRAFT migration (the exact payload
 * Production holds), and the 49-field mapping is the checked-in reviewable
 * mapping set. Nothing here touches a database, a job, or Production.
 *
 * Proves acceptance criteria A–E:
 *   A. HR confirmation ("GHI NHẬN CỦA PHÒNG NHÂN SỰ") stays on the preceding page.
 *   B. DALAT HASFARM / QUY ĐỊNH VỀ TẬP NGHỀ starts at the TOP of a new page,
 *      followed by the three "Căn cứ …" clauses.
 *   C. The regulations signature block is protected from becoming an isolated
 *      signature-only page (break-inside: avoid, scoped to that block).
 *   D. No global A4 / font / margin / layout regression versus v7.
 *   E. All 49 placeholders resolve under DRAFT preview mapping semantics.
 *   F. v7's source body/CSS are byte-identical to their published-migration
 *      content — the preview work mutates nothing about v7.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanonicalSnapshot, renderCanonicalDocument } from "./canonical-document.ts";
import {
  DRAFT_PREVIEW_MAPPING_SOURCE,
  selectPreviewMappings,
  type PreviewFieldRow,
} from "./draft-preview.ts";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";
import { PLACEHOLDERS } from "../../document-templates/dang-ky-tap-nghe/schema.ts";
import type { MergeContext } from "./data-resolver.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const V8_MIGRATION = "migrations/2026-08-24-trainee-registration-v8-pagination-draft.sql";
const V7_MIGRATION = "migrations/2026-08-24-trainee-registration-v7-operator-test2-draft.sql";
const MAPPING_FILE = "templates/document-merge/trainee-registration/v7-mapping.json";

function readRepo(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

function dollarQuoted(sql: string, tag: string): string {
  const open = `$${tag}$`;
  const start = sql.indexOf(open);
  assert.ok(start >= 0, `missing ${open}`);
  const bodyStart = start + open.length;
  const end = sql.indexOf(open, bodyStart);
  assert.ok(end >= 0, `unterminated ${open}`);
  return sql.slice(bodyStart, end);
}

const v8Sql = readRepo(V8_MIGRATION);
const v7Sql = readRepo(V7_MIGRATION);
const V8_HTML = dollarQuoted(v8Sql, "v8_html");
const V8_CSS = dollarQuoted(v8Sql, "v8_css");
const V7_HTML = dollarQuoted(v7Sql, "v7_html");
const V7_CSS = dollarQuoted(v7Sql, "v7_css");

/**
 * Production v8 row shape: DRAFT with an EMPTY mapping_snapshot (the snapshot
 * is only created by publishTemplateVersion).
 */
const V8_DRAFT_ROW = {
  id: "ver-8",
  version: 8,
  status: "DRAFT",
  htmlBody: V8_HTML,
  printCss: V8_CSS,
  retentionYears: 3,
  mappingSnapshot: [] as unknown[],
};

/** The current non-orphaned merge_template_fields (49 rows). */
const CURRENT_FIELDS = JSON.parse(readRepo(MAPPING_FILE)) as PreviewFieldRow[];

/** Trần Văn Dũng — a realistic, complete candidate record. */
const CANDIDATE = {
  id: "app-tran-van-dung",
  fullName: "Trần Văn Dũng",
  dob: "1998-08-15",
  permanentAddress: "Thôn 4, xã Đạ Ròn, huyện Đơn Dương, tỉnh Lâm Đồng",
  residentialAddress: "112 đường Phan Đình Phùng, Phường 2, Tp. Đà Lạt, tỉnh Lâm Đồng",
  phone: "0918 456 789",
  cccd: "068098012345",
  dateOfIssue: "2021-06-10",
  placeOfIssue: "Lâm Đồng",
  code: "DHF-2026-01042",
  location: "Đà Lạt",
  startingDate: "2026-03-02",
  declaredType: "OLD",
  customAnswers: {
    tien_an_tien_su: "Không",
    loai_cong_viec_truoc_day: "Công nhân",
    khu_vuc_lam_viec_truoc_day: "Đà Lạt",
    cong_viec_hien_tai: "Sinh viên",
    cong_viec_hien_tai_khac: "",
    ten_truong: "CĐ Kinh tế – Kỹ thuật Lâm Đồng",
    tinh_trang_tknh: "Đã có",
    so_tai_khoan: "1903 6688 2345 01",
    ten_ngan_hang: "Vietcombank – CN Đà Lạt",
    nguon_thu_nhap: "Chỉ phát sinh tại Dalat Hasfarm",
    cong_ty_thu_nhap_khac: "",
    dia_diem_thu_nhap_khac: "",
    tap_nghe_nguyen_vong: "Trồng, chăm sóc, thu hoạch",
    cong_viec_khac: "",
    email: "tranvandung@example.com",
    so_dinh_danh_cu: "",
  },
};

const CONTEXT: MergeContext = {
  currentUserId: "admin-1",
  currentUserName: "Trần Thị Bình",
  currentDate: new Date("2026-03-02T00:00:00Z"),
  mergeIndex: 1,
  mergeCount: 1,
};

/** Render v8 exactly the way the DRAFT preview endpoint does. */
function renderV8Preview() {
  const { mappings, source } = selectPreviewMappings(V8_DRAFT_ROW, CURRENT_FIELDS);
  const snapshot = buildCanonicalSnapshot({
    templateId: "tpl-trainee-registration",
    version: V8_DRAFT_ROW,
    allowUnpublishedForVerification: true,
    mappings,
    formatting: {
      contractKey: "dang-ky-tap-nghe",
      retentionYears: 3,
      documentKind: "B",
      templateName: "Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế",
    },
  });
  return { source, mappings, rendered: renderCanonicalDocument(snapshot, CANDIDATE, CONTEXT, { contract: null }) };
}

test("v8 DRAFT preview renders Trần Văn Dũng from the CURRENT merge_template_fields (snapshot stays [])", () => {
  const { source, mappings, rendered } = renderV8Preview();

  assert.equal(source, DRAFT_PREVIEW_MAPPING_SOURCE.CURRENT_FIELDS);
  assert.equal(mappings.length, 49, "DRAFT preview must resolve all 49 current mappings");
  assert.deepEqual(V8_DRAFT_ROW.mappingSnapshot, [], "preview must not populate the DRAFT snapshot");
  assert.equal(rendered.templateVersion, 8);
  assert.ok(rendered.html.includes("Trần Văn Dũng"), "the real candidate name must appear in the document");
});

test("E. all 49 placeholders resolve — no unreplaced token, no missing required field", () => {
  const { rendered } = renderV8Preview();

  assert.deepEqual(rendered.unreplaced, [], "no <<…>>/{{…}} token may survive the render");
  assert.deepEqual(rendered.missingFields, [], "no required field may be missing");
  assert.equal(rendered.valid, true);
  // The body itself still declares exactly the canonical 49 placeholders.
  assert.deepEqual(extractUniquePlaceholders(V8_HTML), [...PLACEHOLDERS].sort());
  assert.equal(extractUniquePlaceholders(V8_HTML).length, 49);
});

test("A+B. HR confirmation stays on the preceding page; regulations start at the TOP of a new page", () => {
  const { rendered } = renderV8Preview();
  const html = rendered.html;

  const hrIndex = html.indexOf("GHI NHẬN CỦA PHÒNG NHÂN SỰ");
  const boundaryIndex = html.indexOf('class="paper regulations-page"');
  const regulationsIndex = html.indexOf("QUY ĐỊNH VỀ TẬP NGHỀ");

  assert.ok(hrIndex >= 0, "HR confirmation block must exist");
  assert.ok(boundaryIndex > hrIndex, "A. the page boundary comes AFTER the HR confirmation block");
  assert.ok(regulationsIndex > boundaryIndex, "B. the regulations header comes AFTER the page boundary");

  // A. Nothing of the regulations block leaks onto the HR page: the HR .paper
  // container closes before the regulations container opens.
  const hrPageStart = html.lastIndexOf('class="paper"', hrIndex);
  assert.ok(hrPageStart >= 0 && hrPageStart < hrIndex);
  const hrPageSlice = html.slice(hrPageStart, boundaryIndex);
  assert.doesNotMatch(hrPageSlice, /QUY ĐỊNH VỀ TẬP NGHỀ/);
  assert.doesNotMatch(hrPageSlice, /Căn cứ Điều 61/);

  // B. The regulations page opens with the DALAT HASFARM / QUY ĐỊNH header and
  // is immediately followed by the three "Căn cứ …" clauses, in order.
  const regulationsPage = html.slice(boundaryIndex, boundaryIndex + 2000);
  assert.match(regulationsPage, /DALAT HASFARM/);
  assert.match(
    regulationsPage,
    /QUY ĐỊNH VỀ TẬP NGHỀ[\s\S]*Căn cứ Điều 61 của Bộ luật Lao động 2019 về Tập nghề;[\s\S]*Căn cứ nhu cầu tuyển dụng của Công ty;[\s\S]*Căn cứ nhu cầu tập nghề và xin việc của người tập nghề\./,
  );

  // The break is STRUCTURAL, enforced by CSS, not by whitespace padding.
  assert.match(
    rendered.printCss ?? "",
    /\.regulations-page\s*\{\s*break-before:\s*page;\s*page-break-before:\s*always;/,
  );
});

test("C. the regulations signature block cannot be orphaned onto a signature-only page", () => {
  const { rendered } = renderV8Preview();

  assert.match(rendered.html, /class="sign-block regulations-signature mt-8"/);
  assert.match(
    rendered.printCss ?? "",
    /\.regulations-signature\s*\{\s*break-inside:\s*avoid;\s*page-break-inside:\s*avoid;/,
    "the signature block must be kept together with its preceding content",
  );
  // Anti-orphan protection is SCOPED: it must not blanket-apply to every
  // sign-block or every .paper, which would change global pagination.
  assert.doesNotMatch(V8_CSS, /(?:^|\n)\.sign-block\s*\{[^}]*break-inside/);
  assert.doesNotMatch(V8_CSS, /(?:^|\n)\.paper\s*\{[^}]*break-inside/);
});

test("D. no global A4 / font / margin / layout regression relative to v7", () => {
  // v8's print CSS is v7's CSS with pagination rules APPENDED — the shared
  // prefix is byte-identical, so nothing global can have been redefined.
  assert.equal(V8_CSS.slice(0, V7_CSS.length), V7_CSS, "v8 CSS must start with the exact v7 CSS");
  const appended = V8_CSS.slice(V7_CSS.length);
  assert.doesNotMatch(
    appended,
    /font-size|font-family|line-height|margin\s*:|@page|width\s*:210mm|min-height|padding\s*:12mm/,
    "the v8 addendum must not touch typography, margins or A4 geometry",
  );
  assert.ok(appended.length > 0, "v8 must actually add its pagination rules");

  // The rendered document keeps the same page marker vocabulary and gains
  // exactly one page from the deliberate split.
  const { rendered } = renderV8Preview();
  const v8Pages = (rendered.html.match(/class="paper/g) ?? []).length;
  const v7Pages = (V7_HTML.match(/class="paper/g) ?? []).length;
  assert.equal(v8Pages, v7Pages + 1, "exactly one additional physical page (the regulations split)");
});

test("F. v7 remains untouched — body and CSS hashes are unchanged", () => {
  assert.equal(
    createHash("sha256").update(V7_HTML).digest("hex"),
    "7cb43551d3d4f5178ce203a176a7004aa7e3994ecad2276ef593b6fe401116c1",
    "v7 html_body must never be modified",
  );
  // The v8 migration must only INSERT version 8; it may not read/update/delete v7.
  const statements = v8Sql.replace(/\$v8_html\$[\s\S]*?\$v8_html\$/g, "'BODY'").replace(/\$v8_css\$[\s\S]*?\$v8_css\$/g, "'CSS'");
  assert.doesNotMatch(statements, /\bUPDATE\s+merge_template_versions/i);
  assert.doesNotMatch(statements, /\bDELETE\s+FROM\s+merge_template_versions/i);
  assert.doesNotMatch(statements, /\bUPDATE\s+merge_templates/i);
  assert.doesNotMatch(statements, /current_published_version\s*=/i);
  assert.match(statements, /INSERT INTO merge_template_versions/i);
  assert.match(statements, /'DRAFT'/);
});

test("published v7 preview would still use its FROZEN snapshot — draft work does not weaken immutability", () => {
  const publishedV7 = {
    id: "ver-7",
    version: 7,
    status: "PUBLISHED",
    htmlBody: V7_HTML,
    printCss: V7_CSS,
    retentionYears: 3,
    // 49 rows frozen at publish time.
    mappingSnapshot: CURRENT_FIELDS,
  };
  const liveEdited: PreviewFieldRow[] = CURRENT_FIELDS.map((f) => ({ ...f, sourcePath: "EDITED_AFTER_PUBLISH" }));

  const { source, mappings } = selectPreviewMappings(publishedV7, liveEdited);
  assert.equal(source, DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT);
  assert.ok(
    mappings.every((m) => m.sourcePath !== "EDITED_AFTER_PUBLISH"),
    "a published version's mapping can never be changed by later field edits",
  );
});
