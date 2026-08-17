/**
 * GET /api/document-merge/engine
 * Trả engine đang bật cho batch merge (GOOGLE_DOCS | HTML_PDF).
 * UI dùng để chọn luồng: legacy synchronous (GOOGLE_DOCS) hoặc async jobs (HTML_PDF).
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getDocumentMergeEngine } from "@/lib/document-merge/engine-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "document_merge.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  return NextResponse.json({ engine: getDocumentMergeEngine() });
}
