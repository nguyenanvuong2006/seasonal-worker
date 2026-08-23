# HTML Document-Merge Engine — Implementation Report

**Branch:** `arena/01a02c86-seasonal-worker`  
**Date:** 2026-08-23  
**Status:** Code complete and locally quality-gated. Staging execution remains blocked by unavailable staging credentials/worker endpoint in this sandbox; no production data or database was changed.

## Architecture used

The implementation deliberately reuses the existing document-merge architecture. No parallel queue, storage layer, worker, authorization path, or audit trail was created.

```text
Daily application / related records
  -> buildApplicantMergeRecord (normalized merge data)
  -> existing merge_template_fields snapshot (semantic field mapping)
  -> canonical HTML contract + HTML version snapshot
  -> escaped {{Field}} / legacy <<Field>> replacement
  -> Playwright Chromium page.pdf(A4)
  -> existing StorageProvider, document_history, merge_job_records
  -> existing batch finalizer, retention and audit lifecycle
```

- **Authorization:** existing `document_merge.execute` permission and data-scope filtering happen before a job is created.
- **Job lifecycle:** existing `merge_jobs` and `merge_job_records` remain the durable queue; HTML/PDF jobs are queued, claimed, retried, finalized, and exposed through the existing job APIs/UI.
- **Worker lifecycle:** the existing authenticated Cloud Run worker is triggered via `after()` and reuses one Chromium/page pool. It only claims `HTML_PDF` work; legacy Google Docs jobs cannot be consumed by it.
- **Audit/history:** each rendered PDF uses the existing SHA-256, StorageProvider, `document_history`, retention snapshot, and job-item linkage. Requested applicant dispatch now updates the same application PDF-link fields used by the existing flow.
- **Existing modes remain separate:** `GOOGLE_DOCS` keeps its legacy synchronous Google Docs path. PDF Overlay is untouched; this implementation has no coordinate mapping code.

## Canonical field contract and mapping

`src/document-templates/dang-ky-tap-nghe/schema.ts` now declares the reviewed 49-field contract for the registered first-party template. It contains only semantic field keys, labels, field kind, requirement state, and documented normalized source path/options—never candidate data.

Required normalized fields:

- `Ho_ten` ← `fullName`
- `Ngay_sinh` ← `dob`
- `Dia_chi_thuong_tru` ← `permanentAddress`
- `Dia_chi_tam_tru` ← `residentialAddress`
- `So_dien_thoai` ← `phone`
- `So_CCCD` ← `cccd`
- `Ngay_nhan_viec` ← `startingDate`

Optional fields, computed dates, dynamic answers, and checkbox options remain mapped through the existing `merge_template_fields` database rows. Checkbox values are resolved by the existing `CHECKBOX_OPTION` resolver (`☒` for the matching option and `☐` otherwise), not by PDF positions.

The new generic contract utility validates:

1. Canonical HTML contains exactly the contract keys and no unexpected keys.
2. Contract-required keys have active mappings before an HTML/PDF job is queued.
3. Contract-required and DB-required values are non-empty before the worker calls Playwright.
4. No unresolved placeholder remains after rendering.

HTML accepts `{{Ho_ten}}` as the canonical syntax and continues to render legacy `<<Ho_ten>>` in already-published Google Docs-era versions. Both are one semantic merge key.

## How HTML templates are registered and selected

- First-party templates are registered explicitly in `src/document-templates/registry.ts` with a stable key, Google Doc provenance, canonical visual HTML, CSS, and optional contract.
- Production rendering uses the existing **published `merge_template_versions` snapshot** (`html_body`, `print_css`, field mapping, retention), not a mutable registry lookup. This preserves historical PDFs when a template later changes.
- The registry contributes the contract key only for the known first-party template; generic administrator-authored HTML templates still use their DB version and DB mapping snapshot.
- HTML/PDF template selection is explicit: `templateId` is mandatory and Auto Route is rejected/disabled for `HTML_PDF`. The UI makes this clear. Google Docs Auto Route remains unchanged.
- A selected HTML template must be active, `html_enabled`, and have a published HTML version before a job can be created.

## PDF generation and print behavior

- The existing Playwright/Chromium worker renders fully merged HTML with `page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true })`.
- Shared CSS defines `@page { size: A4; }`, logical `.page + .page` breaks, print color preservation, fixed-width tables, and `overflow-wrap:anywhere` for long Vietnamese names/addresses.
- Replacing `page-break-after: always` with a next-section `break-before: page` eliminates a forced trailing blank page. Long values may still legitimately occupy an additional page, but cannot overlap adjacent fields.
- The accepted job snapshots `renderedAt`; retries use the same merge clock for computed/signature dates and deterministic content pagination.
- Preview-only navigation, buttons, template-code panels, highlight markers, scripts, and embedded browsing contexts are stripped before production PDF HTML is built. Candidate values are HTML-escaped.
- UTF-8 charset, Vietnamese language metadata, and DejaVu/Noto/Arial font fallbacks are preserved.

## Files changed

### Engine and security

- `src/lib/document-merge/html-renderer.ts`
- `src/lib/document-merge/html-pipeline.ts`
- `src/lib/document-merge/placeholder-extractor.ts`
- `src/lib/document-merge/template-contract.ts` (new)
- `src/lib/document-merge/async-job.ts`
- `src/lib/document-merge/index.ts`

### Canonical template / registration

- `src/document-templates/dang-ky-tap-nghe/template.ts`
- `src/document-templates/dang-ky-tap-nghe/schema.ts`
- `src/document-templates/registry.ts`

### Integration

- `src/app/api/document-merge/jobs/route.ts`
- `src/app/api/document-merge/preview/route.ts`
- `src/components/document-merge/merge-workspace.tsx`
- `worker/src/index.ts`
- `worker/scripts/generate-template-sample.mjs`
- `worker/scripts/visual-verify.mjs`
- `worker/package.json`

### Tests

- `src/lib/document-merge/placeholder-extractor.test.ts` (new)
- `src/lib/document-merge/html-renderer.test.ts`
- `src/lib/document-merge/html-pipeline.test.ts`
- `src/lib/document-merge/async-job.test.ts`
- `src/document-templates/dang-ky-tap-nghe/template.test.ts`
- `src/app/api/document-merge/preview/route.test.ts`
- `worker/src/html-pdf-render.test.ts` (new Playwright/PDF integration test)

## Automated coverage

The tests cover:

- both `{{...}}` and legacy `<<...>>` replacement;
- missing required DB/contract values and unmapped placeholders;
- HTML escaping of untrusted candidate input;
- checkbox rendering as `☒`/`☐`;
- Vietnamese Unicode;
- long Vietnamese text/table wrapping CSS;
- preview-only UI stripping;
- canonical field-contract coverage (49 fields); 
- explicit HTML/PDF selection, published-version requirement, queue snapshot, frozen merge clock;
- A4 size, two logical-page pagination, and valid PDF bytes through Playwright when the browser binary is available.

## Quality-gate results

| Gate | Result |
| --- | --- |
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS** |
| `npm run lint` | **PASS with 52 warnings, 0 errors** |
| `npm test` | **PASS — 934 tests, 0 failures** |
| `npm --prefix worker run typecheck` | **PASS** |
| `npm --prefix worker run test` | **PASS, 1 skipped** because this sandbox has no Playwright Chromium binary |
| `git diff --check` | **PASS** |

## Staging verification

The protected staging command was attempted with `STAGING_E2E_CONFIRM=1`, but it stopped before any records were read or changed because the required staging `DATABASE_URL` was unavailable. The script also requires a staging-only worker URL, worker secret, and Drive credentials. No attempt was made to create or alter production/staging data manually.

Once staging credentials are available, run the existing protected verification:

```bash
STAGING_E2E_CONFIRM=1 \
DATABASE_URL='staging-only URL' \
MERGE_WORKER_URL='staging worker URL' \
MERGE_WORKER_SECRET='staging secret' \
STORAGE_PROVIDER=google_drive \
GOOGLE_DRIVE_ROOT_FOLDER_ID='staging folder' \
node --import tsx scripts/staging-e2e.mjs --records 1

# Repeat the batch path:
node --import tsx scripts/staging-e2e.mjs --records 10
```

For an approved visual source, run the existing production-stack visual harness with an explicit expected PDF page count:

```bash
npm --prefix worker run verify:visual -- \
  --html path/to/test.html --expected-pages <approved-page-count> \
  --out /tmp/html-template-visual
```

## Remaining blockers

1. The referenced `test.html` was not present in this checkout or supplied attachment area (repository search found no file by that name). The implementation uses the existing registered Vietnamese canonical template as the code source and supports the requested `{{...}}` syntax. A visual pixel-signoff against the actual supplied `test.html` still requires that file.
2. This sandbox could not download Playwright Chromium (`ECONNRESET` from the browser CDN), so the real Chromium integration test is correctly skipped locally. It is executable in the existing Playwright Cloud Run image.
3. No staging-only credentials/endpoints are available in the sandbox, so the protected 1-record/10-record staging E2E could not be run. No production changes were attempted.

No branch was merged to `main`, and no production data/database was modified.
