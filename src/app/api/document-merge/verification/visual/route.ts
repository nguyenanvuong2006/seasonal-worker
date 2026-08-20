/**
 * POST /api/document-merge/verification/visual
 * Visual verification trên CLOUD: Admin upload reference PDF (export từ Google
 * Docs) → worker /verify-visual render HTML engine + so sánh → report.
 *
 * Multipart: field "reference" (PDF). Chỉ ADMIN + non-production.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isVerificationEnabled, callWorker } from "@/lib/verification/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!isVerificationEnabled()) {
    return NextResponse.json({ error: "Verification chỉ khả dụng ở non-production." }, { status: 403 });
  }

  const startedAt = Date.now();
  try {
    const form = await request.formData();
    const file = form.get("reference");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Cần upload reference PDF (field 'reference')." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Chỉ hỗ trợ file PDF (export từ Google Docs)." }, { status: 400 });
    }
    if (file.size > MAX_REFERENCE_BYTES) {
      return NextResponse.json({ error: "Reference PDF quá lớn (>25MB)." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const referencePdfBase64 = buffer.toString("base64");

    const result = await callWorker<{
      report?: {
        referencePages: number;
        renderedPages: number;
        pageCountMatch: boolean;
        pageBreakDifference: boolean;
        avgDiffPercent: number | null;
        diff: { page: number; diffPixels: number; diffPercent: number }[];
        warnings: string[];
        pass: boolean;
      };
      renderedPdfBase64?: string;
      pass?: boolean;
      error?: string;
    }>("/verify-visual", { referencePdfBase64 }, 180_000, { request });

    const data = result.data as {
      report?: {
        referencePages: number;
        renderedPages: number;
        pageCountMatch: boolean;
        pageBreakDifference: boolean;
        avgDiffPercent: number | null;
        diff: { page: number; diffPixels: number; diffPercent: number }[];
        warnings: string[];
        pass: boolean;
      };
      renderedPdfBase64?: string;
      error?: string;
    };
    if (!result.ok || !data.report) {
      return NextResponse.json({
        pass: false,
        stage: "VISUAL",
        error: data.error ?? `Worker HTTP ${result.status}`,
        durationMs: Date.now() - startedAt,
      });
    }

    const { report, renderedPdfBase64 } = data;
    return NextResponse.json({
      pass: report.pass,
      stage: "VISUAL",
      report,
      // Cho phép tải rendered PDF về so sánh (data URL — không lưu server).
      renderedPdfDownloadUrl: renderedPdfBase64
        ? `data:application/pdf;base64,${renderedPdfBase64}`
        : null,
      referenceFileName: file.name,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json({
      pass: false,
      stage: "VISUAL",
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      durationMs: Date.now() - startedAt,
    });
  }
}
