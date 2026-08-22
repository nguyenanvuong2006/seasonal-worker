# Full-Document PDF Coordinate Mapping Engine — Audit & Design

> Scope: architecture audit + design only. **No production change made.**
> Branch: `arena/01a027c4-seasonal-worker` · Base: `main` @ `ffc0ba5`
> Date of audit: 2026-08-22

---

## 0. VERIFIED BASELINE (from the repo, not assumptions)

| Item | Value found in code |
|---|---|
| `DOCUMENT_MERGE_ENGINE` default | `GOOGLE_DOCS` — `src/lib/document-merge/engine-config.ts` |
| Engine flag vocabulary | `"GOOGLE_DOCS" \| "HTML_PDF"` only — 2-value union |
| HTML_PDF worker | Built + deployed to Cloud Run, **not activated** as default |
| Batch merge (async) | `merge_jobs` + `merge_job_records` as Postgres-backed durable queue (`SKIP LOCKED` claim) |
| Template ID (seeded) | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| Live golden Google Doc | `10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE` |
| 49 active placeholders | `src/document-templates/dang-ky-tap-nghe/schema.ts` |
| 2 accepted orphan placeholders | `So_hop_dong_dich_vu_thue`, `Ngay_hop_dong_dich_vu_thue` |
| `pdf-lib` dependency | `^1.17.1` (root) / `1.17.1` (worker) — already installed |
| `pdfjs-dist` + `@napi-rs/canvas` + `pixelmatch` | already in `worker/package.json` (visual verification) |
| `@pdf-lib/fontkit` | **absent** — must be added for Vietnamese font embedding |
| Vietnamese font asset | **absent** — no `.ttf/.otf/.woff*` anywhere in repo |
| Storage provider | `StorageProvider` abstraction: `local` + `google_drive` implemented; `gcs/s3/vercel-blob` stubbed |

---

## 1. PHASE 1 — AUDIT CURRENT REPO

### CURRENT_ARCHITECTURE

**Stack:** Next.js 16 (App Router, serverless on Vercel) + Neon PostgreSQL via Drizzle ORM + a
separate **Cloud Run PDF worker** (`worker/src/index.ts`, Playwright v1.49.0-noble image, plain
`node:http` server, scale-to-zero).

**Document merge pipeline (two engines share one durable queue):**

```
POST /api/document-merge/merge/execute
   └─ createAsyncMergeJob (src/lib/document-merge/async-job.ts)
       1. validate permission/records/data-scope
       2. route template A/B (selectTemplateForApplicant)
       3. snapshot merge_template_fields → metadata.templates[tid].fields
       4. snapshot PUBLISHED merge_template_versions.htmlBody/printCss → metadata
       5. insert merge_jobs (QUEUED) + merge_job_records (QUEUED, sort_order)
       6. triggerPdfWorker() via Next.js after() → POST {worker}/run
```

**Cloud Run worker loop (`worker/src/index.ts`):**
```
runJob(jobId)
   claimItems(jobId, CONCURRENCY)      // single-SQL FOR UPDATE SKIP LOCKED
   per item:
     TEMPLATE_LOADING → loadDailyApplicationRecords → DATA_RESOLUTION
     → renderApplicantDocumentFromParts (HTML) → renderPdfBytes (Chromium page.pdf)
     → SHA256 → STORAGE_UPLOAD (StorageProvider.put) → createDocumentHistory
     → completeItem
   recomputeJobProgress → when terminal: finalizeBatchOutputs (pdf-lib merge + yazl ZIP)
   finalizeJob(COMPLETED/FAILED)
```

**Engine selection:** `getDocumentMergeEngine()` reads `DOCUMENT_MERGE_ENGINE`; anything not
`HTML_PDF` collapses to `GOOGLE_DOCS`. The GOOGLE_DOCS legacy engine (`merge/execute` route) is
fully separate: it copies the live Google Doc, runs `replaceAllText`-style placeholder
replacement, exports to PDF via Drive, and is still the production default.

**Key modules (all under `src/lib/document-merge/`):**

| Concern | Module | Notes |
|---|---|---|
| Merge templates | `merge_templates` (schema.ts) | googleDocId NOT NULL, documentKind A/B/GENERIC |
| Field mappings | `merge_template_fields` | placeholder → sourceType/sourceEntity/sourceField/sourcePath/optionValue/formatType/fallback/isRequired/isOrphaned |
| Versioning | `template-versions.ts` + `merge_template_versions` | DRAFT→PUBLISHED→ARCHIVED, partial-unique "one PUBLISHED", `mapping_snapshot` |
| Jobs/queue | `queue.ts`, `queue-types.ts`, `async-job.ts` | durable claim/lease/retry/reclaim, job+item status vocab |
| Per-record items | `merge_job_records` | storageKey, sha256, filename, fileSize, documentHistoryId |
| History/audit | `document-history.ts` + `document_history` | one row per generated PDF, retention snapshot, archive lifecycle |
| Storage | `src/lib/storage/{types,index,local,google-drive}.ts` | `put/get/delete/exists/getSignedUrl/getMetadata` |
| PDF composition | `batch-pdf.ts` | `mergePdfBuffers` via pdf-lib `copyPages` |
| Batch finalize | `batch-finalize.ts` | PDF tổng + ZIP via pdf-lib + yazl |
| Field resolver | `data-resolver.ts` | `resolveAllFields` → `Record<placeholder, string>` |
| Formatters | `formatters.ts` | DATE/UPPERCASE/NUMBER/CURRENCY_VND/VIETNAMESE_NUMBER_WORDS/BOOLEAN_CHECKBOX… |
| Checkbox | `checkbox-engine.ts` | `isCheckboxMatch` (diacritic-insensitive), `☒/☐` glyph output |
| Record flattening | `applicant-record.ts` + `record-loader.ts` | `buildApplicantMergeRecord` (app+dept+dw+worker+customAnswers) |
| Auto-mapping | `auto-mapping.ts` | placeholder→field suggestion (exact/alias/fuzzy) |
| DOCX import | `docx-import.ts` | mammoth DOCX→HTML (DRAFT only) |
| HTML renderer | `html-renderer.ts`, `html-pipeline.ts` | canonical `<<…>>` fill + A4 print CSS |
| Template routing | `template-routing.ts` | A/B auto-route |
| Production readiness | `production-readiness.ts` | read-only gate; **BLOCKS if engine ≠ GOOGLE_DOCS** |
| Retention | `retention.ts` | 1/2/3/5/10/null, snapshot at generation |
| Worker trigger | `worker-trigger.ts` | `after()` + `callWorker` (WIF/OIDC) |

**Admin UI:** `/admin/document-merge` tabs (templates / merge / history / fields / verification).
The "Mapping Inspector" (`merge-workspace.tsx` + `resizable-mapping-table.tsx` + `template-library.tsx`)
maps placeholder → data source in a **table**, with drag-resize of *columns* — it is **not** a
spatial/visual mapper (no PDF canvas, no x/y).

### REUSABLE_COMPONENTS (do not rebuild)

1. **Durable queue + idempotency** (`queue.ts`): `claimItems`/`completeItem`/`failItem`/
   `reclaimStalledItems`/`recomputeJobProgress` are engine-agnostic. A PDF-overlay renderer is a
   drop-in replacement for the body of `processItem` only.
2. **Data resolver + formatters + checkbox-engine** (`data-resolver.ts`, `formatters.ts`,
   `checkbox-engine.ts`): already produce the exact formatted `Record<placeholder,string>` the
   renderer needs. `resolveCheckboxOption`/`isCheckboxMatch` give the boolean decision for marks.
3. **Record loader / applicant flattening** (`record-loader.ts`, `applicant-record.ts`): worker-ready
   (no `server-only`), reused as-is.
4. **StorageProvider** (`storage/index.ts`): `put/get/exists/getMetadata` — reuse for both the final
   per-record PDF and the template background PDF (Drive).
5. **document_history + retention**: already records templateVersion + sha256 + storageFileId +
   archive lifecycle per generated PDF — coordinate-mapped PDFs slot in unchanged.
6. **Template versioning pattern** (`merge_template_versions` + `template-versions.ts`): the
   DRAFT/PUBLISHED/ARCHIVED + "one PUBLISHED" + supersededBy + snapshot semantics are exactly what
   coordinate mappings need; copy the pattern rather than inventing a new one.
7. **pdf-lib** already in both `package.json`s; `batch-pdf.ts` shows load/copyPages/save usage.
8. **Visual verification infra** (`worker/src/verification.ts`): pdfjs-dist renders PDF→PNG,
   pixelmatch diffs — reuse for RENDER_GATE/VISUAL_GATE and as the browser rendering backbone of
   the visual mapper.
9. **Validation-gate pattern** (`template-versions.ts::validatePlaceholderCoverage`,
   `production-readiness.ts` read-only checks): reuse structure for STRUCTURAL_GATE.
10. **Filename/storage-key utilities** (`filename.ts`): unique per-application keys already prevent
    overwrite/duplication.

### MISSING_COMPONENTS (must be built)

1. **Coordinate data model** — no table stores page/x/y/width/height/font/etc. (only source mapping).
2. **PDF background loader/cloner** — `batch-pdf.ts` merges finished PDFs; nothing loads a template
   PDF and clones its pages per record.
3. **Vietnamese font asset + embedding utility** — no font file; `@pdf-lib/fontkit` absent; no
   `embedFont`/`registerFontkit` call anywhere.
4. **Text-fitting engine** — wrapping, `maxLines`, auto-shrink to `min_font_size`, overflow policy.
5. **Vector checkbox/radio/mark primitives** — nothing draws rect/line/tick onto a page.
6. **Page-specific, duplicate-position rendering** — one placeholder appearing N times on M pages.
7. **Whiteout / masking utility** — needed to cover any residual placeholder text or pre-printed
   guides in the background PDF.
8. **Static-text positions** — `STATIC_TEXT` sourceType exists (value = `fallbackValue`) but there
   is no positional model.
9. **Visual mapper UI** — drag/resize boxes over rendered PDF pages; none exists.
10. **PDF template storage/version table** — sha256 + page_count + page_size + status.
11. **Engine flag `PDF_OVERLAY`** — type union + parser + readiness gate + worker stage vocabulary.
12. **Rotation/mediaBox normalization helper** — shared by mapper (browser) and renderer (pdf-lib).

### TECHNICAL_CONFLICTS (things that will bite if ignored)

1. **Engine flag is a closed 2-value union.** `parseDocumentMergeEngine` maps anything ≠ `HTML_PDF`
   to `GOOGLE_DOCS`. A third value `PDF_OVERLAY` would silently collapse to `GOOGLE_DOCS` unless the
   type + parser + `merge_jobs.engine` checks + `production-readiness.checkEngineDefault` are all
   extended together. (`merge_jobs.engine varchar(16)` fits `"PDF_OVERLAY"` = 11 chars — no schema
   size change.)
2. **`production-readiness.ts` hard-blocks non-GOOGLE_DOCS.** It deliberately returns BLOCKED when
   engine ≠ GOOGLE_DOCS. This gate must be taught about `PDF_OVERLAY` (or a separate readiness path)
   before any activation — and must remain GOOGLE_DOCS=true until proven.
3. **Worker `processItem` is hardwired to HTML.** It requires `snap.htmlBody` (fails
   `TEMPLATE_NOT_PUBLISHED` otherwise) and calls the HTML renderer. A PDF branch needs its own
   snapshot fields (template PDF key + sha256 + positions version) and stage names
   (`WORKER_STAGES` in `queue-types.ts`).
4. **The golden background PDF will still contain `<<…>>` text.** A Google-Docs-exported PDF keeps the
   placeholder tokens as visible text. Coordinate overlay must either (a) whiteout each slot before
   drawing, or (b) use a **blanked** background PDF (placeholders replaced with empty/space in a
   *copy* of the Doc before export). Option (b) is recommended (see §9) and must be part of the
   template source strategy, or the first render will show `<<Ho_ten>>` under the overlaid name.
5. **`merge_templates.google_doc_id` is `NOT NULL`.** A pure-PDF template still needs a non-empty
   value (or a schema relaxation / nullable-with-default). Not fatal — route A/B only reads it for
   display; but it is a latent coupling between the PDF path and the Google Doc path.
6. **Checkbox output today is a Unicode glyph** (`☒`/`☐`) — font/browser dependent. The PDF overlay
   must switch to deterministic vector marks while reusing `isCheckboxMatch` for the *decision*.
7. **pdf-lib needs `@pdf-lib/fontkit`** to embed/subset a TrueType font; the Standard-14 fonts
   cannot render Vietnamese diacritics. This dependency is missing from both `package.json`s.
8. **Coordinate convention mismatch.** pdf-lib is bottom-left-origin PDF points; the browser mapper is
   top-left CSS px at a zoom scale. A single shared conversion contract is mandatory (§4).
9. **Version divergence risk.** If we reuse `merge_template_versions` for PDF positions, the HTML
   DRAFT v3 (which must not be published) and PDF mapping would share one publish slot. A separate
   `pdf_template_versions` table avoids coupling and keeps the HTML draft untouched (§3).

---

## 2. PHASE 2 — FEASIBILITY DECISION

### PDF_OVERLAY_FEASIBLE = YES (conditional)

**Why YES:** every required primitive is available in `pdf-lib@1.17.1` (already a dependency):

| Requirement | pdf-lib support |
|---|---|
| Load multi-page PDF | `PDFDocument.load(bytes)` |
| Clone per record | `copyPages(source, indices)` + `addPage` (proven in `batch-pdf.ts`) |
| Embed Vietnamese font | `pdfDoc.registerFontkit(fontkit)` + `pdfDoc.embedFont(ttf, {subset:true})` |
| Draw text at fixed coords | `page.drawText(text, {x, y, size, font, maxWidth, lineHeight})` |
| Checkbox / checkmark | `drawRectangle` + `drawLine` (X) / `drawSvgPath` (✓) + `drawEllipse` |
| Multiline wrapping | `drawText` wraps on spaces with `maxWidth`; explicit `\n` supported |
| Max-width / clipping | `maxWidth` + manual shrink loop (no built-in auto-shrink) |
| Auto-shrink | implement loop: measure `font.widthOfTextAtSize` → step down to `min_font_size` |
| Alignment | `font.widthOfTextAtSize` + manual x-offset (left/center/right) |
| Whiteout | `drawRectangle({color: white})` over slot |
| Page-specific placement | trivially — draw per page index |
| Duplicate placeholder | per-position rows keyed by `(version_id, placeholder, page, x, y)` |
| Static blank form | background pages are the clone source, never redrawn |
| Merge final PDF | `mergePdfBuffers` (exists) |
| SHA256 | `node:crypto` (exists in worker) |
| Drive upload | `StorageProvider` (exists) |
| document_history | exists |
| Batch 10–100 | CPU-light, cache parsed template + font once per process |

**Runtime assessment (Cloud Run):**

- **Memory/CPU:** pdf-lib is pure JS and far lighter than Chromium. A 5-page A4 template + one
  subsetted font (~50–300 KB) + ~50–100 draw ops per record stays well inside even 512 MB / 1 vCPU.
  No Chromium needed → the same worker image works, and a future slim `node:20-slim` image is an option.
- **Font handling:** embed one licensed TTF; subset per document (pdf-lib + fontkit subsetting).
  No reliance on system/browser fonts. (§8)
- **Coordinate systems:** pdf-lib draws in PDF user space (bottom-left, points, 1/72"). A4 portrait
  = 595.28 × 841.89 pt. Must normalize mediaBox origin + rotation. (§4)
- **Rotation / page size:** read `page.getRotation()` and `page.getSize()`; our golden export is
  A4 portrait rotation 0, so the contract defaults to that but must not assume it silently.
- **Performance:** template parse + font embed are one-time per process (cache them). Per record:
  clone pages + draw + `save()`. Order-of-magnitude: tens-to-low-hundreds ms/record, dominated by
  `save()` and Drive upload, not by drawing. (§13)

**The one real conditional:** the background PDF must be **blanked** (placeholders removed) before
it becomes the authoritative overlay background — otherwise the exported PDF still shows `<<…>>`
under the values. This is a template-production step, not a runtime blocker (§9).

**Hummus/hummus-recipe alternative:** not needed. pdf-lib covers 100% of the required primitives,
is already in the repo, and avoids a native-addon dependency in Cloud Run.

**Conclusion:** feasible now; no new rendering service, no new storage service, no Chromium required.
The work is (1) add fontkit + a font, (2) schema for positions, (3) renderer, (4) blanked template,
(5) mapper UI, (6) gates — in that order.

---

## 3. PHASE 3 — PROPOSED DATA MODEL

Do **not** hardcode coordinates in `template.ts` (it is an HTML artifact that must remain
untouched). Store coordinates in versioned DB rows, reusing the existing versioning pattern.

### RECOMMENDED_SCHEMA

**New table `pdf_template_versions`** (parallel to `merge_template_versions`, avoids coupling with
the HTML draft v3 which must stay DRAFT):

```sql
CREATE TABLE IF NOT EXISTS pdf_template_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       uuid NOT NULL REFERENCES merge_templates(id) ON DELETE CASCADE,
  version           integer NOT NULL,
  status            varchar(16) NOT NULL DEFAULT 'DRAFT',        -- DRAFT | PUBLISHED | ARCHIVED
  pdf_storage_key   text NOT NULL,                                -- immutable object key (Drive/local)
  sha256            varchar(64) NOT NULL,                         -- of the blanked background PDF
  page_count        integer NOT NULL,
  page_layout       jsonb NOT NULL DEFAULT '[]',                  -- [{index,w,h,rotation}] in PDF points
  source_note       text,                                         -- e.g. "blanked export of Google Doc 10D0t…"
  created_by        varchar(64) NOT NULL,
  published_at      timestamptz,
  archived_at       timestamptz,
  superseded_by     integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
CREATE UNIQUE INDEX pdf_template_version_published_uq
  ON pdf_template_versions (template_id) WHERE status = 'PUBLISHED';
```

**New table `pdf_field_positions`** (versioned coordinate mapping):

```sql
CREATE TABLE IF NOT EXISTS pdf_field_positions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pdf_template_version_id uuid NOT NULL REFERENCES pdf_template_versions(id) ON DELETE CASCADE,
  placeholder            varchar(255) NOT NULL,      -- canonical key == resolveAllFields() output key
  page_number            integer NOT NULL,           -- 1-based
  x                      double precision NOT NULL,  -- PDF points, bottom-left of box
  y                      double precision NOT NULL,
  width                  double precision NOT NULL,
  height                 double precision NOT NULL,
  type                   varchar(24) NOT NULL DEFAULT 'TEXT',
                       -- TEXT | MULTILINE_TEXT | DATE | NUMBER | CHECKBOX | RADIO_OPTION
                       -- | SIGNATURE_TEXT | STATIC_TEXT | IMAGE
  font_size              double precision NOT NULL DEFAULT 10,
  min_font_size          double precision,           -- NULL = no shrink (font_size fixed)
  font_family            varchar(64),                -- logical name; renderer maps to embedded font
  align                  varchar(8)  NOT NULL DEFAULT 'left',   -- left | center | right
  valign                 varchar(8)  NOT NULL DEFAULT 'top',    -- top | middle | bottom
  multiline              boolean NOT NULL DEFAULT false,
  max_lines              integer,                    -- NULL = unlimited within box
  rotation               integer NOT NULL DEFAULT 0, -- degrees, clockwise
  render_order           integer NOT NULL DEFAULT 0, -- draw order within a page
  is_required            boolean NOT NULL DEFAULT false,
  whiteout               boolean NOT NULL DEFAULT false,  -- draw white rect first
  checkbox_style         varchar(16),                -- SQUARE_X | SQUARE_TICK | SQUARE_FILLED | CIRCLE_DOT
  option_value           varchar(255),               -- for CHECKBOX/RADIO (which option this box marks)
  source_key             varchar(255),               -- group source: one value → many positions
  overflow_policy        varchar(16) NOT NULL DEFAULT 'FAIL',  -- FAIL | ELLIPSIZE
  static_text            text,                       -- value for STATIC_TEXT positions
  metadata               jsonb NOT NULL DEFAULT '{}',-- free-form (labels, notes, per-position overrides)
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- same placeholder may repeat at multiple positions/pages:
  UNIQUE (pdf_template_version_id, placeholder, page_number, x, y)
);
CREATE INDEX pdf_field_position_page_idx
  ON pdf_field_positions (pdf_template_version_id, page_number, render_order);
```

**Optional small extension to `merge_templates`** (non-destructive):
`ALTER TABLE merge_templates ADD COLUMN IF NOT EXISTS pdf_enabled boolean NOT NULL DEFAULT false;`
(optional; can also be inferred from existence of a PUBLISHED `pdf_template_versions` row).

**Position → value resolution stays in `merge_template_fields`.** A position's `placeholder` is the
SAME key the resolver emits, so `resolveAllFields(fields, record, context)` feeds the renderer
directly with no new mapping logic. `option_value`/`source_key` on a position only decide *how a
resolved checkbox/radio value is stamped* — the business logic of "is it checked" still comes from
`isCheckboxMatch` in `checkbox-engine.ts`.

### MIGRATIONS_REQUIRED

1. `pdf_template_versions` (CREATE TABLE IF NOT EXISTS + partial unique index) — idempotent.
2. `pdf_field_positions` (CREATE TABLE IF NOT EXISTS + index) — idempotent.
3. (Optional) `merge_templates.pdf_enabled` — ADD COLUMN IF NOT EXISTS.
4. (Optional, later) relax `merge_templates.google_doc_id` to nullable — **defer**; not needed for
   a first official-form page because the golden Doc still exists.

All migrations follow the repo convention: non-destructive, `IF NOT EXISTS`, no drops, runnable
repeatedly (see `migrations/2026-08-*`).

### BACKWARD_COMPATIBILITY

- **Zero impact on GOOGLE_DOCS** — no existing table/column is dropped or altered; the legacy
  engine continues to read the live Google Doc and `merge_template_fields` exactly as today.
- **Zero impact on HTML_PDF** — `merge_template_versions` (v3 DRAFT) is untouched; its publish slot
  is independent of `pdf_template_versions`.
- **New tables are additive** — old queries, routes, and the production-readiness gate are unaffected.
- **Rollback** = never set `DOCUMENT_MERGE_ENGINE=PDF_OVERLAY` (flag stays GOOGLE_DOCS); the new
  tables simply sit unused.

---

## 4. PHASE 4 — COORDINATE SYSTEM CONTRACT

### COORDINATE_SYSTEM

**Canonical internal system: PDF user-space points, origin bottom-left.**

- Unit: **1 pt = 1/72 inch.** No DPI assumption — PDF points are resolution-independent; DPI only
  matters for raster *previews*, which convert back to points before persisting.
- `x`, `y` = **bottom-left corner** of the field bounding box, in points.
- `width`, `height` = box size in points.
- `pageNumber` = 1-based.
- `rotation` = degrees clockwise, stored per **page** (`page_layout[].rotation`) and per field
  (`positions.rotation`, usually 0 for A4 portrait government forms).
- **Page geometry:** A4 portrait = **595.28 × 841.89 pt**. Landscape = 841.89 × 595.28 pt.
- **mediaBox/cropBox normalization:** renderer and mapper both normalize by subtracting the
  mediaBox origin and applying rotation, so stored coordinates are always relative to the visible
  top-left after rotation, converted to bottom-left PDF space. (Implementation: `normalize(mediaBox,
  rotate)` shared in a single module — `src/lib/document-merge/pdf-geometry.ts`.)
- **mm ↔ pt:** `pt = mm × 72 / 25.4` (1 mm = 2.83464567 pt). `in ↔ pt: ×72`.
- **Browser mapper conversion (MUST be the only place CSS↔PDF conversion happens):**
  ```
  scale        = viewport.width / pageWidthPt            // pdf.js render scale
  xPt          = cssX / scale
  yPt          = pageHeightPt - ((cssY + boxCssH) / scale)   // top-left → bottom-left
  ```
  The mapper persists **points (bottom-left)** only; it never persists CSS px. The renderer consumes
  points directly. This guarantees the UI and the PDF renderer share one coordinate system.

**One source of truth for constants:** `A4_PT = {width: 595.28, height: 841.89}` and `MM_TO_PT`
live in the same geometry module used by mapper, renderer, and STRUCTURAL_GATE.

---

## 5. PHASE 5 — FIELD RENDER TYPES

### FIELD_RENDER_TYPES

| Type | Value source | Renderer behavior |
|---|---|---|
| `TEXT` | resolver string | single line, left/center/right, shrink-to-fit if `min_font_size` set |
| `MULTILINE_TEXT` | resolver string | wrap to width, `max_lines`, shrink-to-fit |
| `DATE` | resolver string (already formatted by `formatters`) | rendered as TEXT — no re-derivation |
| `NUMBER` | resolver string (already formatted) | rendered as TEXT (right-align optional) |
| `CHECKBOX` | `resolveCheckboxOption` decision | draw box outline + optional X/✓/fill (vector, no glyph) |
| `RADIO_OPTION` | same decision as CHECKBOX | draw circle/box per `checkbox_style` |
| `SIGNATURE_TEXT` | resolver string (e.g. `fullName`) | italic-style text into the signature slot |
| `STATIC_TEXT` | `position.static_text` (or resolver `fallbackValue`) | fixed label drawn at position |
| `IMAGE` (future) | storage key/bytes | `embedPng/embedJpg` + `drawImage` (defer) |

`DATE`/`NUMBER` are deliberately **not** special-cased: the formatter layer already produced the
final display string (`formatters.ts`), so the renderer treats them as plain text. This prevents any
duplication of date/currency logic.

### RESOLVER_REUSE_PLAN

```
daily_application
  → buildApplicantMergeRecord (record-loader.ts)          [reused, unchanged]
  → resolveAllFields(merge_template_fields, record, ctx)  [reused, unchanged]
  → fieldValues: Record<placeholder, string>              [already formatted]
  → pdfCoordinateRenderer.render(templatePdf, positions, fieldValues, ctx)
       • TEXT/DATE/NUMBER/MULTILINE/SIGNATURE/STATIC → draw fieldValues[placeholder]
       • CHECKBOX/RADIO → isCheckboxMatch(fieldValues[source], position.option_value) → mark
  → bytes → sha256 → storage.put → document_history → completeItem   [reused, unchanged]
```

No new business mapping. The renderer is a **pure, deterministic function** of
`(templatePdfBytes, positions, fieldValues, context)`.

---

## 6. PHASE 6 — CHECKBOX / RADIO DESIGN

### CHECKBOX_RENDER_STRATEGY

**Decision logic reused from `checkbox-engine.ts`** (`isCheckboxMatch`, diacritic-insensitive,
normalizes "Có/Không"). **Drawing is new and deterministic** (vector, no glyph, no browser fonts).

- Every checkbox/radio position carries `option_value` and a `source_key`.
- `source_key` groups positions fed by one source value (e.g. `tien_an_tien_su`), so **one source
  value controls N box positions** consistently — including the same placeholder repeated on
  multiple pages.
- Draw, in order: (1) if `whiteout` → white rect; (2) box outline `drawRectangle` (lineWidth ≈ 0.8–1pt,
  black); (3) if checked, the mark per `checkbox_style`:

| `checkbox_style` | Unchecked | Checked |
|---|---|---|
| `SQUARE_X` (default) | empty square | square + two diagonal lines (X) |
| `SQUARE_TICK` | empty square | square + two segments (✓) |
| `SQUARE_FILLED` | empty square | filled square (or square + X) |
| `CIRCLE_DOT` (radio) | empty circle | circle + filled dot |

Covered groups (from the 49 placeholders): `Tien_an_tien_su_{Khong,Co}`,
`Da_tung_lam_DHF_{Khong,Co}`, `Loai_cong_viec_*`, `Khu_vuc_*`, `Cong_viec_hien_tai_*`,
`TKNH_{Da_co,Chua_co}`, `Thu_nhap_{Chi_DHF,Ngoai_DHF}`, `Tap_nghe_*`.

Rationale: deterministic lines/rects are immune to font fallback and glyph-metrics drift, which is
exactly the fidelity problem HTML had.

---

## 7. PHASE 7 — TEXT FITTING ENGINE

### TEXT_FIT_STRATEGY

For each position with a fixed bounding box:

1. Start at `font_size`.
2. **Wrap** text to `width` using `font.widthOfTextAtSize` (word-wrap on spaces; long unbroken
   tokens such as bank numbers get char-level break or size shrink).
3. If resulting line count > `max_lines` (or any line width > box width), **shrink** by a step
   (e.g. −0.5 pt) down to `min_font_size` (or `font_size` when `min_font_size` is NULL).
4. Vertical placement per `valign` (top/middle/bottom); horizontal per `align`.
5. Measure once with the *embedded* font (same font object used to draw) so measurements equal output.

### OVERFLOW_POLICY

- **`FAIL` (default):** if text still cannot fit at the minimum font size (or is required and cannot
  fit), return a deterministic validation failure — `errorCode: TEXT_OVERFLOW` with `placeholder` and
  `page` — and fail that record item. **Never silently truncate required fields.**
- **`ELLIPSIZE` (opt-in, non-required only):** truncate with `…` to the last fitting line. Use only
  for optional notes; the mapper sets it explicitly.
- Overflow is **pre-computable** and surfaces in RENDER_GATE (fail-fast on the 1-record render).

Long-value fields covered: addresses (`Dia_chi_thuong_tru`, `Dia_chi_tam_tru`, `dia_chi_cu_tru`),
company/bank names (`Ten_ngan_hang`, `Cong_ty_thu_nhap_khac`, `Ten_truong`, `Dia_diem_thu_nhap_khac`),
notes/`Cong_viec_khac`, `Noi_cap_CCCD`.

---

## 8. PHASE 8 — FONT STRATEGY

### FONT_STRATEGY

- **Mandatory:** one embedded TrueType font with full Vietnamese coverage (precomposed + combining
  diacritics: ăâđêôơư + tone marks). Candidates (SIL OFL, redistributable): **Be Vietnam Pro**,
  **Noto Sans**, **DejaVu Sans**.
- **Deterministic selection:** a single logical family (`font_family` on positions maps to one of a
  tiny registry of embedded faces — Regular, Bold if needed). No runtime font discovery.
- **Embedding:** `pdf-lib` + `@pdf-lib/fontkit`; `embedFont(bytes, { subset: true })` to embed only
  used glyphs per document (small PDFs, ~50–300 KB font payload).
- **Shipping:** bundle the TTF in the worker image and in the Next.js app (`public/fonts/` or
  `src/…/fonts/`), committed as a versioned asset; OR load once from template storage and cache in
  process. Do **not** rely on browser/system fonts for the PDF engine.
- **No missing glyphs:** a `FONT_GLYPH_COVERAGE` check in STRUCTURAL_GATE verifies every character in
  the character set used by the 49 placeholders + Vietnamese sample corpus is present in the
  selected face (via fontkit `font.hasGlyphForCodePoint`).
- The HTML preview (mapper) may use the same family via CSS `@font-face` for WYSIWYG parity, but the
  authoritative PDF glyph metrics come from the embedded face.

---

## 9. PHASE 9 — PDF TEMPLATE SOURCE STRATEGY

### PDF_TEMPLATE_STORAGE_STRATEGY

**Store the authoritative background PDF in the existing `StorageProvider` (Google Drive in
production, local in dev), NOT in the Git repo and NOT as a DB blob.**

- **Why not repo binary:** PDFs are large and change independently of code; the golden source is the
  live Google Doc, not a checked-in file. Git binary history bloat is avoidable.
- **Why not DB blob:** the repo convention is explicit — Neon stores metadata/keys only, never binary.
- **Why Drive (reuse):** same storage + auth (OAuth/WIF) already wired for final PDFs; supports
  immutable versioned keys and folder structure.

**Lifecycle (versioned + immutable + reproducible):**

1. **Produce the blanked background** (one-time, non-destructive): copy the golden Google Doc →
   replace all 49 active placeholders with empty (or spaces) → keep the 2 accepted orphan lines as
   static text → export to PDF. This is the authoritative government-form background with the exact
   official visual structure.
2. **Upload to** `Document Templates/PDF/<template_key>/v<version>.pdf` via `StorageProvider.put`
   (never overwrite — versioned keys).
3. **Record** `sha256`, `page_count`, `page_layout`, `status=DRAFT` in `pdf_template_versions`.
4. **Publish** only after STRUCTURAL_GATE + RENDER_GATE pass; publishing is a version pointer
   change (old key stays immutable).
5. **Rollback** = publish a previous version row (points back to its immutable key).
6. **Audit/reproducibility:** worker verifies `sha256(templateBytes) == stored sha256` before the
   first draw of a job; the job metadata snapshot carries `{pdf_storage_key, sha256, version}` so a
   later re-publish can never change already-generated PDFs.

**Production-safety:** template PDF upload goes to a **staging** folder/key first (per the "do not
upload official form to Production storage yet" rule); production activation is a later, separate step.

---

## 10. PHASE 10 — ADMIN VISUAL MAPPER

### VISUAL_MAPPER_ARCHITECTURE

**Where:** new Admin-only tab under `/admin/document-merge` ("Bản đồ tọa độ PDF" / Visual Mapper),
guarded by existing RBAC (`document_merge.templates.manage`). No public exposure.

**Stack (all already present or isomorphic):**

- **pdf.js** (`pdfjs-dist`) — render each PDF page to `<canvas>`. Already a worker dep; add to root
  app for browser use.
- **SVG overlay** (absolute-positioned, same size as the canvas) — draw + hit-test the bounding
  boxes; drag (move), corner handles (resize).
- **pdf-lib in the browser** (isomorphic) — client-side *preview* render with a sample record for
  instant feedback; the authoritative render remains server/worker-side.
- **`react-pdf` not needed** — pdf.js + canvas/SVG is sufficient and already proven in the stack.

**Workflow:**

1. Upload/select a PDF template (or reuse the stored blanked background key).
2. Render pages in browser; choose page.
3. Pick a placeholder (from the 49 active list) or drag an unmapped placeholder chip.
4. Click/drag to place + resize its bounding box on the page.
5. Set per-position: font size, min font size, alignment, multiline, max lines, checkbox style,
   whiteout, overflow policy.
6. **Preview** with a sample record or a selected real record (client-side pdf-lib render).
7. **Save DRAFT** → `pdf_field_positions` against a DRAFT `pdf_template_versions`.
8. **Publish** only after STRUCTURAL_GATE + RENDER_GATE pass (operator never types raw x/y).

**Coordinate fidelity:** the browser↔PDF conversion is the single shared function from §4
(`cssToPdfPoints`), so what the operator sees is exactly what the renderer draws.

---

## 11. PHASE 11 — VALIDATION GATES

### VALIDATION_GATES

**STRUCTURAL_GATE (blocking, on publish):**
- PDF `page_count` matches `page_layout.length` and the expected form count.
- All **49 active** placeholders have ≥1 position; no required field unmapped.
- **No unknown placeholders** (positions referencing keys not in the template's field set).
- **No orphan placeholders** — `So_hop_dong_dich_vu_thue` / `Ngay_hop_dong_dich_vu_thue` must have
  **zero** positions (static in background).
- Every box inside page bounds (`0 ≤ x`, `0 ≤ y`, `x+width ≤ pageW`, `y+height ≤ pageH`).
- `font_size ≥ min_font_size`; `max_lines ≥ 1`; valid `type`/`align`/`valign`/`checkbox_style`.
- `FONT_GLYPH_COVERAGE` check passes for the embedded face.

**RENDER_GATE (blocking):**
- 1-record render succeeds with the sample corpus + a real record.
- `unreplaced == []`, `missingFields == []`.
- Zero `TEXT_OVERFLOW` for required fields; optional fields obey their `overflow_policy`.

**VISUAL_GATE (manual + automated):**
- Static background is **byte-identical** to the stored template (hash equality — we clone pages, we
  never re-rasterize the background).
- Overlay diff vs golden reference limited to value boxes only, via the existing
  `worker/src/verification.ts` (pdfjs + pixelmatch, per-page threshold — reuse the ≤3%/page pattern).

**PERFORMANCE_GATE:**
- 1 record, then 10, then 50 (reuse the `/benchmark` shape: fixed counts, concurrency-batched,
  p50/p95). Block rollout if p95 per-record exceeds budget.

---

## 12. PHASE 12 — IDEMPOTENCY / RETRY

### IDEMPOTENCY_STRATEGY

The existing queue already provides most of this; the overlay renderer must preserve it:

- **Deterministic identity:** `merge_job_records.id` (UUID) + `source_record_id` + `sort_order`.
- **Deterministic output:** render = `f(templatePdfSha256, positionsVersion, fieldValues, recordId)`
  → same bytes → same `sha256` on retry.
- **No double-processing:** `claimItems` single-SQL `FOR UPDATE SKIP LOCKED` + lease + `reclaimStalledItems`
  (unchanged).
- **No duplicate Drive artifacts:** storage key is date+filename with `applicationId` suffix (already
  unique, `filename.ts`); on retry, if the item already has a non-null `storageKey`+`sha256`, verify
  `storage.exists(key)` and reuse instead of re-upload; optionally `put` is preceded by an `exists`
  check. Add an idempotency guard: **write output only after sha256 matches the expected value, and
  mark COMPLETED atomically** with the document_history insert (same ordering as today).
- **Template immutability at job time:** job metadata snapshots `{pdf_storage_key, sha256, version}`
  (mirrors the existing field/HTML snapshot); a later publish cannot change in-flight or historical
  renders.

### PARTIAL_FAILURE_STRATEGY

- Per-item failure is isolated (`failItem` → RETRY with backoff, then FAILED) — one bad record never
  fails the batch (already true).
- `finalizeBatchOutputs` merges only COMPLETED items; job COMPLETED with `errorSummary` if some
  items failed, FAILED only if zero completed (already true).
- Overlay-specific deterministic errors (e.g. `TEXT_OVERFLOW`, `RECORD_NOT_FOUND`,
  `TEMPLATE_SHA_MISMATCH`) become `errorCode`s on the item for retry/UI triage.

---

## 13. PHASE 13 — PERFORMANCE MODEL

### PERFORMANCE_EXPECTATION

Qualitative, dominant-cost model (numbers to be measured in Stage 4, not invented here):

| Cost | PDF overlay | GOOGLE_DOCS (current) | HTML_PDF (Chromium) |
|---|---|---|---|
| Template load | once/process (parse + font embed, cache) | per-job Google Docs fetch | Chromium launch + per-page HTML |
| Per record | clone pages + ~50–100 draw ops + `save()` | Docs API batchUpdate (network, seconds) | `page.setContent` + `page.pdf` (~1–3 s) |
| Memory | low (MBs) | n/a | high (Chromium ~hundreds MB) |
| Rate limits | none | Docs API quota + `docs-rate-limit-guard` | none but slow |
| Determinism | byte-stable given inputs | font/export drift possible | browser rendering drift |

**Expected scaling (1 / 10 / 50 / 100 records):** dominated by **per-record `save()` + Drive upload**,
not drawing. Template/font are cached once, so throughput scales ~linearly with concurrency until
Drive upload bandwidth/latency becomes the bottleneck. CPU-light → `PDF_RENDER_CONCURRENCY` can be
raised well beyond the current Chromium value of 4. The 10–100 record requirement is comfortably in
range; a 100-record run is a stress-test, not a risk.

**DB:** unchanged pattern (claim + a few UPDATEs per item); negligible next to render/upload.

---

## 14. PHASE 14 — MIGRATION PLAN

### MIGRATION_PLAN

| Stage | Scope | Gate to proceed |
|---|---|---|
| 0 (now) | Produce blanked background PDF + draft the 49 coordinate map (audit only) | STRUCTURAL_GATE on draft |
| 1 | **One official form page** (Giấy đăng ký tập nghề) via PDF overlay, behind flag `PDF_OVERLAY` on staging | 1-record render byte-stable, visual diff on that page |
| 2 | Full 49-field, 5-page coordinate mapping | STRUCTURAL + RENDER gates |
| 3 | 1-record **staging** verification (real record, real Drive) | hash + visual gate |
| 4 | 10-record benchmark (staging) | PERFORMANCE_GATE |
| 5 | Limited Production rollout (selected records), flag stays opt-in | operator sign-off |
| 6 | 100-record stress test if needed | capacity sign-off |

**Rollback:** `DOCUMENT_MERGE_ENGINE` remains `GOOGLE_DOCS` as the permanent fallback; PDF overlay is
selected per-job (`merge_jobs.engine = 'PDF_OVERLAY'`) rather than as the global default until proven.
Flipping back to `GOOGLE_DOCS` (or running a job without the flag) needs no code revert.

---

## 15. PHASE 15 — DECISION: FULL PDF vs HYBRID

### FULL_PDF_VS_HYBRID

The packet ("Giấy đăng ký tập nghề" + "Quy định tập nghề" + "Bản cam kết thuế" + "Giấy ủy quyền"
+ "Tờ khai 05-ĐKT") is **five official-format pages** — there are **no free-form internal pages** to
justify an HTML half.

| Criterion | A. FULL PDF overlay | B. HYBRID (HTML internal + PDF official) |
|---|---|---|
| Fidelity (gov forms) | exact — background is the golden PDF, values overlaid | exact only on the PDF pages; HTML pages drift |
| Maintainability | one renderer, one coordinate model | two renderers + two template pipelines |
| Speed | one lightweight pass | mixed (Chromium for HTML half) |
| Ease of editing | visual mapper (drag/resize) + gates | two separate editors |
| Versioning | one versioned coordinate mapping | two version stores to reconcile |
| Operator workflow | single mapping surface | two workflows |
| Future forms | add a page = add background PDF + map positions | same, plus decide HTML vs PDF per page |

### RECOMMENDED_ARCHITECTURE = A. FULL PDF COORDINATE OVERLAY

Full PDF overlay is **materially better for this packet**, not just "as requested": every page is a
government/official form whose visual structure must be preserved 1:1, and the HTML route has already
proven (v3 DRAFT) that reconstructing those forms loses fidelity. HYBRID adds an HTML renderer and a
second template pipeline that this packet does not use. Keep HYBRID as a documented *future* option
only if a later packet mixes internal memos with official forms — not needed now.

---

## 16. PHASE 16 — IMPLEMENTATION SCOPE

### IMPLEMENTATION_PLAN

| PR | Scope | Touches |
|---|---|---|
| **PR1** | Schema + core renderer. Add `pdf_template_versions` + `pdf_field_positions` (migration), `pdf-geometry.ts` (coordinate contract), `@pdf-lib/fontkit` + font asset, pure `pdf-coordinate-renderer.ts` (text fit, vector checkbox, whiteout), unit tests with a synthetic A4 template | `migrations/`, `src/db/schema.ts`, `src/lib/document-merge/` |
| **PR2** | Template PDF/version storage. Upload blanked background → `StorageProvider`, sha256/page_count/page_layout record, publish/rollback service (mirrors `template-versions.ts`) | `src/lib/document-merge/pdf-template-service.ts`, API routes |
| **PR3** | Coordinate mapper model/API + job snapshot. CRUD for positions, `source_key` grouping, snapshot `{pdf_storage_key, sha256, version, positions}` into `merge_jobs.metadata`, worker `processItem` PDF branch + new `WORKER_STAGES` | `queue-types.ts`, `async-job.ts`, `worker/src/index.ts` |
| **PR4** | Admin Visual Mapper UI. pdf.js canvas + SVG overlay, drag/resize, per-position config, client-side pdf-lib preview, DRAFT save + publish gates | `src/components/document-merge/`, `src/app/(internal)/admin/document-merge/` |
| **PR5** | Verification/benchmark. STRUCTURAL/RENDER/VISUAL/PERFORMANCE gates, reuse `worker/src/verification.ts` + `/benchmark` shape | `src/lib/document-merge/`, `worker/src/` |
| **PR6** | Production activation. Extend `engine-config.ts` + `production-readiness.ts` for `PDF_OVERLAY`, per-job engine selection, runbook update, rollback doc | `engine-config.ts`, `production-readiness.ts`, `docs/` |

PR boundaries follow existing module seams (queue vs renderer vs storage vs UI), so each PR is
independently mergeable and production-inert until PR6.

---

## HARD SAFETY COMPLIANCE (confirmed in this phase)

- No publish of DRAFT v3/v4 ✅ (nothing touched)
- No `HTML_PDF` activation ✅
- `DOCUMENT_MERGE_ENGINE` unchanged ✅ (flag untouched; extension only *planned* for PR6)
- No production mapping changes ✅ (new tables only, none created yet)
- No production jobs run ✅
- No official form uploaded to production storage ✅ (staging-only path designed)
- No WIF/OIDC / secret / service-account-key changes ✅
- GOOGLE_DOCS fallback retained ✅ (permanent fallback in the plan)
- No PR opened in this audit-only phase ✅

---

## FINAL REPORT

```
CURRENT_ARCHITECTURE =
  Next.js 16 + Neon/Drizzle + Cloud Run Playwright worker. Two engines share one durable
  Postgres queue (SKIP LOCKED claim/lease/retry): GOOGLE_DOCS (default, live-Doc replaceAllText →
  Drive PDF) and HTML_PDF (HTML/CSS → Chromium page.pdf, built but NOT activated). Data path:
  buildApplicantMergeRecord → resolveAllFields → formatted fieldValues → render → sha256 →
  StorageProvider.put → document_history → completeItem → finalize (pdf-lib merge + ZIP).
  Admin "Mapping Inspector" maps placeholder→source in a table; no spatial/coordinate UI exists.

REUSABLE_COMPONENTS =
  queue.ts (claim/retry/reclaim/finalize), data-resolver + formatters + checkbox-engine (value
  resolution), record-loader/applicant-record, StorageProvider (local/google_drive),
  document_history + retention, template-versions publish/rollback pattern, pdf-lib
  (batch-pdf copyPages), worker/verification.ts (pdfjs + pixelmatch), filename/storage-key
  uniqueness, production-readiness read-only gate, validation-gate pattern.

MISSING_COMPONENTS =
  coordinate data model (pdf_field_positions), PDF background loader/cloner, @pdf-lib/fontkit +
  Vietnamese TTF asset + embed utility, text-fitting (wrap/shrink/maxLines/overflow), vector
  checkbox/mark primitives, page-specific + duplicate-position rendering, whiteout utility,
  static-text positions, visual mapper UI, PDF template version table (sha256/page_count),
  engine flag PDF_OVERLAY, rotation/mediaBox normalization, worker stage vocabulary.

PDF_OVERLAY_FEASIBLE = YES (conditional)
  pdf-lib@1.17.1 (already present) covers every required primitive. Conditions: (1) add
  @pdf-lib/fontkit + a licensed Vietnamese TTF; (2) produce a BLANKED background PDF so the
  golden form has no residual <<…>> text; (3) extend the engine flag/readiness gate/worker branch
  together; (4) no new rendering/storage service required — Cloud Run is more than sufficient.

RECOMMENDED_SCHEMA =
  pdf_template_versions (id, template_id, version, status DRAFT|PUBLISHED|ARCHIVED, pdf_storage_key,
  sha256, page_count, page_layout[], source_note, created_by, published_at, archived_at,
  superseded_by, timestamps; partial-unique one PUBLISHED per template)
  + pdf_field_positions (id, pdf_template_version_id, placeholder, page_number, x, y, width,
  height, type, font_size, min_font_size, font_family, align, valign, multiline, max_lines,
  rotation, render_order, is_required, whiteout, checkbox_style, option_value, source_key,
  overflow_policy, static_text, metadata; UNIQUE (version_id, placeholder, page, x, y) → duplicate
  placeholder supported). Value resolution stays in merge_template_fields (same placeholder key).

COORDINATE_SYSTEM =
  PDF user-space points, origin BOTTOM-LEFT. A4 portrait 595.28×841.89 pt. x/y = box bottom-left,
  width/height in pt, pageNumber 1-based, rotation degrees clockwise. mm→pt = ×72/25.4
  (1mm=2.83464567pt). No DPI assumption (points are resolution-independent). Normalize mediaBox
  origin + rotation via a single shared geometry module; browser mapper converts CSS px→points and
  NEVER persists CSS px — mapper and renderer share the same contract.

FIELD_RENDER_TYPES =
  TEXT, MULTILINE_TEXT, DATE, NUMBER, CHECKBOX, RADIO_OPTION, SIGNATURE_TEXT, STATIC_TEXT,
  IMAGE(future). DATE/NUMBER render as pre-formatted TEXT (formatter already produced the string).
  CHECKBOX/RADIO use isCheckboxMatch decision → vector mark.

RESOLVER_REUSE_PLAN =
  daily_application → buildApplicantMergeRecord → resolveAllFields → formatted fieldValues →
  pdfCoordinateRenderer.render(templatePdf, positions, fieldValues, ctx). Renderer is pure and
  deterministic; zero new business mapping logic.

CHECKBOX_RENDER_STRATEGY =
  Reuse isCheckboxMatch (diacritic-insensitive) for the decision; draw vector marks via pdf-lib
  (drawRectangle outline + drawLine X / two-segment ✓ / filled square / circle dot) — NO glyphs,
  NO browser fonts. source_key groups positions so one source value controls N boxes; option_value
  selects which option a box marks. Covers Tien_an_tien_su/Da_tung_lam_DHF/Khu_vuc/Loai_cong_viec/
  Tap_nghe/TKNH/Thu_nhap groups.

TEXT_FIT_STRATEGY =
  Fixed box → wrap by width (embedded-font widthOfTextAtSize) → shrink stepwise to min_font_size →
  valign top/middle/bottom + align left/center/right. Measure with the SAME embedded font used to
  draw (measure == output).

OVERFLOW_POLICY =
  FAIL (default): deterministic TEXT_OVERFLOW failure, never silently truncate required fields.
  ELLIPSIZE (opt-in, non-required only) for optional notes. Overflow pre-computed and surfaced in
  RENDER_GATE.

FONT_STRATEGY =
  One embedded Vietnamese TTF (Be Vietnam Pro / Noto Sans / DejaVu Sans — OFL). pdf-lib +
  @pdf-lib/fontkit, subset per document. Deterministic registry (Regular/Bold). Shipped in worker
  image + app (or cached from template storage). FONT_GLYPH_COVERAGE gate. No system/browser font
  reliance.

PDF_TEMPLATE_STORAGE_STRATEGY =
  Store blanked background PDF in the existing StorageProvider (Drive prod / local dev) under
  versioned immutable keys Document Templates/PDF/<key>/v<version>.pdf — NOT in Git, NOT a DB blob.
  Record sha256 + page_count + page_layout; publish = version pointer change; rollback = publish
  old version; worker verifies sha256 at job time; production upload deferred (staging first).

VISUAL_MAPPER_ARCHITECTURE =
  Admin-only tab in /admin/document-merge: pdf.js canvas + SVG overlay (drag/resize), placeholder
  chips, per-position config, client-side pdf-lib preview with sample/real record, DRAFT save,
  publish after gates. pdf.js + canvas/SVG (react-pdf not needed). Browser CSS px→points via the
  single shared conversion function.

VALIDATION_GATES =
  STRUCTURAL (page_count, 49 mapped, no unknown/orphan, boxes in bounds, font≥min, glyph coverage)
  → RENDER (1-record, no overflow, no missing, unreplaced=[]) → VISUAL (background byte-identical,
  pixel diff ≤3%/page on value boxes) → PERFORMANCE (1/10/50, p50/p95 budget).

IDEMPOTENCY_STRATEGY =
  Deterministic identity (record UUID + sortOrder) + deterministic output
  f(templateSha256, positionsVersion, fieldValues, recordId) → same sha256. SKIP LOCKED claim +
  lease + reclaim prevent double-processing. Unique storage keys (applicationId suffix) + exists()
  guard + sha256 match before COMPLETED prevent duplicate Drive artifacts. Job metadata snapshots
  the template PDF key+sha256+version.

PARTIAL_FAILURE_STRATEGY =
  Per-item RETRY→FAILED isolation (unchanged); finalize merges COMPLETED only; job COMPLETED with
  errorSummary on partial failure, FAILED only when zero completed. Overlay-specific errorCodes
  (TEXT_OVERFLOW, TEMPLATE_SHA_MISMATCH) for triage.

PERFORMANCE_EXPECTATION =
  Dominant cost = per-record save() + Drive upload (template parse + font embed cached once per
  process). CPU-light → concurrency can exceed the Chromium value of 4. Qualitatively: much faster
  and byte-deterministic vs GOOGLE_DOCS (network API, rate-limited) and vs HTML_PDF (Chromium
  1–3s/record, memory-heavy). 10–100 records comfortably in range; measure in Stage 4.

FULL_PDF_VS_HYBRID =
  FULL PDF wins for this packet: all 5 pages are official forms; there are no internal HTML pages.
  Hybrid would add a second renderer + second template pipeline for zero benefit. Keep Hybrid only
  as a future option for packets that mix internal memos with official forms.

RECOMMENDED_ARCHITECTURE = FULL PDF COORDINATE OVERLAY
  Authoritative blanked multi-page PDF background + versioned coordinate positions + vector marks
  + embedded Vietnamese font + text-fit engine, rendered per record by a deterministic pure
  function inside the existing async queue/worker, reusing resolver/formatters/storage/history.
  GOOGLE_DOCS remains the permanent fallback.

MIGRATION_PLAN =
  0 blanked background + draft coordinates (audit) → 1 one-page overlay on staging → 2 full
  49-field/5-page mapping → 3 one-record staging verify → 4 ten-record benchmark → 5 limited
  production rollout (per-job flag) → 6 100-record stress test. Rollback = keep
  DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS; PDF_OVERLAY opt-in per job until proven.

IMPLEMENTATION_PLAN =
  PR1 schema + core renderer · PR2 template PDF/version storage · PR3 coordinate mapper model/API +
  job snapshot + worker branch · PR4 admin visual mapper UI · PR5 verification/benchmark ·
  PR6 production activation (engine flag + readiness gate). Each PR production-inert until PR6.

PRODUCTION_CHANGED = NO
ENGINE_DEFAULT = GOOGLE_DOCS

ONE_NEXT_OPERATOR_ACTION =
  In STAGING only (read/copy, no production write): copy the golden Google Doc
  (10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE), blank the 49 placeholders (keep the 2 accepted
  orphan tax-contract lines as static text), export to PDF, record sha256 + page count, and start
  drafting the x/y/width/height of each of the 49 fields for page 1 — this unblocks PR1/PR2 and is
  the cheapest high-value step toward the decision above.
```
