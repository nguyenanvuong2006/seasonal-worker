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
 * re-triggered for that ONE candidate through the same in-process
 * merge/execute call the batch issue route uses — the new document gets
 * its own new PDF, new SHA-256, and will require an entirely new candidate
 * confirmation once it reaches ISSUED/VIEWED.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments, mergeJobRecords } from "@/db/schema";
import { canRevoke, type CandidateDocumentStatus } from "@/lib/candidate-consent/lifecycle";
import { POST as executeMerge } from "@/app/api/document-merge/merge/execute/route";

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
  // the batch issue route uses, scoped to a single applicationId.
  const internalRequest = new Request("http://internal.local/api/document-merge/merge/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      templateId: oldDoc.templateId ?? undefined,
      mergeMode: "INDIVIDUAL_DOCUMENTS",
      batchPrint: false,
      dispatchToApplicant: false,
      autoRoute: !oldDoc.templateId,
      records: { entityType: "daily_applications", recordIds: [oldDoc.applicationId] },
    }),
  });
  const mergeResponse = await executeMerge(internalRequest);
  const mergeData = (await mergeResponse.json()) as { jobId?: string; error?: string };
  if (!mergeResponse.ok || !mergeData.jobId) {
    return NextResponse.json({ error: mergeData.error ?? "Không tạo được job sinh hồ sơ thay thế." }, { status: mergeResponse.status || 500 });
  }

  const jobId = mergeData.jobId;
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

  const [newDoc] = await db
    .insert(candidateDocuments)
    .values({
      applicationId: oldDoc.applicationId,
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
