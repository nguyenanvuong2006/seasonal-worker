/**
 * Builds docs/user-guide/handbook.html — a single-file, print-ready version of the
 * whole user guide (cover, table of contents, every chapter, images resolved via
 * relative paths to docs/user-guide/images/).
 *
 * One-time setup (not part of the app's own dependencies — nothing here touches
 * package.json/package-lock.json):
 *   npm install --no-save marked
 *
 * Run after editing any docs/user-guide/*.md file:
 *   node scripts/build-user-guide.mjs
 *
 * To regenerate the flow diagrams (docs/user-guide/images/diagrams/*.png) after
 * editing a ```mermaid fence in the source .md files, see
 * scripts/render-user-guide-diagrams.mjs (needs its own one-time
 * `npm install --no-save mermaid playwright-core`).
 */
import { marked } from "marked";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "user-guide");

const ORDER = [
  "README.md",
  "00-quick-start.md",
  "01-gioi-thieu.md",
  "02-dang-nhap-giao-dien.md",
  "03-task-center.md",
  "04-daily-application.md",
  "05-dw-data-worker-profile.md",
  "06-department.md",
  "07-planning.md",
  "08-workforce-movement.md",
  "09-admin-modules.md",
  "10-permissions-data-scope.md",
  "11-import-export.md",
  "12-backup.md",
  "13-public-lookup.md",
  "14-mobile-guide.md",
  "15-best-practices.md",
  "16-common-mistakes.md",
  "17-troubleshooting.md",
  "18-faq.md",
  "19-glossary.md",
  "20-sop.md",
  "21-do-dont.md",
  "22-checklists.md",
  "23-appendix.md",
  "role-hr.md",
  "role-manager.md",
  "role-admin.md",
  "CHANGELOG.md",
];

const MERMAID_MAP = {
  "01-gioi-thieu.md": ["diagrams/flow-overview.png"],
  "08-workforce-movement.md": ["diagrams/flow-resignation.png", "diagrams/flow-transfer.png"],
  "10-permissions-data-scope.md": ["diagrams/flow-permissions.png"],
};

function slugFor(file) {
  return file.replace(/\.md$/, "");
}

marked.setOptions({ gfm: true, breaks: false });

function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

let currentFileSlug = "";
const renderer = new marked.Renderer();
renderer.heading = ({ tokens, depth }) => {
  const text = tokens.map((t) => t.raw ?? t.text ?? "").join("");
  const plain = text.replace(/<[^>]+>/g, "");
  const id = `${currentFileSlug}-${githubSlug(plain)}`;
  const inner = marked.Parser.parseInline(tokens);
  return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
};
marked.use({ renderer });

function preprocess(raw, file) {
  // Strip the "[← Mục lục](./README.md)" back-link line — not needed in a single-page doc.
  let src = raw.replace(/^\[← Mục lục\]\(\.\/README\.md\)\n+/m, "");
  // Strip trailing "Tiếp theo: ..." navigation line — replaced by the single-page flow.
  src = src.replace(/\n+Tiếp theo:.*$/m, "\n");

  // Swap ```mermaid fences for pre-rendered images, in source order.
  const imgs = MERMAID_MAP[file] || [];
  let i = 0;
  src = src.replace(/```mermaid[\s\S]*?```/g, () => {
    const img = imgs[i++];
    if (!img) return "";
    return `<img src="${img}" class="diagram" alt="Sơ đồ minh hoạ">`;
  });

  // Convert internal cross-references "./NN-xxx.md" and "./role-x.md" / "#anchor" to in-page anchors.
  src = src.replace(/\]\(\.\/([a-zA-Z0-9-]+)\.md(#[a-zA-Z0-9-]+)?\)/g, (_m, slug, anchor) => `](#${slug}${anchor ? anchor.replace("#", "-") : ""})`);

  return src;
}

let body = "";
let tocItems = "";

for (const file of ORDER) {
  const full = path.join(DOCS, file);
  if (!fs.existsSync(full)) {
    console.error("MISSING:", file);
    continue;
  }
  const raw = fs.readFileSync(full, "utf-8");
  const src = preprocess(raw, file);
  const slug = slugFor(file);
  currentFileSlug = slug;
  const html = marked.parse(src);

  const titleMatch = raw.match(/^#\s+(.+)$/m) || raw.match(/^<h1[^>]*>(.+?)<\/h1>/m);
  let title = file;
  if (file === "README.md") title = "Trang bìa & Mục lục";
  else if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, "");

  tocItems += `<li><a href="#${slug}">${title}</a></li>\n`;
  body += `<section class="doc-page" id="${slug}">\n${html}\n</section>\n`;
}

const css = `
:root {
  --bg: #f7f8f5; --surface: #ffffff; --border: #e3e7e0; --border-strong: #cdd4c8;
  --fg: #16231a; --fg-secondary: #576358; --fg-muted: #8b968a;
  --primary: #115830; --primary-hover: #0d4626; --primary-tint: #eaf3ec;
  --accent: #b8841c; --accent-tint: #fbf3e1;
  --success: #059669; --success-tint: #e7f6ef;
  --warning: #b45309; --warning-tint: #fdf3e1;
  --danger: #b91c1c; --danger-tint: #fbeaea;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.65; font-size: 15.5px;
}
.cover {
  min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; padding: 60px 24px;
  background: linear-gradient(135deg, #071a0e 0%, #0f4a26 28%, #115830 58%, #1a6d3a 100%);
  color: #fff;
  page-break-after: always;
}
.cover .eyebrow { font-size: 12px; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; color: #f4dc9c; margin-bottom: 18px; }
.cover h1 { font-size: 56px; font-weight: 900; letter-spacing: -0.02em; margin: 0 0 14px; color: #ffffff; }
.cover .sub { font-size: 19px; font-weight: 600; max-width: 640px; color: rgba(255,255,255,.9); margin-bottom: 6px; }
.cover .sub2 { font-size: 14px; color: rgba(255,255,255,.65); max-width: 560px; }
.cover .meta { margin-top: 48px; font-size: 12px; text-transform: uppercase; letter-spacing: .15em; color: rgba(255,255,255,.55); }
.toc-page { max-width: 860px; margin: 0 auto; padding: 60px 32px; page-break-after: always; }
.toc-page h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .12em; color: var(--primary); margin: 28px 0 10px; }
.toc-page ol, .toc-page ul { list-style: none; padding: 0; margin: 0 0 8px; columns: 1; }
.toc-page li { padding: 5px 0; border-bottom: 1px dashed var(--border); font-size: 14.5px; }
.toc-page a { color: var(--fg); text-decoration: none; }
.toc-page a:hover { color: var(--primary); }
.doc-page { max-width: 860px; margin: 0 auto; padding: 48px 32px; border-top: 1px solid var(--border); page-break-before: always; }
.doc-page:first-of-type { border-top: none; }
h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.01em; color: var(--fg); margin: 0 0 6px; }
h2 { font-size: 20px; font-weight: 800; color: var(--primary); margin: 34px 0 10px; padding-top: 8px; }
h3 { font-size: 16px; font-weight: 700; color: var(--fg); margin: 24px 0 8px; }
p { margin: 0 0 12px; color: var(--fg-secondary); }
a { color: var(--primary); }
strong { color: var(--fg); }
ul, ol { margin: 0 0 14px; padding-left: 22px; color: var(--fg-secondary); }
li { margin-bottom: 4px; }
li > p { margin-bottom: 4px; }
table { border-collapse: collapse; width: 100%; margin: 14px 0 20px; font-size: 13.8px; }
th, td { border: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; }
th { background: var(--primary); color: #fff; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
tr:nth-child(even) td { background: var(--primary-tint); }
code { background: var(--border); padding: 1px 6px; border-radius: 4px; font-size: 13px; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
blockquote { margin: 16px 0; padding: 12px 16px; border-left: 3px solid var(--accent); background: var(--accent-tint); border-radius: 0 8px 8px 0; }
blockquote p { margin: 0; color: var(--fg); font-size: 14px; }
blockquote p strong:first-child { color: var(--accent); }
img { max-width: 100%; border-radius: 10px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(8,50,27,.08); margin: 10px 0 18px; display: block; }
img.diagram { border: none; box-shadow: none; background: #fff; padding: 8px; }
hr { border: none; border-top: 1px solid var(--border); margin: 28px 0; }
table + p, p + table { margin-top: 4px; }
.doc-page table img { max-width: 340px; }
@media print {
  body { background: #fff; }
  .cover, .doc-page { page-break-inside: avoid; }
  a { color: var(--fg); text-decoration: none; }
}
`;

const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Seasonal Worker — Hướng dẫn sử dụng</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
</head>
<body>

<div class="cover">
  <div class="eyebrow">Dalat Hasfarm</div>
  <h1>SEASONAL WORKER</h1>
  <p class="sub">Hướng dẫn sử dụng hệ thống quản lý lao động thời vụ</p>
  <p class="sub2">Dành cho HR Tuyển dụng, Quản lý bộ phận và Quản trị hệ thống</p>
  <div class="meta">Phiên bản tài liệu 1.0 &nbsp;·&nbsp; Cập nhật 12/08/2026</div>
</div>

<div class="toc-page">
  <h1 style="border:none;">Mục lục</h1>
  <ol>
    ${tocItems}
  </ol>
</div>

${body}

</body>
</html>`;

fs.writeFileSync(path.join(DOCS, "handbook.html"), html, "utf-8");
console.log("Built handbook.html —", (html.length / 1024).toFixed(0), "KB (HTML text; images loaded separately from /images)");
