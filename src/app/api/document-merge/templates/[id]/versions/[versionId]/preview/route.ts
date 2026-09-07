/**
 * POST /api/document-merge/templates/[id]/versions/[versionId]/preview
 *
 * DRAFT VERSION PREVIEW — read-only visual verification of ONE explicitly
 * addressed template version (typically a DRAFT such as v8) rendered with ONE
 * real candidate, BEFORE anybody publishes it.
 *
 * WHAT THIS ROUTE MUST NEVER DO (and provably does not — see route.test.ts):
 *   - publish anything (`publishTemplateVersion` is not imported here);
 *   - change merge_templates.current_published_version;
 *   - populate merge_template_versions.mapping_snapshot;
 *   - create a merge job / merge_job_records / document_history row;
 *   - modify candidate data or merge_template_fields;
 *   - archive/rollback another version;
 *   - call Google Docs/Drive, the Cloud Run worker, email or any external side.
 * It issues SELECTs only.
 *
 * VERSION SEMANTICS
 *   - The version is loaded BY ITS OWN ID **and** template id from the URL path.
 *     `current_published_version` is never consulted, so a DRAFT preview shows
 *     the draft and nothing else.
 *   - Mapping resolution follows `selectPreviewMappings`: a published version
 *     keeps its immutable frozen mapping_snapshot; a DRAFT (snapshot = [])
 *     resolves the CURRENT non-orphaned merge_template_fields — the very set
 *     pre-publish coverage validation checks. Published immutability is intact.
 *
 * SECURITY
 *   - authentication + Admin RBAC via requirePermission(["ADMIN"], …);
 *   - templateId/versionId come from the PATH and are cross-checked in SQL
 *     (version.templateId = :id), so a client cannot preview another template's
 *     version;
 *   - the candidate is re-loaded server-side and filtered by the caller's Data
 *     Scope (getUserScope) — a client-supplied applicationId outside the scope
 *     is rejected with 404, never rendered;
 *   - state-changing verb is POST with a same-site session cookie (SameSite=Lax)
 *     and a JSON content type, matching every other mutation-shaped route here;
 *     no GET side effects exist.
 */

import { NextResponse } from "next/server";
import { getUserScope, requirePermission } from "@/lib/auth";
import { countCanonicalPages } from "@/lib/document-merge/canonical-document";
import {
  PreviewResolutionError,
  isCanonicalTemplateError,
  CANONICAL_ACTION_VI,
  resolveTemplateVersionPreview,
} from "@/lib/document-merge/preview-render";
import {
  DRAFT_PREVIEW_BANNER_VI,
  DRAFT_PREVIEW_MODE,
  parseDraftPreviewRequest,
} from "@/lib/document-merge/draft-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(request: Request, context: RouteContext) {
  // Layer 1+2: authenticated session, ADMIN role, template-management permission.
  const guard = await requirePermission(["ADMIN"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const { id: templateId, versionId } = await context.params;
    const parsed = parseDraftPreviewRequest(await request.json().catch(() => ({})));
    if (!parsed.ok) {
      return NextResponse.json(parsed.error, { status: 400 });
    }
    const { applicationId, signingContext } = parsed.value;

    const scope = await getUserScope(guard.session);
    const resolved = await resolveTemplateVersionPreview({
      templateId,
      versionId,
      applicationId,
      signingContext,
      session: guard.session,
      scope,
    });
    const { template, version, rendered, mappingSource, mappingSummary, unpublished, fullName, cccd } = resolved;

    return NextResponse.json({
      mode: DRAFT_PREVIEW_MODE,
      banner: unpublished ? DRAFT_PREVIEW_BANNER_VI : null,
      isPublishedCanonical: !unpublished,
      publishCalled: false,
      jobCreated: false,
      templateId,
      templateName: template.name,
      templateKind: template.documentKind,
      versionId: version.id,
      version: version.version,
      templateVersion: rendered.templateVersion,
      versionStatus: version.status,
      // Proof for the operator that the preview did not read the published
      // pointer: the rendered version number is independent of this value.
      currentPublishedVersion: template.currentPublishedVersion ?? null,
      mappingSource,
      mappingSnapshotCount: resolved.mappingSnapshotCount,
      mappingSummary,
      renderedHtml: rendered.html,
      printCss: rendered.printCss,
      // Phase 5 — same margin config the final PDF uses (frozen in the
      // snapshot), so the operator's on-screen preview guide matches exactly.
      margins: rendered.margins,
      // H3 — echo back exactly what Signing Context this render used, so the
      // operator can see it was applied (never silently defaulted/guessed).
      signingContext,
      engine: "HTML_PDF",
      renderer: "renderCanonicalDocument (shared Preview + HTML_PDF worker renderer)",
      applicationId,
      recordId: applicationId,
      fullName,
      cccd,
      unresolved: rendered.unreplaced,
      unreplaced: rendered.unreplaced,
      missingFields: rendered.missingFields,
      valid: rendered.valid,
      pageCount: countCanonicalPages(rendered.html),
      note: unpublished
        ? `${DRAFT_PREVIEW_BANNER_VI} — phiên bản ${version.status} chỉ dùng để kiểm tra trực quan. Job production vẫn dùng phiên bản đã XUẤT BẢN.`
        : "Đang xem phiên bản đã XUẤT BẢN — đúng nội dung mà worker HTML_PDF sẽ in.",
    });
  } catch (error) {
    if (error instanceof PreviewResolutionError) {
      return NextResponse.json(
        { code: error.code, error: error.message, action: error.action, templateId: error.templateId },
        { status: error.status },
      );
    }
    if (isCanonicalTemplateError(error)) {
      return NextResponse.json(
        {
          code: error.code,
          error: error.operatorMessage,
          action: error.action ?? CANONICAL_ACTION_VI,
          templateId: error.templateId,
        },
        { status: 422 },
      );
    }
    console.error("[document-merge/templates/[id]/versions/[versionId]/preview] error:", error);
    return NextResponse.json(
      {
        code: "DRAFT_PREVIEW_FAILED",
        error: "Không tạo được bản xem trước.",
        action: "Kiểm tra nội dung HTML của phiên bản và mapping của mẫu rồi thử lại.",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
