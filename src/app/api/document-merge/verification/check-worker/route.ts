/**
 * POST /api/document-merge/verification/check-worker
 * Kiểm tra Cloud Run worker (GET /health) — server-side, không expose secret.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isVerificationEnabled, callWorker } from "@/lib/verification/helpers";

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
  const result = await callWorker<{ ok?: boolean; error?: string }>("/health", undefined, 15_000, { request });
  const data = result.data as { ok?: boolean; error?: string };
  return NextResponse.json({
    pass: result.ok,
    stage: "CLOUD_RUN",
    workerStatus: result.ok ? (data.ok ?? true) : null,
    error: result.ok ? null : (data.error ?? `HTTP ${result.status}`),
    durationMs: Date.now() - startedAt,
  });
}
