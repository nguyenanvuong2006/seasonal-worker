/**
 * POST /api/document-merge/verification/check-worker
 * Kiểm tra Cloud Run worker (GET /health) — server-side, không expose secret.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isVerificationEnabled, callWorker, diagnoseWorkerUrl } from "@/lib/verification/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!isVerificationEnabled()) {
    return NextResponse.json({ error: "Verification chỉ khả dụng ở non-production." }, { status: 403 });
  }

  const startedAt = Date.now();
  const urlDiag = diagnoseWorkerUrl();

  // Chặn sớm nếu host không khớp Cloud Run staging kỳ vọng — báo rõ CONFIG
  // thay vì gọi thật rồi trả lỗi mơ hồ (vd HTTP 404 do gõ nhầm host/path).
  if (urlDiag.hostnameMatchesExpectedStaging === false) {
    return NextResponse.json({
      pass: false,
      stage: "CONFIG",
      workerStatus: null,
      error: urlDiag.error,
      workerHost: urlDiag.workerHost,
      workerPath: "/health",
      hostnameMatchesExpectedStaging: false,
      durationMs: Date.now() - startedAt,
    });
  }

  const result = await callWorker<{ ok?: boolean; error?: string }>("/health", undefined, 15_000, { request });
  const data = result.data as { ok?: boolean; error?: string };
  return NextResponse.json({
    pass: result.ok,
    stage: result.stage ?? null,
    workerStatus: result.ok ? (data.ok ?? true) : null,
    error: result.ok ? null : (data.error ?? `HTTP ${result.status}`),
    httpStatus: result.status,
    // An toàn để hiển thị (không phải secret) — giúp chẩn đoán URL sai / lệch
    // auth layer (Cloud Run IAM vs app-level worker secret) mà không cần đoán mò.
    workerHost: urlDiag.workerHost,
    workerPath: "/health",
    hostnameMatchesExpectedStaging: urlDiag.hostnameMatchesExpectedStaging,
    diagnostics: result.diagnostics ?? null,
    durationMs: Date.now() - startedAt,
  });
}
