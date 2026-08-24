# PHASE 1 — TEMPLATE SOURCE INVENTORY REPORT
# Document: "Đăng ký tập nghề - Quy định tập nghề"
# Date: 2026-08-24
# Operator instruction: Destructive cleanup authorized for obsolete templates only

## REPOSITORY TEMPLATE SOURCES FOUND

### Authoring Source (APPROVED)
- Path: templates/document-merge/trainee-registration/canonical-source.html
- Size: 52808 bytes (48071 bytes content)
- Page count (class="page"): 5
- Placeholder count: 49
- SHA256: 22e987f76ff0100f8a7a3f9c6fcda72f1465bbf353f909664d923eed41343bd2
- Status: Authoring source (test.html was renamed to this)
- Note: Manifest claims logicalPageCount=6 (derived from approved pipeline)

### Manifest
- Path: templates/document-merge/trainee-registration/canonical-source.manifest.json
- canonicalBodySha256: 7fa929541c05100e51c76c20da72dc863e3dfdfac3b95f2c90d662be9115ae7f
- logicalPageCount: 6
- placeholderCount: 49

### Migration Bodies
1. migrations/2026-08-23-trainee-registration-canonical-html-draft.sql
   - Contains 6-page canonical body (DRAFT)
   - Source SHA: 22e987f76ff0100f8a7a3f9c6fcda72f1465bbf353f909664d923eed41343bd2
   - Canonical body SHA: 7fa929541c05100e51c76c20da72dc863e3dfdfac3b95f2c90d662be9115ae7f
   - Status: DRAFT version

2. migrations/2026-08-21-dang-ky-tap-nghe-html-draft.sql
   - 5-page obsolete body (TOMBSTONE - body removed)
   - Status: Historical, body stripped

3. migrations/2026-08-15-document-merge-engine.sql
   - Initial seed for "Đăng ký tập nghề - Quy định tập nghề"
   - Contains template metadata only (no full body in current state)

### Legacy/Obsolete References (to be removed)
- src/document-templates/dang-ky-tap-nghe/ (directory with test.ts only)
- src/lib/document-merge/canonical-document.test.ts references test.html (historical)
- docs/ various reports mentioning test.html (historical)
- .github/workflows references (historical)

### Runtime Code (current state)
- src/lib/document-merge/canonical-document.ts — canonical renderer
- src/lib/document-merge/canonical-sync.ts — sync logic
- src/app/api/document-merge/* — API routes
- worker/src/* — Cloud Run worker

### Catalog/Registry
- src/document-templates/registry.ts — METADATA ONLY (no HTML body)
- src/document-templates/dang-ky-tap-nghe/template.test.ts — test only

## DATABASE-RELATED (REPO ONLY)
- schema.sql
- drizzle.config.json
- All migrations in /migrations/

## OBSOLETE 10-PAGE BODY
- TEN_PAGE_BODY_FOUND=NO
- No 10-page body found in repository
- Reference found only in benchmark-harness.ts (test fixture, not production body)

## SUMMARY COUNTS (REPO)
OLD_TEMPLATE_COUNT=3 (different migration seeds + legacy modules)
OLD_VERSION_COUNT=multiple historical in migrations
OLD_BODY_COUNT=2 (one 5-page obsolete, one 6-page canonical)
TEN_PAGE_BODY_FOUND=no
TEN_PAGE_BODY_SHA=N/A
TEN_PAGE_BODY_SOURCE=N/A

## TEST.HTML STATUS
TEST_HTML_EXISTS=no (renamed to canonical-source.html)
The operator instruction references "test.html" — the approved authoring source is now canonical-source.html (the file previously known as test.html).

## NEXT STEPS REQUIRED
- Phase 2: Normalize canonical-source.html → verify 6 pages, 49 placeholders
- Create deterministic normalization function if needed
- Phase 3: Remove all legacy runtime bodies completely
- Phase 4-5: Create cleanup migration + rebuild canonical state
