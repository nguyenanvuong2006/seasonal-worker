/**
 * POST /api/document-merge/templates/[id]/ai-analyze
 *
 * H1 — READ-ONLY AI TEMPLATE ANALYZE. Given HTML/CSS an operator is about to
 * paste into a DRAFT (e.g. AI-revised content), report the placeholder/
 * mapping/security/layout impact BEFORE anything is saved.
 *
 * Body: { html: string, printCss?: string, baseVersionId?: string }
 *   - html/printCss are the CANDIDATE content, never persisted.
 *   - baseVersionId selects what to diff against. Defaults to the template's
 *     current PUBLISHED version (the artifact production actually renders
 *     today) when omitted; the Designer UI passes the DRAFT being edited so
 *     the operator sees the impact of THIS edit specifically.
 *
 * READ-ONLY — SELECT ONLY, PROVEN BY TEST (route.test.ts / db-writes check):
 *   - no INSERT/UPDATE/DELETE of any kind;
 *   - no version created, no mapping mutated, no snapshot touched;
 *   - no audit write (matches the existing draft-preview route's own
 *     precedent — read-only inspection actions are not audited here);
 *   - never touches candidate/applicant tables.
 *
 * Reuses the EXISTING PR #102 Template Diff Engine (buildTemplateDiff) via
 * ai-template-analyze.ts's analyzeTemplate() — this route does not
 * reimplement or fork that logic, only supplies it with DB-loaded data.
 *
 * H2 — FULL DOCUMENT PASTE: `html` may now be either a bare fragment (the H1
 * "advanced" split html+css mode — unchanged behavior) OR a COMPLETE HTML
 * document (<!DOCTYPE>/<html>/<style>/<body>) as returned verbatim by an AI.
 * full-document-analyze.ts's analyzeFullDocument() (itself a thin wrapper
 * around the UNCHANGED normalizer + analyzeTemplate()) normalizes either
 * shape into {htmlBody, printCss} before analysis runs, and adds
 * normalizationWarnings/externalResourceWarnings/analysisHash to the
 * response. The response also now carries the normalized body/CSS — this is
 * what an Apply call must be able to reproduce (via the same analysisHash)
 * before it is allowed to write to the DRAFT.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { mergeTemplateFields, mergeTemplates, mergeTemplateVersions } from "@/db/schema";
import { TEMPLATE_VERSION_STATUS } from "@/lib/document-merge/template-versions";
import { selectPreviewMappings, toPreviewMappings } from "@/lib/document-merge/draft-preview";
import { analyzeFullDocument } from "@/lib/document-merge/full-document-analyze";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const MAX_HTML_LENGTH = 2_000_000;
const MAX_CSS_LENGTH = 500_000;

export async function POST(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id: templateId } = await context.params;
  const body = (await request.json().catch(() => null)) as
    | { html?: unknown; printCss?: unknown; baseVersionId?: unknown }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body phải là JSON." }, { status: 400 });
  }
  const html = typeof body.html === "string" ? body.html : "";
  const printCss = typeof body.printCss === "string" ? body.printCss : "";
  const baseVersionId = typeof body.baseVersionId === "string" && body.baseVersionId.trim() ? body.baseVersionId.trim() : null;

  if (!html.trim()) {
    return NextResponse.json({ error: "Thiếu nội dung HTML để phân tích." }, { status: 400 });
  }
  if (html.length > MAX_HTML_LENGTH || printCss.length > MAX_CSS_LENGTH) {
    return NextResponse.json({ error: "Nội dung HTML/CSS vượt quá giới hạn cho phép." }, { status: 413 });
  }

  const [template] = await db.select().from(mergeTemplates).where(eq(mergeTemplates.id, templateId)).limit(1);
  if (!template) {
    return NextResponse.json({ error: "Không tìm thấy mẫu tài liệu." }, { status: 404 });
  }

  const baseVersion = baseVersionId
    ? (
        await db
          .select()
          .from(mergeTemplateVersions)
          .where(and(eq(mergeTemplateVersions.id, baseVersionId), eq(mergeTemplateVersions.templateId, templateId)))
          .limit(1)
      )[0]
    : (
        await db
          .select()
          .from(mergeTemplateVersions)
          .where(
            and(
              eq(mergeTemplateVersions.templateId, templateId),
              eq(mergeTemplateVersions.status, TEMPLATE_VERSION_STATUS.PUBLISHED),
            ),
          )
          .limit(1)
      )[0];

  if (!baseVersion) {
    return NextResponse.json(
      {
        error: baseVersionId
          ? "Không tìm thấy phiên bản gốc (baseVersionId) trong mẫu tài liệu đã chọn."
          : "Mẫu tài liệu chưa có phiên bản PUBLISHED để so sánh — hãy chỉ định baseVersionId (ví dụ bản DRAFT đang sửa).",
      },
      { status: baseVersionId ? 404 : 422 },
    );
  }

  const fields = await db
    .select()
    .from(mergeTemplateFields)
    .where(and(eq(mergeTemplateFields.templateId, templateId), eq(mergeTemplateFields.isOrphaned, false)));

  const { mappings: baseMappings, source: baseMappingSource } = selectPreviewMappings(baseVersion, fields);
  // Mappings are never mutated by Analyze — the "current" set is always the
  // SAME live non-orphaned fields, independent of the pasted HTML.
  const currentMappings = toPreviewMappings(fields);

  const result = analyzeFullDocument({
    rawHtml: html,
    explicitCss: printCss,
    baseHtml: baseVersion.htmlBody ?? "",
    baseMappings,
    currentMappings,
  });

  return NextResponse.json({
    mode: "READ_ONLY_ANALYZE",
    mutated: false,
    templateId,
    templateName: template.name,
    baseVersionId: baseVersion.id,
    baseVersion: baseVersion.version,
    baseVersionStatus: baseVersion.status,
    baseMappingSource,
    htmlValid: result.htmlValid,
    htmlIssues: result.htmlIssues,
    cssValid: result.cssValid,
    cssIssues: result.cssIssues,
    placeholders: result.placeholders,
    mappingsAffected: result.mappingsAffected,
    security: result.security,
    layoutWarnings: result.layoutWarnings,
    contentChanges: result.contentChanges,
    diff: {
      summary: result.diff.summary,
      needsAttention: result.diff.needsAttention,
      items: Object.fromEntries(result.diff.items),
    },
    normalizedHtmlBody: result.normalizedHtmlBody,
    normalizedPrintCss: result.normalizedPrintCss,
    normalizationWarnings: result.normalizationWarnings,
    externalResourceWarnings: result.externalResourceWarnings,
    analysisHash: result.analysisHash,
  });
}
