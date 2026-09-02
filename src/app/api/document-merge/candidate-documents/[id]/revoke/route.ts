/**
 * POST /api/document-merge/candidate-documents/[id]/revoke
 *
 * Staff-only correction path. Only allowed BEFORE a confirmation exists
 * (see lifecycle.canRevoke) — once CONFIRMED, evidence is immutable and the
 * only path forward is superseding with a brand-new document + a new
 * candidate confirmation.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments } from "@/db/schema";
import { canRevoke, type CandidateDocumentStatus } from "@/lib/candidate-consent/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.candidate_documents.revoke");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await params;
  let body: { reason?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* reason is optional */
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;

  const [doc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, id)).limit(1);
  if (!doc) {
    return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });
  }
  if (!canRevoke(doc.status as CandidateDocumentStatus)) {
    return NextResponse.json(
      { error: `Không thể thu hồi hồ sơ ở trạng thái ${doc.status} (đã xác nhận hoặc đã kết thúc vòng đời).` },
      { status: 409 },
    );
  }

  const now = new Date();
  await db
    .update(candidateDocuments)
    .set({ status: "REVOKED", revokedAt: now, revokedBy: guard.session.username, revokeReason: reason, updatedAt: now })
    .where(eq(candidateDocuments.id, id));

  await writeAudit(guard.session, "DOCUMENT_REVOKED", "candidate_documents", {
    candidateDocumentId: id,
    applicationId: doc.applicationId,
    reason,
  });

  return NextResponse.json({ success: true, id, status: "REVOKED" });
}
