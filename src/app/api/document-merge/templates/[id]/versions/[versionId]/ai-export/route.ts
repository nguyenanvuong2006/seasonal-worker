/**
 * GET /api/document-merge/templates/[id]/versions/[versionId]/ai-export
 *
 * H1 — AI TEMPLATE EXPORT. Downloads a ZIP package (template.html, print.css,
 * template-manifest.json, README-AI.md) for ONE explicitly addressed template
 * version, so an operator can hand it to an AI (ChatGPT/Claude/Arena) for a
 * revision, then paste the result back and Analyze it before ever saving.
 *
 * READ-ONLY — SELECT ONLY. This route:
 *   - never writes to the database (no INSERT/UPDATE/DELETE, no audit write —
 *     matches the existing draft-preview route's own precedent of not
 *     auditing read-only inspection actions);
 *   - never publishes, clones, or mutates any version;
 *   - never touches candidate/applicant tables (dailyApplications,
 *     workerProfiles) — the package is built ENTIRELY from
 *     merge_templates / merge_template_versions / merge_template_fields,
 *     so it cannot contain candidate PII by construction.
 *
 * MAPPING SEMANTICS (unchanged, PR #99/#101 architecture): reuses
 * selectPreviewMappings — a PUBLISHED version's export reflects its frozen
 * mapping_snapshot; a DRAFT's reflects the current non-orphaned
 * merge_template_fields.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { mergeTemplateFields, mergeTemplates, mergeTemplateVersions } from "@/db/schema";
import { selectPreviewMappings } from "@/lib/document-merge/draft-preview";
import { buildTemplateManifest, buildAiExportFiles, buildAiExportZip } from "@/lib/document-merge/ai-template-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

function safeFileNameSegment(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "template";
}

export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id: templateId, versionId } = await context.params;

  const [template] = await db.select().from(mergeTemplates).where(eq(mergeTemplates.id, templateId)).limit(1);
  if (!template) {
    return NextResponse.json({ error: "Không tìm thấy mẫu tài liệu." }, { status: 404 });
  }

  const [version] = await db
    .select()
    .from(mergeTemplateVersions)
    .where(and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)))
    .limit(1);
  if (!version) {
    return NextResponse.json({ error: "Không tìm thấy phiên bản này trong mẫu tài liệu đã chọn." }, { status: 404 });
  }
  if (!version.htmlBody || version.htmlBody.trim().length === 0) {
    return NextResponse.json({ error: "Phiên bản này chưa có nội dung HTML để xuất gói AI." }, { status: 400 });
  }

  const fields = await db
    .select()
    .from(mergeTemplateFields)
    .where(and(eq(mergeTemplateFields.templateId, templateId), eq(mergeTemplateFields.isOrphaned, false)));

  const { mappings, source } = selectPreviewMappings(version, fields);

  const manifest = buildTemplateManifest({
    templateId,
    templateName: template.name,
    documentKind: template.documentKind,
    version: version.version,
    status: version.status,
    htmlBody: version.htmlBody,
    mappings,
    mappingSource: source,
  });

  const files = buildAiExportFiles(manifest, version.htmlBody, version.printCss ?? "");
  const zipBuffer = await buildAiExportZip(files);

  const filename = `${safeFileNameSegment(template.name)}-v${version.version}-ai-package.zip`;

  return new NextResponse(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(zipBuffer.length),
      "Cache-Control": "no-store",
    },
  });
}
