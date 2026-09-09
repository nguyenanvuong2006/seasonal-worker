/**
 * READ-ONLY diagnosis of Defect 4 (2026-09): "Template này chưa được bật
 * chế độ HTML/PDF." blocks candidate-document generation for DW cũ.
 *
 * Traces the EXACT gate createAsyncMergeJob() enforces
 * (src/lib/document-merge/async-job.ts line ~175: `if (engine ===
 * "HTML_PDF" && !forced.htmlEnabled) throw ...`) against the REAL
 * production DW cũ template row — never assumes template/version ids from
 * an earlier mission are still current.
 *
 * SAFETY: zero writes. Only SELECTs mergeTemplates + mergeTemplateVersions.
 *
 * Cách dùng:
 *   DATABASE_URL=... node --import tsx scripts/diagnose-dw-old-template-eligibility.ts
 */
import { db, pool } from "../src/db/index.ts";
import { mergeTemplates, mergeTemplateVersions } from "../src/db/schema.ts";
import { eq, or, ilike } from "drizzle-orm";
import { getDocumentMergeEngine } from "../src/lib/document-merge/engine-config.ts";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  const engine = getDocumentMergeEngine();
  log("resolved_engine", { engine });

  // documentKind 'A' = DW cũ per schema.ts's own comment; also try a name-based
  // match since the mission's known template id/name may be stale.
  const candidates = await db
    .select()
    .from(mergeTemplates)
    .where(or(eq(mergeTemplates.documentKind, "A"), ilike(mergeTemplates.name, "%DW c%")));

  log("dw_old_candidate_templates_found", { count: candidates.length });

  for (const tpl of candidates) {
    log("TEMPLATE_ROW", {
      id: tpl.id,
      name: tpl.name,
      documentKind: tpl.documentKind,
      isActive: tpl.isActive,
      htmlEnabled: tpl.htmlEnabled,
      currentPublishedVersion: tpl.currentPublishedVersion,
      defaultMergeMode: tpl.defaultMergeMode,
    });

    if (tpl.currentPublishedVersion == null) {
      log("NO_PUBLISHED_VERSION", { templateId: tpl.id });
      continue;
    }

    const [publishedVersion] = await db
      .select()
      .from(mergeTemplateVersions)
      .where(eq(mergeTemplateVersions.templateId, tpl.id))
      .then((rows) => rows.filter((r) => r.version === tpl.currentPublishedVersion));

    if (!publishedVersion) {
      log("PUBLISHED_VERSION_ROW_MISSING", { templateId: tpl.id, currentPublishedVersion: tpl.currentPublishedVersion });
      continue;
    }

    log("PUBLISHED_VERSION_ROW", {
      templateId: tpl.id,
      version: publishedVersion.version,
      status: publishedVersion.status,
      htmlBodyPresent: Boolean(publishedVersion.htmlBody && publishedVersion.htmlBody.trim().length > 0),
      htmlBodyLength: publishedVersion.htmlBody?.length ?? 0,
      printCssPresent: Boolean(publishedVersion.printCss && publishedVersion.printCss.trim().length > 0),
      printCssLength: publishedVersion.printCss?.length ?? 0,
      mappingCount: Array.isArray(publishedVersion.mappingSnapshot) ? publishedVersion.mappingSnapshot.length : 0,
      publishedAt: publishedVersion.publishedAt,
    });

    // The EXACT eligibility question createAsyncMergeJob() asks.
    const wouldBeEligibleForHtmlPdf = tpl.isActive && tpl.htmlEnabled;
    const hasRealHtmlContent = Boolean(publishedVersion.htmlBody && publishedVersion.htmlBody.trim().length > 0);

    log("ELIGIBILITY_VERDICT", {
      templateId: tpl.id,
      isActive: tpl.isActive,
      htmlEnabled: tpl.htmlEnabled,
      publishedVersionHasHtmlContent: hasRealHtmlContent,
      wouldBeEligibleForHtmlPdfGeneration: wouldBeEligibleForHtmlPdf,
      // This is the precise signature of root cause (B): metadata false
      // while real content already exists — a targeted metadata fix (no new
      // version, no content regeneration) would be safe and sufficient.
      metadataOnlyMismatch: !tpl.htmlEnabled && hasRealHtmlContent && tpl.isActive,
    });
  }

  // Cross-check: DW mới (documentKind 'B') must remain untouched/unaffected
  // by this diagnosis — read-only confirmation of its current state only.
  const dwNew = await db.select().from(mergeTemplates).where(eq(mergeTemplates.documentKind, "B"));
  for (const tpl of dwNew) {
    log("DW_NEW_REFERENCE_TEMPLATE", {
      id: tpl.id,
      name: tpl.name,
      isActive: tpl.isActive,
      htmlEnabled: tpl.htmlEnabled,
      currentPublishedVersion: tpl.currentPublishedVersion,
    });
  }

  await pool.end();
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "fatal_error", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
