/**
 * POST /api/document-merge/candidate-documents/issue
 *
 * "Tạo & gửi hồ sơ xác nhận" — admin selects N candidates, this creates N
 * INDEPENDENT candidate_documents rows (one per candidate — never a combined
 * multi-candidate PDF) and drives their generation through the EXISTING,
 * already-hardened async merge pipeline (merge_jobs/merge_job_records,
 * Cloud Run worker claim/lease/CAS — see docs/MERGE-ZOMBIE-INCIDENT-*).
 *
 * Reuses `/api/document-merge/merge/execute` IN-PROCESS (direct function
 * call, same request/AsyncLocalStorage context — so requirePermission's
 * cookies()-based session read still works) rather than duplicating its
 * template-routing/snapshot-freeze/worker-trigger logic: zero risk of
 * drifting from the just-hardened GOOGLE_DOCS zombie-recovery behavior,
 * zero new failure surface in that already-audited code path.
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
import { POST as executeMerge } from "@/app/api/document-merge/merge/execute/route";

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
    return NextResponse.json({ error: "Cần chọn ít nhất 1 hồ sơ để tạo & gửi." }, { status: 400 });
  }

  const templateId = typeof body.templateId === "string" && body.templateId.length > 0 ? body.templateId : undefined;

  const internalRequest = new Request("http://internal.local/api/document-merge/merge/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      templateId,
      mergeMode: "INDIVIDUAL_DOCUMENTS",
      batchPrint: false,
      dispatchToApplicant: false,
      autoRoute: !templateId,
      records: { entityType: "daily_applications", recordIds: applicationIds },
    }),
  });

  const mergeResponse = await executeMerge(internalRequest);
  const mergeData = (await mergeResponse.json()) as { jobId?: string; error?: string };
  if (!mergeResponse.ok || !mergeData.jobId) {
    return NextResponse.json({ error: mergeData.error ?? "Không tạo được job sinh hồ sơ." }, { status: mergeResponse.status || 500 });
  }

  const jobId = mergeData.jobId;
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
        issuedBy: guard.session.username,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .returning({ id: candidateDocuments.id, applicationId: candidateDocuments.applicationId });

  await writeAudit(guard.session, "ISSUE_CANDIDATE_DOCUMENTS", "candidate_documents", {
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
