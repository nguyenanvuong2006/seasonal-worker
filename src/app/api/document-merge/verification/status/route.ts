/**
 * GET /api/document-merge/verification/status
 * Trạng thái cấu hình verification (KHÔNG trả secrets).
 * Chỉ khả dụng khi VERIFICATION_ENABLED=true ở non-production.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isVerificationEnabled, getWorkerConfig } from "@/lib/verification/helpers";
import { getDocumentMergeEngine } from "@/lib/document-merge/engine-config";
import { resolveStorageProviderKind } from "@/lib/storage/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!isVerificationEnabled()) {
    return NextResponse.json(
      { error: "Verification chỉ khả dụng ở non-production (VERIFICATION_ENABLED=true)." },
      { status: 403 },
    );
  }

  const worker = getWorkerConfig();
  return NextResponse.json({
    verificationEnabled: true,
    engine: getDocumentMergeEngine(),
    workerConfigured: Boolean(worker.url),
    storageProvider: resolveStorageProviderKind(),
    vercelEnv: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });
}
