#!/usr/bin/env node
/**
 * V7 VISUAL RENDER (read-only, offline).
 *
 * Renders candidate "Trần Văn Dũng" through the REAL production pipeline
 * (renderCanonicalDocument) using the v7 DRAFT body/printCss extracted from the
 * v7 migration and the v7 mapping_snapshot (the current approved 49-field
 * mapping). Writes:
 *   artifacts/v7-visual/tran-van-dung.v7.html
 *
 * Also writes the operator REFERENCE rendered from incoming/test2.html's own
 * build() (SAMPLE data) so a side-by-side visual check is possible:
 *   artifacts/v7-visual/reference-test2.html
 *
 * No DB, no jobs, no network, no candidate rows.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderCanonicalDocument } from "../src/lib/document-merge/canonical-document.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "artifacts", "v7-visual");
mkdirSync(OUT, { recursive: true });

const sql = readFileSync(join(ROOT, "migrations/2026-08-24-trainee-registration-v7-operator-test2-draft.sql"), "utf8");
function dollar(tag) {
  const open = `$${tag}$`;
  const s = sql.indexOf(open);
  const b = s + open.length;
  const e = sql.indexOf(open, b);
  return sql.slice(b, e);
}
const htmlBody = dollar("v7_html");
const printCss = dollar("v7_css");

// mapping_snapshot is embedded as a JSON literal
const mapMatch = sql.match(/'\s*(\[[\s\S]*?\])\s*'::jsonb/);
if (!mapMatch) throw new Error("mapping_snapshot not found in v7 migration");
const mappings = JSON.parse(mapMatch[1]);

// Candidate: Trần Văn Dũng — realistic, complete (all required fields present).
const CONTEXT = { currentUserName: "Trần Thị Bình", currentDate: new Date("2026-03-02T00:00:00Z"), mergeIndex: 1, mergeCount: 1 };
const record = {
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
  declaredType: "OLD", // đã từng làm DHF
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
    email: "tranvandung@gmail.com",
    so_dinh_danh_cu: "",
  },
};

const snapshot = {
  templateId: "tpl-canonical",
  templateVersion: 7,
  htmlBody,
  printCss,
  mappings,
  formatting: {
    contractKey: "dang-ky-tap-nghe",
    retentionYears: 3,
    documentKind: "B",
    templateName: "Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế",
  },
};

const rendered = renderCanonicalDocument(snapshot, record, CONTEXT, { contract: null });
writeFileSync(join(OUT, "tran-van-dung.v7.html"), rendered.html, "utf8");
console.log("valid:", rendered.valid);
console.log("missingFields:", rendered.missingFields);
console.log("unreplaced:", rendered.unreplaced);
console.log("pages (.paper in output):", (rendered.html.match(/class="paper"/g) || []).length);
console.log("pages (.page in output):", (rendered.html.match(/class="page"/g) || []).length);
console.log("wrote:", join(OUT, "tran-van-dung.v7.html"));

// ---- operator reference: incoming/test2.html rendered with its own SAMPLE ----
// We replicate the operator file's build(mode='data', highlight=false)+fullHtml,
// using its SAMPLE (Nguyễn Văn An) — this is the reference the v7 output must
// match in LAYOUT (typography, margins, 05-ĐKT box position, page breaks, etc).
const opSrc = readFileSync(join(ROOT, "incoming/test2.html"), "utf8");
const tplBlock = opSrc.match(/<script type="text\/template" id="tpl">([\s\S]*?)<\/script>/)[1];
const docCss = opSrc.match(/<style id="doccss">([\s\S]*?)<\/style>/)[1].trim();
// Extract the SAMPLE object literal (between "const SAMPLE = {" and the matching "};")
const sampleStart = opSrc.indexOf("const SAMPLE = {");
const sampleBrace = opSrc.indexOf("{", sampleStart);
let depth = 0, end = -1;
for (let i = sampleBrace; i < opSrc.length; i++) {
  if (opSrc[i] === "{") depth++;
  else if (opSrc[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
}
const SAMPLE = Function(`"use strict";const ON='☒',OFF='☐';return (${opSrc.slice(sampleBrace, end + 1)});`)();
const RX = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const refBody = tplBlock.replace(RX, (_m, k) => esc(SAMPLE[k] ?? ""));
const refHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>Giấy đăng ký tập nghề</title>
<style>${docCss}
.paper{box-shadow:none}
</style>
</head>
<body>
${refBody}
</body>
</html>`;
writeFileSync(join(OUT, "reference-test2.html"), refHtml, "utf8");
console.log("wrote:", join(OUT, "reference-test2.html"));
