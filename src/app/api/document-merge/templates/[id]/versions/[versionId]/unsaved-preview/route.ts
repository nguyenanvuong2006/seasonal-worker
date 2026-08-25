/**
 * POST /api/document-merge/templates/[id]/versions/[versionId]/unsaved-preview
 *
 * H2 — UNSAVED HTML PREVIEW. An operator has pasted a COMPLETE AI-revised HTML
 * document (or edited the split HTML/CSS boxes) and wants to see it rendered
 * with a REAL candidate's data — line wrapping, table growth, signature area,
 * long-address behaviour — BEFORE any of it is written to the DRAFT. This is
 * the mandatory step between Analyze and Apply (Phase 6/7 of the H2 mission):
 * Paste -> Analyze -> Preview -> Apply, never Paste -> Save -> discover a
 * problem later.
 *
 * Body: { applicationId: string, rawHtml: string, explicitCss?: string }
 *   - rawHtml/explicitCss are the CANDIDATE content the operator is about to
 *     apply — normalized the SAME way Analyze normalizes it (same
 *     full-document-normalizer.ts), so what the operator previewed is
 *     byte-identical to what Apply would write, never a re-derived guess.
 *
 * WHAT THIS ROUTE PROVABLY DOES NOT DO (mirrors the saved DRAFT preview route
 * at ../preview/route.ts, and is proven by route.test.ts's zero-DB-write /
 * zero-side-effect assertions):
 *   - ZERO database writes of any kind (SELECT only);
 *   - creates NO merge job, NO merge_job_records, NO document_history row;
 *   - never publishes, never touches current_published_version;
 *   - never mutates merge_template_fields or mapping_snapshot — mapping
 *     resolution reuses selectPreviewMappings() against the REAL, persisted
 *     version row, exactly like the saved preview route, so previewing
 *     unsaved HTML can never itself change what mappings apply.
 *
 * The pasted content is a VIRTUAL version: the real DB version row is loaded
 * (for id+templateId cross-checking, status, and mapping resolution) but its
 * htmlBody/printCss are overridden with the normalized pasted content before
 * being handed to the SAME canonical renderer
 * (buildCanonicalSnapshot/renderCanonicalDocument) the saved preview route
 * and the Cloud Run HTML_PDF worker use — this route does not build an
 * alternative renderer.
 *
 * SECURITY
 *   - ADMIN + HR_RECRUITER, "document_merge.templates.manage" (same policy as
 *     H1's ai-analyze/ai-export routes — this is a continuation of that
 *     operator-facing workflow, not the ADMIN-only saved-preview route);
 *   - templateId/versionId come from the PATH and are cross-checked in SQL;
 *   - the candidate is re-loaded server-side and filtered by the caller's
 *     Data Scope — an out-of-scope applicationId is rejected with 404;
 *   - hard security failures in the pasted content (script tags, inline
 *     handlers, javascript: URLs, unsafe embeds, dangerous CSS) block the
 *     preview render — defense in depth on top of the sandboxed iframe the
 *     client renders this HTML into, never trusting a client-side Analyze
 *     result alone.
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
  isCandidateInScope,
  selectPreviewMappings,
  summarizePreviewMappings,
} from "@/lib/document-merge/draft-preview";
import { normalizeFullHtmlDocument } from "@/lib/document-merge/full-document-normalizer";
import { analyzeTemplateSecurity } from "@/lib/document-merge/ai-template-security";
import { computeAnalysisHash } from "@/lib/document-merge/analysis-hash";
import { buildUnresolvedPlaceholderWarning } from "@/lib/document-merge/unresolved-placeholder-guard";
import { parseSigningContext } from "@/lib/document-merge/signing-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export const UNSAVED_PREVIEW_MODE = "UNSAVED_HTML_PREVIEW" as const;

const MAX_HTML_LENGTH = 2_000_000;
const MAX_CSS_LENGTH = 500_000;

export async function POST(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const { id: templateId, versionId } = await context.params;
    const body = (await request.json().catch(() => null)) as
      | { applicationId?: unknown; rawHtml?: unknown; explicitCss?: unknown; signingContext?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Request body phải là JSON." }, { status: 400 });
    }
    const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";
    const rawHtml = typeof body.rawHtml === "string" ? body.rawHtml : "";
    const explicitCss = typeof body.explicitCss === "string" ? body.explicitCss : "";
    const signingContextResult = parseSigningContext(body.signingContext);
    if (!signingContextResult.ok) {
      return NextResponse.json(
        { code: "SIGNING_CONTEXT_INVALID", error: signingContextResult.error, action: "Kiểm tra lại Ngày ký / Địa điểm ký rồi thử lại." },
        { status: 400 },
      );
    }
    const signingContext = signingContextResult.context;

    if (!applicationId) {
      return NextResponse.json(
        {
          code: "APPLICATION_REQUIRED",
          error: "Thiếu ứng viên để tạo bản xem trước.",
          action: "Tìm và chọn một ứng viên có thật rồi bấm “Xem trước với dữ liệu thật”.",
        },
        { status: 400 },
      );
    }
    if (!rawHtml.trim()) {
      return NextResponse.json({ error: "Thiếu nội dung HTML để xem trước." }, { status: 400 });
    }
    if (rawHtml.length > MAX_HTML_LENGTH || explicitCss.length > MAX_CSS_LENGTH) {
      return NextResponse.json({ error: "Nội dung HTML/CSS vượt quá giới hạn cho phép." }, { status: 413 });
    }

    const [template] = await db.select().from(mergeTemplates).where(eq(mergeTemplates.id, templateId)).limit(1);
    if (!template) {
      return NextResponse.json(
        { code: "TEMPLATE_NOT_FOUND", error: "Không tìm thấy mẫu tài liệu.", action: "Tải lại danh sách mẫu và thử lại." },
        { status: 404 },
      );
    }

    // Load the EXACT version requested — by id AND template id. Never by
    // merge_templates.current_published_version. This version supplies
    // mapping resolution + status/id context only; its persisted
    // htmlBody/printCss are never rendered here — see the virtual-version
    // substitution below.
    const [version] = await db
      .select()
      .from(mergeTemplateVersions)
      .where(and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)))
      .limit(1);
    if (!version) {
      return NextResponse.json(
        { code: "VERSION_NOT_FOUND", error: "Không tìm thấy phiên bản này trong mẫu tài liệu đã chọn.", action: "Tải lại danh sách phiên bản của mẫu và chọn lại." },
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
        { code: "APPLICATION_NOT_FOUND", error: "Không tìm thấy ứng viên trong phạm vi dữ liệu của bạn.", action: "Tìm lại ứng viên bằng ô tìm kiếm trong hộp thoại xem trước." },
        { status: 404 },
      );
    }

    // Normalize the pasted content the SAME way Analyze does — what the
    // operator previews here is exactly what Apply would write.
    const normalized = normalizeFullHtmlDocument(rawHtml);
    const normalizedPrintCss = [explicitCss, normalized.extractedCss]
      .filter((chunk): chunk is string => Boolean(chunk && chunk.trim()))
      .join("\n\n");

    // Defense in depth: never render pasted content into the operator's
    // browser (even inside a sandboxed iframe) if it fails hard security
    // checks — the browser-side Analyze result is never trusted alone.
    const security = analyzeTemplateSecurity(normalized.htmlBody, normalizedPrintCss);
    if (security.errors.length > 0) {
      return NextResponse.json(
        {
          code: "SECURITY_BLOCKED",
          error: "Nội dung HTML/CSS chứa mã không an toàn — không thể tạo bản xem trước.",
          action: "Xoá các thẻ/kiểu không an toàn (script, sự kiện inline, javascript:, iframe/object/embed, CSS expression) rồi thử lại.",
          security,
        },
        { status: 422 },
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

    const records = await loadDailyApplicationRecords([applicationId]);
    const recordData = records.get(applicationId);
    if (!recordData) {
      return NextResponse.json(
        { code: "APPLICATION_NOT_FOUND", error: "Không tìm thấy hồ sơ ứng viên.", action: "Tìm lại ứng viên rồi thử lại." },
        { status: 404 },
      );
    }

    const previewContext: MergeContext = {
      currentUserId: guard.session.id,
      currentUserName: guard.session.fullName,
      currentDate: new Date(),
      mergeIndex: 1,
      mergeCount: 1,
      // H3 — resolved ONCE for this unsaved Preview call, same as the
      // persisted Preview route and exactly what Apply/a merge job would
      // freeze — never re-derived per placeholder.
      signingContext,
    };

    // VIRTUAL VERSION — the real, persisted version row with its body/CSS
    // overridden by the UNSAVED pasted content. Nothing about this object is
    // written back to the database; it only satisfies buildCanonicalSnapshot's
    // shape so the SAME canonical renderer can be reused for unsaved content.
    const virtualVersion = { ...version, htmlBody: normalized.htmlBody, printCss: normalizedPrintCss };

    const snapshot = buildCanonicalSnapshot({
      templateId,
      version: virtualVersion,
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

    return NextResponse.json({
      mode: UNSAVED_PREVIEW_MODE,
      mutated: false,
      publishCalled: false,
      jobCreated: false,
      templateId,
      templateName: template.name,
      templateKind: template.documentKind,
      versionId: version.id,
      version: version.version,
      versionStatus: version.status,
      currentPublishedVersion: template.currentPublishedVersion ?? null,
      mappingSource,
      mappingSummary: summarizePreviewMappings(mappings),
      normalizedHtmlBody: normalized.htmlBody,
      normalizedPrintCss,
      normalizationWarnings: normalized.warnings.filter((w) => w.code !== "EXTERNAL_STYLESHEET_IGNORED"),
      externalResourceWarnings: normalized.warnings.filter((w) => w.code === "EXTERNAL_STYLESHEET_IGNORED"),
      analysisHash: computeAnalysisHash(normalized.htmlBody, normalizedPrintCss),
      renderedHtml: rendered.html,
      printCss: snapshot.printCss,
      signingContext,
      applicationId,
      recordId: applicationId,
      fullName: typeof recordData.fullName === "string" ? recordData.fullName : undefined,
      cccd: typeof recordData.cccd === "string" ? recordData.cccd : undefined,
      unresolved: rendered.unreplaced,
      unreplaced: rendered.unreplaced,
      missingFields: rendered.missingFields,
      valid: rendered.valid,
      // DEFECT A FIX: a literal <<placeholder>> can only survive rendering
      // when it has genuinely NO mapping row (see
      // unsaved-preview-resolution.test.ts) — this is never silently hidden;
      // it is turned into ONE clear, reusable operator-facing message shared
      // with unsaved-print (Phase 3/4).
      unresolvedPlaceholderWarning: buildUnresolvedPlaceholderWarning(rendered.unreplaced),
      pageCount: countCanonicalPages(rendered.html),
      note: "Bản xem trước CHƯA LƯU — chưa ghi vào bản nháp, chưa xuất bản. Bấm “Áp dụng vào bản nháp” để lưu nội dung này.",
    });
  } catch (error) {
    if (isCanonicalTemplateError(error)) {
      return NextResponse.json(
        { code: error.code, error: error.operatorMessage, action: error.action ?? CANONICAL_ACTION_VI, templateId: error.templateId },
        { status: 422 },
      );
    }
    console.error("[document-merge/templates/[id]/versions/[versionId]/unsaved-preview] error:", error);
    return NextResponse.json(
      {
        code: "UNSAVED_PREVIEW_FAILED",
        error: "Không tạo được bản xem trước.",
        action: "Kiểm tra nội dung HTML/CSS đã dán rồi thử lại.",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
