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
import { and, eq, isNull } from "drizzle-orm";
import { getUserScope, requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  dailyApplications,
  mergeTemplateFields,
  mergeTemplates,
  mergeTemplateVersions,
} from "@/db/schema";
import {
  buildCanonicalSnapshot,
  CANONICAL_ACTION_VI,
  countCanonicalPages,
  isCanonicalTemplateError,
  renderCanonicalDocument,
} from "@/lib/document-merge/canonical-document";
import { loadDailyApplicationRecords } from "@/lib/document-merge/record-loader";
import { getHtmlTemplateContractByGoogleDocId } from "@/document-templates/registry";
import type { MergeContext } from "@/lib/document-merge/data-resolver";
import {
  DRAFT_PREVIEW_BANNER_VI,
  DRAFT_PREVIEW_MODE,
  isUnpublishedPreview,
  parseDraftPreviewRequest,
  isCandidateInScope,
  selectPreviewMappings,
  summarizePreviewMappings,
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

    const [template] = await db
      .select()
      .from(mergeTemplates)
      .where(eq(mergeTemplates.id, templateId))
      .limit(1);
    if (!template) {
      return NextResponse.json(
        {
          code: "TEMPLATE_NOT_FOUND",
          error: "Không tìm thấy mẫu tài liệu.",
          action: "Tải lại danh sách mẫu và thử lại.",
        },
        { status: 404 },
      );
    }

    // Load the EXACT version requested — by id AND template id. Never by
    // merge_templates.current_published_version.
    const [version] = await db
      .select()
      .from(mergeTemplateVersions)
      .where(
        and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)),
      )
      .limit(1);
    if (!version) {
      return NextResponse.json(
        {
          code: "VERSION_NOT_FOUND",
          error: "Không tìm thấy phiên bản này trong mẫu tài liệu đã chọn.",
          action: "Tải lại danh sách phiên bản của mẫu và chọn lại.",
        },
        { status: 404 },
      );
    }

    // DATA SCOPE — resolve the candidate through the caller's authorised
    // departments. Out-of-scope ids are indistinguishable from missing ones.
    const scope = await getUserScope(guard.session);
    const [candidate] = await db
      .select({ id: dailyApplications.id, deptId: dailyApplications.deptId })
      .from(dailyApplications)
      .where(and(eq(dailyApplications.id, applicationId), isNull(dailyApplications.deletedAt)))
      .limit(1);
    if (!candidate || !isCandidateInScope(scope, candidate.deptId)) {
      return NextResponse.json(
        {
          code: "APPLICATION_NOT_FOUND",
          error: "Không tìm thấy ứng viên trong phạm vi dữ liệu của bạn.",
          action: "Tìm lại ứng viên bằng ô tìm kiếm trong hộp thoại xem trước.",
        },
        { status: 404 },
      );
    }

    // Current non-orphaned mapping — the same set pre-publish validation reads.
    const fields = await db
      .select()
      .from(mergeTemplateFields)
      .where(and(eq(mergeTemplateFields.templateId, templateId), eq(mergeTemplateFields.isOrphaned, false)));

    const { mappings, source: mappingSource } = selectPreviewMappings(version, fields);
    if (mappings.length === 0) {
      return NextResponse.json(
        {
          code: "MAPPING_MISSING",
          error: `Mẫu “${template.name}” chưa có placeholder mapping đang hoạt động.`,
          action: "Mở Mapping Inspector, kiểm tra mapping rồi tạo lại bản xem trước.",
          templateId,
          templateName: template.name,
        },
        { status: 422 },
      );
    }

    // Same loader the HTML_PDF worker uses — preview data cannot drift.
    const records = await loadDailyApplicationRecords([applicationId]);
    const recordData = records.get(applicationId);
    if (!recordData) {
      return NextResponse.json(
        {
          code: "APPLICATION_NOT_FOUND",
          error: "Không tìm thấy hồ sơ ứng viên.",
          action: "Tìm lại ứng viên rồi thử lại.",
        },
        { status: 404 },
      );
    }

    const previewContext: MergeContext = {
      currentUserId: guard.session.id,
      currentUserName: guard.session.fullName,
      currentDate: new Date(),
      mergeIndex: 1,
      mergeCount: 1,
      // H3 — resolved ONCE for this Preview call, exactly like a merge job
      // freezes it once for the whole batch (see async-job.ts).
      signingContext,
    };

    // Build the SAME immutable snapshot shape a job freezes and render it with
    // the SAME canonical renderer the worker uses — preview never reconstructs
    // the document. `allowUnpublishedForVerification` relaxes ONLY the
    // PUBLISHED status gate, and only on this read-only path.
    const snapshot = buildCanonicalSnapshot({
      templateId,
      version,
      allowUnpublishedForVerification: true,
      mappings,
      formatting: {
        contractKey: template.googleDocId,
        retentionYears: version.retentionYears ?? null,
        documentKind: template.documentKind,
        templateName: template.name,
      },
    });

    const rendered = renderCanonicalDocument(snapshot, recordData, previewContext, {
      contract: getHtmlTemplateContractByGoogleDocId(template.googleDocId),
    });

    const unpublished = isUnpublishedPreview(version);
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
      mappingSnapshotCount: Array.isArray(version.mappingSnapshot) ? version.mappingSnapshot.length : 0,
      mappingSummary: summarizePreviewMappings(mappings),
      renderedHtml: rendered.html,
      printCss: snapshot.printCss,
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
      fullName: typeof recordData.fullName === "string" ? recordData.fullName : undefined,
      cccd: typeof recordData.cccd === "string" ? recordData.cccd : undefined,
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
