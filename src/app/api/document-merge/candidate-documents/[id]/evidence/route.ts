/**
 * GET /api/document-merge/candidate-documents/[id]/evidence
 *
 * RESTRICTED — full technical confirmation evidence (IP address, user
 * agent, canonical hash, HMAC). Gated by a SEPARATE, stronger capability
 * than plain status viewing (document_merge.candidate_documents.view_evidence)
 * — ordinary status viewing never exposes IP/UA per the mission's evidence
 * model (candidate-facing certificate and admin status list both omit it).
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { documentConfirmations } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"],
    "document_merge.candidate_documents.view_evidence",
  );
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await params;
  const [confirmation] = await db
    .select()
    .from(documentConfirmations)
    .where(eq(documentConfirmations.candidateDocumentId, id))
    .limit(1);

  if (!confirmation) {
    return NextResponse.json({ error: "Chưa có xác nhận cho hồ sơ này." }, { status: 404 });
  }

  return NextResponse.json({ evidence: confirmation });
}
