/**
 * POST /api/document-merge/candidate-documents/generate
 *
 * "Tạo hồ sơ" — admin selects N candidates, this creates N INDEPENDENT
 * candidate_documents rows (one per candidate — never a combined
 * multi-candidate PDF) and drives their generation through the EXISTING,
 * already-hardened async merge pipeline (merge_jobs/merge_job_records,
 * Cloud Run worker claim/lease/CAS — see docs/MERGE-ZOMBIE-INCIDENT-*).
 *
 * THIS ROUTE ONLY REQUESTS GENERATION. It never releases anything to a
 * candidate: rows land at GENERATING here, the write-side finalizer
 * (POST .../finalize) advances a completed one to READY, and a SEPARATE,
 * explicit staff action (POST .../[id]/issue or its batch form) is what
 * actually makes a document visible to the candidate. Renamed from
 * "issue" to "generate" specifically so the name stops implying automatic
 * release — "Tạo hồ sơ" (create) and "Phát hành" (release) are two
 * distinct business decisions, made by two distinct actions.
 *
 * Creates its job via createCandidateDocumentMergeJob() (see that module's
 * docblock) — the SAME engine branch (HTML_PDF vs legacy GOOGLE_DOCS) the
 * main bulk "Merge" UI action already uses, so this feature follows
 * whatever DOCUMENT_MERGE_ENGINE is currently configured instead of being
 * hardcoded to GOOGLE_DOCS. The GOOGLE_DOCS branch is unchanged: still an
 * in-process call to /merge/execute (direct function call, same request/
 * AsyncLocalStorage context — so requirePermission's cookies()-based
 * session read still works), zero risk of drifting from the already-
 * hardened GOOGLE_DOCS zombie-recovery behavior.
 *
 * dispatchToApplicant is always false here — this feature does NOT write to
 * the legacy daily_applications.mergedDocUrl/signatureDataUrl fields (that
 * remains a separate, pre-existing flow); candidate_documents is its own,
 * immutable, hashed, per-candidate record.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments, mergeJobRecords } from "@/db/schema";
import { createCandidateDocumentMergeJob, CandidateMergeJobError } from "@/lib/document-merge/candidate-merge-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "HR_SUPPORT"],
    "document_merge.candidate_documents.issue",
  );
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  let body: { applicationIds?: unknown; templateId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  }

  const applicationIds = Array.isArray(body.applicationIds)
    ? [...new Set(body.applicationIds.filter((v): v is string => typeof v === "string" && v.length > 0))]
    : [];
  if (applicationIds.length === 0) {
    return NextResponse.json({ error: "Cần chọn ít nhất 1 hồ sơ để tạo hồ sơ xác nhận." }, { status: 400 });
  }

  const templateId = typeof body.templateId === "string" && body.templateId.length > 0 ? body.templateId : undefined;

  let jobId: string;
  try {
    jobId = await createCandidateDocumentMergeJob(guard.session, request, { templateId, recordIds: applicationIds });
  } catch (error) {
    if (error instanceof CandidateMergeJobError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const records = await db.select().from(mergeJobRecords).where(eq(mergeJobRecords.mergeJobId, jobId));

  if (records.length === 0) {
    return NextResponse.json({ error: "Job đã tạo nhưng không có hồ sơ nào được xếp hàng." }, { status: 500 });
  }

  const now = new Date();
  const inserted = await db
    .insert(candidateDocuments)
    .values(
      records.map((record) => ({
        applicationId: record.sourceRecordId,
        mergeJobId: jobId,
        mergeJobRecordId: record.id,
        templateId: record.templateId ?? null,
        status: "GENERATING" as const,
        // issuedBy is set ONLY at the READY -> ISSUED transition (finalize
        // route) — generation being requested is not the same business
        // event as releasing the finished document to the candidate.
        createdAt: now,
        updatedAt: now,
      })),
    )
    .returning({ id: candidateDocuments.id, applicationId: candidateDocuments.applicationId });

  await writeAudit(guard.session, "DOCUMENT_GENERATION_REQUESTED", "candidate_documents", {
    jobId,
    applicationIds,
    documentCount: inserted.length,
  });

  return NextResponse.json(
    {
      success: true,
      jobId,
      total: inserted.length,
      candidateDocuments: inserted,
    },
    { status: 202 },
  );
}
