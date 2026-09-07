/**
 * POST /api/document-merge/templates/[id]/versions/[versionId]/preview-pdf
 *
 * AUTHORITATIVE "A4 PDF PREVIEW" (2026-09) — the real, Chromium-rendered PDF
 * for ONE explicitly addressed template version + ONE real candidate, using
 * the EXACT SAME snapshot/data resolution as the DOM "Quick Preview" route
 * (see preview-render.ts) and the EXACT SAME PDF-rendering configuration as
 * the production HTML_PDF merge worker (see worker/src/index.ts's
 * renderPdfBytes — page.setContent → fonts.ready → page.pdf() with the same
 * options). There is no second Chromium configuration: this route only
 * hands the worker the fully-rendered HTML string and returns whatever
 * bytes it produces.
 *
 * Root cause this route exists to close: the DOM/CSS "Quick Preview" is an
 * on-screen approximation (see preview-a4-decoration.ts's own docblock) that
 * cannot reproduce true print-media pagination — a `.paper` section whose
 * content overflows one physical A4 page renders as a single tall box on
 * screen, while the real PDF naturally continues it onto additional
 * physical pages. That gap is exactly what let a real Production merge look
 * "different from Preview" even after the underlying render pipeline was
 * proven correct. This route removes the gap by making Preview itself a
 * real PDF, not an approximation of one.
 *
 * WHAT THIS ROUTE MUST NEVER DO:
 *   - publish anything, change current_published_version, populate
 *     mapping_snapshot, create a merge job / merge_job_records /
 *     candidate_documents / document_history row, modify candidate data;
 *   - persist the rendered PDF anywhere (no storage upload) — the bytes are
 *     streamed straight back to the caller and never written to Drive/disk;
 *   - use a second/independent PDF-render configuration — it is a thin
 *     proxy to the worker's own renderPdfBytes().
 *
 * SECURITY — identical guard to the DOM preview route: ADMIN RBAC, Data
 * Scope-filtered candidate lookup, templateId/versionId cross-checked in
 * SQL. The worker call itself is authenticated via callWorker() (the same
 * MERGE_WORKER_SECRET / Cloud Run IAM path every other Vercel→worker call
 * uses — see src/lib/document-merge/worker-trigger.ts).
 */

import { NextResponse } from "next/server";
import { getUserScope, requirePermission } from "@/lib/auth";
import {
  PreviewResolutionError,
  isCanonicalTemplateError,
  CANONICAL_ACTION_VI,
  resolveTemplateVersionPreview,
} from "@/lib/document-merge/preview-render";
import { parseDraftPreviewRequest } from "@/lib/document-merge/draft-preview";
import { callWorker } from "@/lib/verification/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(request: Request, context: RouteContext) {
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

    // The SAME renderPdfBytes() the real merge uses — no second config.
    const result = await callWorker<{ pdfBase64: string; byteLength: number }>(
      "/preview-pdf",
      { html: resolved.rendered.html },
      60_000,
      { request },
    );
    const data = result.data as { pdfBase64?: string; byteLength?: number; error?: string } | undefined;
    if (!result.ok || !data?.pdfBase64) {
      return NextResponse.json(
        {
          code: "PDF_PREVIEW_RENDER_FAILED",
          error: data?.error || "Không render được PDF xem trước qua worker.",
          action: "Kiểm tra worker (Cloud Run) đang chạy và cấu hình PDF_MERGE_WORKER_URL/MERGE_WORKER_SECRET, rồi thử lại.",
          stage: result.stage ?? null,
        },
        { status: 502 },
      );
    }

    const bytes = Buffer.from(data.pdfBase64, "base64");
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="a4-preview-v${resolved.version.version}.pdf"`,
        // Never cache — a preview must always reflect the CURRENT candidate
        // data/mapping, never a stale render from a previous request.
        "Cache-Control": "no-store",
      },
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
    console.error("[document-merge/templates/[id]/versions/[versionId]/preview-pdf] error:", error);
    return NextResponse.json(
      {
        code: "PDF_PREVIEW_FAILED",
        error: "Không tạo được PDF xem trước.",
        action: "Kiểm tra nội dung HTML của phiên bản và mapping của mẫu rồi thử lại.",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
