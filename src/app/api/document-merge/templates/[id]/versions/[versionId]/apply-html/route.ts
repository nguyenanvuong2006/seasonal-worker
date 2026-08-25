/**
 * POST /api/document-merge/templates/[id]/versions/[versionId]/apply-html
 *
 * H2 — SAFE APPLY TO DRAFT (Phase 9-14/17 of the H2 mission). The final step
 * of Paste -> Analyze -> Preview -> Apply: after an operator has analyzed and
 * previewed pasted HTML/CSS with real candidate data, this route writes the
 * NORMALIZED content to ONE explicitly addressed DRAFT version — and nothing
 * else.
 *
 * Body: { rawHtml: string, explicitCss?: string, analysisHash: string }
 *   - rawHtml/explicitCss are normalized the SAME way Analyze/Preview do
 *     (full-document-normalizer.ts) — never re-derived, never re-interpreted.
 *   - analysisHash MUST equal a fresh server-side recomputation of
 *     computeAnalysisHash(normalizedHtmlBody, normalizedPrintCss). If the
 *     pasted content changed after the operator's last Analyze call, this is
 *     a controlled 409 (STALE_ANALYSIS) — the browser Analyze result is never
 *     trusted alone (Phase 5/13).
 *
 * WHAT THIS ROUTE MAY WRITE — AND NOTHING ELSE:
 *   ONLY merge_template_versions.html_body / print_css / updated_at, for the
 *   ONE version explicitly addressed by the URL path, via the EXISTING
 *   `updateTemplateVersionDraft` service (template-versions.ts) — reused
 *   verbatim, not reimplemented. That service already provides, atomically:
 *     - cross-template guard (version loaded by id AND templateId — Phase 11);
 *     - DRAFT-only guard, both a pre-check AND `UPDATE ... WHERE status =
 *       'DRAFT'` in the same statement, so a version that left DRAFT between
 *       this route's read and its write is NEVER overwritten (Phase 10/RACE
 *       test item 41);
 *     - it NEVER touches status, mapping_snapshot, merge_template_fields,
 *       current_published_version, published_at, archived_at, superseded_by,
 *       and it NEVER publishes (Phase 9/14 — mapping invariants untouched;
 *       new/removed placeholders are reported but never auto-mapped).
 *
 * SINGLE ACTIVE DRAFT GUARD (Phase 12) — the smallest safe option: if the
 * template currently has MORE THAN ONE DRAFT-status version, Apply fails
 * closed with a clear operator message pointing at the existing Archive
 * action, rather than silently choosing one or deleting anything.
 *
 * SECURITY REVALIDATION (Phase 13) — server reruns well-formedness, CSS
 * validation, security scanning and layout scanning on the NORMALIZED
 * content. Hard security failures (script/inline handler/javascript: URL/
 * unsafe embed/dangerous CSS) BLOCK the write with zero mutation.
 *
 * AUDIT (Phase 17) — on success only, writeAudit("APPLY_TEMPLATE_HTML_DRAFT")
 * with counts and the analysisHash — never the HTML/CSS body, never
 * candidate data (Apply never touches a candidate at all).
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { mergeTemplateFields, mergeTemplates, mergeTemplateVersions } from "@/db/schema";
import {
  TEMPLATE_VERSION_STATUS,
  TemplateVersionError,
  updateTemplateVersionDraft,
} from "@/lib/document-merge/template-versions";
import { normalizeFullHtmlDocument } from "@/lib/document-merge/full-document-normalizer";
import { computeAnalysisHash } from "@/lib/document-merge/analysis-hash";
import { analyzeTemplateSecurity } from "@/lib/document-merge/ai-template-security";
import { analyzeTemplateLayout } from "@/lib/document-merge/ai-template-layout";
import { extractUniquePlaceholders } from "@/lib/document-merge/placeholder-extractor";
import { checkWellFormedness, tokenizeHtml } from "@/lib/document-merge/html-scanner";
import { parseCss } from "@/lib/document-merge/css-scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

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
      | { rawHtml?: unknown; explicitCss?: unknown; analysisHash?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Request body phải là JSON." }, { status: 400 });
    }
    const rawHtml = typeof body.rawHtml === "string" ? body.rawHtml : "";
    const explicitCss = typeof body.explicitCss === "string" ? body.explicitCss : "";
    const clientAnalysisHash = typeof body.analysisHash === "string" ? body.analysisHash.trim() : "";

    if (!rawHtml.trim()) {
      return NextResponse.json({ error: "Thiếu nội dung HTML để áp dụng." }, { status: 400 });
    }
    if (!clientAnalysisHash) {
      return NextResponse.json(
        {
          code: "ANALYSIS_REQUIRED",
          error: "Chưa có kết quả Phân tích cho nội dung này.",
          action: "Bấm “Phân tích thay đổi” trước khi áp dụng vào bản nháp.",
        },
        { status: 400 },
      );
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

    // Explicit template/version guard (Phase 11) — loaded by id AND
    // templateId together, BEFORE any expensive validation work.
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
    if (version.status !== TEMPLATE_VERSION_STATUS.DRAFT) {
      return NextResponse.json(
        {
          code: "VERSION_NOT_DRAFT",
          error: `Chỉ version DRAFT mới được áp dụng HTML. Version v${version.version} hiện đang ${version.status} và là bất biến.`,
          action: "Tạo bản nháp mới (Clone) từ phiên bản này rồi thử lại.",
        },
        { status: 409 },
      );
    }

    // SINGLE ACTIVE DRAFT GUARD (Phase 12) — smallest safe option: fail
    // closed rather than silently pick one when more than one DRAFT exists.
    const draftVersions = await db
      .select({ id: mergeTemplateVersions.id, version: mergeTemplateVersions.version })
      .from(mergeTemplateVersions)
      .where(and(eq(mergeTemplateVersions.templateId, templateId), eq(mergeTemplateVersions.status, TEMPLATE_VERSION_STATUS.DRAFT)));
    if (draftVersions.length > 1) {
      return NextResponse.json(
        {
          code: "SINGLE_DRAFT_AMBIGUOUS",
          error: `Mẫu tài liệu này đang có ${draftVersions.length} bản nháp (DRAFT) cùng lúc — không rõ nên áp dụng vào bản nào.`,
          action: "Hãy Archive các bản nháp không dùng tới (chỉ giữ lại 1 bản nháp) rồi thử lại.",
          draftVersions: draftVersions.map((v) => v.version),
        },
        { status: 409 },
      );
    }

    // NORMALIZE — identical to Analyze/Preview, so what Apply writes is
    // exactly what the operator analyzed and previewed.
    const normalized = normalizeFullHtmlDocument(rawHtml);
    const normalizedPrintCss = [explicitCss, normalized.extractedCss]
      .filter((chunk): chunk is string => Boolean(chunk && chunk.trim()))
      .join("\n\n");

    // STALE ANALYSIS GUARD (Phase 5) — never trust the browser's Analyze
    // result; recompute the hash over what would actually be written now.
    const serverAnalysisHash = computeAnalysisHash(normalized.htmlBody, normalizedPrintCss);
    if (serverAnalysisHash !== clientAnalysisHash) {
      return NextResponse.json(
        {
          code: "STALE_ANALYSIS",
          error: "Nội dung đã thay đổi sau lần phân tích gần nhất. Vui lòng Phân tích lại trước khi áp dụng.",
          action: "Bấm “Phân tích thay đổi” lại rồi thử áp dụng.",
        },
        { status: 409 },
      );
    }

    // SECURITY REVALIDATION (Phase 13) — server-side, never trusts the
    // client's earlier Analyze result. Hard failures block the write.
    const security = analyzeTemplateSecurity(normalized.htmlBody, normalizedPrintCss);
    if (security.errors.length > 0) {
      return NextResponse.json(
        {
          code: "SECURITY_BLOCKED",
          error: "Nội dung HTML/CSS chứa mã không an toàn — không thể áp dụng vào bản nháp.",
          action: "Xoá các thẻ/kiểu không an toàn (script, sự kiện inline, javascript:, iframe/object/embed, CSS expression) rồi thử lại.",
          security,
        },
        { status: 422 },
      );
    }

    const htmlIssues = checkWellFormedness(tokenizeHtml(normalized.htmlBody));
    const { issues: cssIssues } = parseCss(normalizedPrintCss);
    const layoutWarnings = analyzeTemplateLayout(normalized.htmlBody, normalizedPrintCss);

    // Placeholder impact for the audit trail ONLY — mapping rows are never
    // created/mutated here (Phase 14). "New" = present in the pasted HTML but
    // not among the template's current non-orphaned mapped placeholders.
    const currentPlaceholders = extractUniquePlaceholders(normalized.htmlBody);
    const currentFields = await db
      .select({ placeholder: mergeTemplateFields.placeholder })
      .from(mergeTemplateFields)
      .where(and(eq(mergeTemplateFields.templateId, templateId), eq(mergeTemplateFields.isOrphaned, false)));
    const mappedPlaceholders = new Set(currentFields.map((f) => f.placeholder));
    const newPlaceholderCount = currentPlaceholders.filter((p) => !mappedPlaceholders.has(p)).length;

    // THE WRITE — the ONLY database mutation in this route, delegated
    // entirely to the existing, already-guarded service.
    const updated = await updateTemplateVersionDraft(templateId, versionId, {
      htmlBody: normalized.htmlBody,
      printCss: normalizedPrintCss,
    });

    await writeAudit(guard.session, "APPLY_TEMPLATE_HTML_DRAFT", "merge_template_versions", {
      templateId,
      versionId,
      version: updated.version,
      analysisHash: serverAnalysisHash,
      placeholderTotal: currentPlaceholders.length,
      newPlaceholderCount,
      securityErrorCount: security.errors.length,
      securityWarningCount: security.warnings.length,
      layoutWarningCount: layoutWarnings.length,
      htmlValid: htmlIssues.length === 0,
      cssValid: cssIssues.length === 0,
    });

    return NextResponse.json({
      mode: "APPLY_TEMPLATE_HTML_DRAFT",
      mutated: true,
      applied: true,
      published: false,
      templateId,
      templateName: template.name,
      versionId: updated.id,
      version: updated.version,
      status: updated.status,
      analysisHash: serverAnalysisHash,
      placeholders: { total: currentPlaceholders.length, new: newPlaceholderCount },
      layoutWarnings,
      htmlValid: htmlIssues.length === 0,
      cssValid: cssIssues.length === 0,
      note:
        newPlaceholderCount > 0
          ? `Đã áp dụng vào bản nháp v${updated.version}. Có ${newPlaceholderCount} trường mới cần ánh xạ trong Mapping Inspector trước khi xuất bản.`
          : `Đã áp dụng vào bản nháp v${updated.version}. Phiên bản đang xuất bản KHÔNG thay đổi.`,
    });
  } catch (error) {
    if (error instanceof TemplateVersionError) {
      return NextResponse.json({ code: "APPLY_REJECTED", error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/versions/[versionId]/apply-html] error:", error);
    return NextResponse.json(
      {
        code: "APPLY_FAILED",
        error: "Không áp dụng được nội dung vào bản nháp.",
        action: "Kiểm tra nội dung HTML/CSS đã dán rồi thử lại.",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
