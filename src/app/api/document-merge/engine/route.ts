/**
 * GET /api/document-merge/engine
 * Trả engine đang bật cho batch merge (GOOGLE_DOCS | HTML_PDF).
 * UI dùng để chọn luồng: legacy synchronous (GOOGLE_DOCS) hoặc async jobs (HTML_PDF).
 */

import { NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/auth";
import { getDocumentMergeEngine } from "@/lib/document-merge/engine-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Execute dependency: the Merge workspace calls this on load to decide which
// execution path to use (legacy GOOGLE_DOCS vs async HTML_PDF jobs) — an
// execute-only user must read this too, or the workspace silently falls back
// to the wrong engine on a 403 (its fetch .catch() swallows the error).
export async function GET() {
  const guard = await requireAnyPermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], ["document_merge.view", "document_merge.execute"]);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  return NextResponse.json({ engine: getDocumentMergeEngine() });
}
