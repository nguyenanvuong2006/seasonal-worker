/**
 * POST /api/document-merge/candidate-documents/[id]/reissue
 *
 * "Thu hồi & tạo lại" — the complete correction flow. Only allowed BEFORE a
 * confirmation exists (canRevoke — same gate as plain revoke). The OLD
 * document is marked SUPERSEDED (never REVOKED — REVOKED means "killed,
 * no replacement"; SUPERSEDED specifically means "replaced by a newer
 * version", audited as DOCUMENT_SUPERSEDED) and its evidence/history is
 * NEVER touched or deleted. A brand-new candidate_document is created
 * (GENERATING, supersedes_document_id = the old id) and generation is
 * re-triggered for that ONE candidate through createCandidateDocumentMergeJob()
 * (the same helper, and same engine branch, the batch generate route uses)
 * — the new document gets its own new PDF, new SHA-256, and will require an
 * entirely new candidate confirmation once it reaches ISSUED/VIEWED.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments, mergeJobRecords } from "@/db/schema";
import { canRevoke, canSupersede, type CandidateDocumentStatus } from "@/lib/candidate-consent/lifecycle";
import { createCandidateDocumentMergeJob, CandidateMergeJobError } from "@/lib/document-merge/candidate-merge-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER"],
    "document_merge.candidate_documents.revoke",
  );
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

  const [oldDoc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, id)).limit(1);
  if (!oldDoc) {
    return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });
  }
  if (!canRevoke(oldDoc.status as CandidateDocumentStatus)) {
    return NextResponse.json(
      { error: `Không thể tạo lại hồ sơ ở trạng thái ${oldDoc.status} (đã xác nhận hoặc đã kết thúc vòng đời).` },
      { status: 409 },
    );
  }

  // Re-trigger generation for this ONE candidate — same hardened pipeline
  // (and same engine branch) the batch generate route uses, scoped to a
  // single applicationId.
  let jobId: string;
  try {
    jobId = await createCandidateDocumentMergeJob(guard.session, request, {
      templateId: oldDoc.templateId ?? undefined,
      recordIds: [oldDoc.applicationId],
    });
  } catch (error) {
    if (error instanceof CandidateMergeJobError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const [newRecord] = await db.select().from(mergeJobRecords).where(eq(mergeJobRecords.mergeJobId, jobId)).limit(1);
  if (!newRecord) {
    return NextResponse.json({ error: "Job đã tạo nhưng không có hồ sơ nào được xếp hàng." }, { status: 500 });
  }

  const now = new Date();

  // Old -> SUPERSEDED. Evidence/history untouched — this is a status write
  // only, never a delete, never an overwrite of anything already recorded.
  await db
    .update(candidateDocuments)
    .set({ status: "SUPERSEDED", revokedAt: now, revokedBy: guard.session.username, revokeReason: reason, updatedAt: now })
    .where(eq(candidateDocuments.id, id));
  await writeAudit(guard.session, "DOCUMENT_SUPERSEDED", "candidate_documents", {
    candidateDocumentId: id,
    applicationId: oldDoc.applicationId,
    reason,
  });

  // Defense in depth: the new document's applicationId is derived directly
  // from oldDoc below, so this can never actually be false here — but the
  // assertion is the single source of truth this route (and any future
  // reissue-like path) is checked against, not an assumption left implicit.
  const newApplicationId = oldDoc.applicationId;
  if (!canSupersede(oldDoc.applicationId, newApplicationId)) {
    return NextResponse.json({ error: "Không thể tạo lại hồ sơ cho ứng viên khác." }, { status: 400 });
  }

  const [newDoc] = await db
    .insert(candidateDocuments)
    .values({
      applicationId: newApplicationId,
      mergeJobId: jobId,
      mergeJobRecordId: newRecord.id,
      templateId: newRecord.templateId ?? oldDoc.templateId,
      status: "GENERATING",
      supersedesDocumentId: id,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: candidateDocuments.id, applicationId: candidateDocuments.applicationId });

  await writeAudit(guard.session, "DOCUMENT_GENERATION_REQUESTED", "candidate_documents", {
    jobId,
    applicationIds: [oldDoc.applicationId],
    documentCount: 1,
    supersedesDocumentId: id,
  });

  return NextResponse.json(
    { success: true, oldDocumentId: id, newDocumentId: newDoc.id, jobId },
    { status: 202 },
  );
}
