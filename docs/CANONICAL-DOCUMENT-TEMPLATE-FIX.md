# Canonical Document Template Fix — legacy runtime HTML eliminated

Status: **ready for review — not merged, not deployed.**

No Production change, no Production DB change, no Cloud Run deploy, no merge
batch was run.

---

## Phase 0 — recovered state

| Item | Result |
| --- | --- |
| PR #90 | **MERGED** into `main` at `8349df2` (`Fix HTML_PDF stuck queue: mapping requiredness + terminal INCOMPLETE`). Its worker incident fix is on main. |
| Commit `5098213` | **NOT recoverable** — not on `origin`, not fetchable (`upload-pack: not our ref`), and the local clone is shallow (1 commit). Its parity behaviour was **recreated from scratch**, which was required anyway because the previous approach achieved parity against the *wrong* document. |

---

## Phase 1 — which document is actually correct

Structural comparison of every candidate body:

| Source | Bytes | `.page` | Placeholders | Sections |
| --- | --- | --- | --- | --- |
| `templates/.../test.html` (now `canonical-source.html`) | 48 082 | **6** | 49 | Đăng ký · Ghi nhận NS · Quy định · Cam kết · Ủy quyền · Tờ khai (05‑ĐKT) |
| `canonical-template.generated.ts` (deleted) | 31 713 | 6 | 49 | same six |
| `migrations/2026-08-21-...sql` (**obsolete seed**) | 9 489 | **5** | 51 | missing “Ghi nhận của Phòng Nhân sự”; keeps 2 orphan tax-contract tokens |
| `migrations/2026-08-23-...sql` | 32 821 | 6 | 49 | same six |
| `docs/visual-verification/...sample.html` (deleted) | 8 862 | 5 | 0 | obsolete 5-page shape |

The obsolete 5-page body is ~5× smaller, is missing a whole legal section, and
still references two placeholders (`So_hop_dong_dich_vu_thue`,
`Ngay_hop_dong_dich_vu_thue`) the operator already accepted as orphans. That is
the body that produced the wrong Production PDF.

**Roles determined:**

```
GOOGLE_DOC_CURRENT_ROLE   = authoring source of truth (business-approved), migration input only — never a runtime body
TEST_HTML_ROLE            = checked-in canonical authoring source, faithful to the Google Doc (6 pages / 49 placeholders)
GENERATED_TEMPLATE_ROLE   = obsolete runtime static-HTML fallback  → DELETED
PUBLISHED_HTML_ROLE       = (before) whatever happened to be PUBLISHED, incl. the obsolete 5-page seed
STATIC_CATALOG_ROLE       = (after) metadata only — placeholders, validation, labels, formats. No body.

CORRECT_CANONICAL_DOCUMENT_SOURCE
  = templates/document-merge/trainee-registration/canonical-source.html
    → migrations/2026-08-23-...sql (DRAFT)
    → explicit operator Publish
    → merge_template_versions (PUBLISHED)   ← the ONLY runtime body
```

---

## Phase 2 — inventory (classification)

| Occurrence | Class | Action |
| --- | --- | --- |
| `templates/.../test.html` | A canonical body (authoring) | renamed `canonical-source.html`, kept |
| `migrations/2026-08-23-...sql` | A canonical body (DB DRAFT) | regenerated, kept |
| `src/document-templates/.../canonical-template.generated.ts` | **E obsolete runtime body** | **deleted** |
| `src/document-templates/.../template.ts` | **E obsolete runtime body** | **deleted** |
| `migrations/2026-08-21-...sql` (5-page seed) | **E obsolete runtime body** | **body removed → tombstone** |
| `docs/visual-verification/...sample.html` | **E obsolete runtime body** | **deleted** |
| `html-renderer.ts` `HtmlTemplate` + `renderApplicantHtml()` | **F dead static-render path** | **deleted** |
| `html-pipeline.ts` `renderApplicantDocument()` | **F dead static-render path** | **deleted** |
| `src/document-templates/.../schema.ts` | B schema/metadata | kept (metadata only) |
| `registry.ts` | B metadata (was body-capable) | rewritten metadata-only |
| `*.test.ts`, `canonical-fixture.ts` | C test fixture | kept |
| historical DB rows | D history | **preserved, never deleted** |

---

## Phases 3–5 — one document definition

```
merge_template_versions (explicitly PUBLISHED)
   ↓ buildCanonicalSnapshot()        ← fails closed, no substitution
immutable job snapshot
   { templateId, templateVersion, htmlBody, printCss, mappings, formatting }
   ↓ resolve values
renderCanonicalDocument()            ← src/lib/document-merge/canonical-document.ts
   ├── Preview  (app/api/document-merge/preview)
   └── Worker   (worker/src/index.ts, Cloud Run HTML_PDF)
```

Preview and the worker call the **same function** on the **same snapshot**, so
their HTML/CSS are byte-identical. The worker parses the frozen snapshot and
never re-reads `merge_template_versions` while rendering.

## Phase 4 — fail closed

No published canonical version → `CANONICAL_TEMPLATE_NOT_PUBLISHED` (HTTP 422),
with a safe Vietnamese operator message. Explicitly **no** fallback to Google
Docs, static TypeScript HTML, generated legacy HTML, or an older/archived
version. Both canonical error codes are registered **non-retryable**, so a
misconfiguration fails immediately instead of spinning the queue.

## Phase 6 — migration mechanism

Audit result: no Google Doc → canonical HTML sync existed (only DOCX import and
a build-time generator that emitted a runtime module).

Added `POST /api/document-merge/templates/[id]/sync-google-doc` —
**“Đồng bộ Google Doc → phiên bản HTML mới”**: reads the Doc as structured HTML,
preserves structure/styles/placeholders, creates a **new DRAFT**, never
auto-publishes, never overwrites history. If the export cannot faithfully
represent the approved document (e.g. `text/plain`), it **STOPS** with
`GOOGLE_DOC_EXPORT_NOT_STRUCTURED` and reports the limitation rather than
storing an approximation.

## Phase 7 — version verification before publish

`Sync → Draft → Preview Draft → Verify → Publish → jobs snapshot that version.`
Preview now reports and the UI displays **Template / Version / Status / Engine**
(plus page count), and warns clearly when a draft — not the published canonical
version — is being viewed.

## Phase 10 — page count is never hard-coded

Page count is derived from the selected canonical body everywhere (renderer,
tests, sync, manifest). A regression test asserts no source file compares a page
count to a literal, and parity is verified for bodies of 1, 3, 5, 7 and 11 pages.

---

## Verification

`993` app tests + `8` worker tests pass (2 skipped: Chromium absent locally).

Key new suites: `canonical-document.test.ts` (21), `canonical-sync.test.ts`,
`canonical-retry.test.ts`, `worker/src/canonical-parity.test.ts`.

The sentinel `LEGACY_TEMPLATE_MUST_NEVER_RENDER` exists **only** in the test
fixture; a test asserts it never appears in runtime code, seeds or migrations,
and that neither Preview nor the worker can render it when the canonical
published version is selected.
