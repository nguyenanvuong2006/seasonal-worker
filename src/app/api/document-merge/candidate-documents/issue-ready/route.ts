/**
 * POST /api/document-merge/candidate-documents/issue-ready
 *
 * "Phát hành hồ sơ đã sẵn sàng" — batch form of the single-document
 * READY -> ISSUED release ([id]/issue/route.ts). Body: { ids?: string[] }
 * — omitted/empty means "every currently READY document"; when `ids` is
 * given, only those are attempted (a non-READY id in the list is simply
 * skipped with its own per-document outcome, never an error for the batch).
 *
 * Each document is issued through the EXACT SAME atomic CAS UPDATE as the
 * single-document route (status='READY' AND pdf_sha256/storage_key both
 * present, in the WHERE clause itself) — issued INDEPENDENTLY, so one
 * document's failure (or simply not being eligible) never blocks the rest
 * of the batch. Never issues GENERATING/FAILED/REVOKED/SUPERSEDED/EXPIRED/
 * CONFIRMED documents — the CAS predicate structurally cannot match them.
 */

import { NextResponse } from "next/server";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IssueOutcome = "issued" | "already_issued" | "not_ready";

export async function POST(request: Request) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "HR_SUPPORT"],
    "document_merge.candidate_documents.issue",
  );
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  let body: { ids?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* ids filter is optional — empty body means "all READY" */
  }
  const scopedIds = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string") : null;

  const candidateWhere = scopedIds ? inArray(candidateDocuments.id, scopedIds) : eq(candidateDocuments.status, "READY");
  const candidates = await db
    .select({ id: candidateDocuments.id, status: candidateDocuments.status })
    .from(candidateDocuments)
    .where(candidateWhere);

  const results: { id: string; outcome: IssueOutcome }[] = [];

  for (const candidate of candidates) {
    if (candidate.status !== "READY") {
      results.push({ id: candidate.id, outcome: "not_ready" });
      continue;
    }

    // Isolate per-document failures — never abort the batch.
    try {
      const now = new Date();
      const [updated] = await db
        .update(candidateDocuments)
        .set({ status: "ISSUED", issuedAt: now, issuedBy: guard.session.username, updatedAt: now })
        .where(
          and(
            eq(candidateDocuments.id, candidate.id),
            eq(candidateDocuments.status, "READY"),
            isNotNull(candidateDocuments.pdfSha256),
            isNotNull(candidateDocuments.storageKey),
          ),
        )
        .returning({ id: candidateDocuments.id, applicationId: candidateDocuments.applicationId });

      if (updated) {
        await writeAudit(guard.session, "DOCUMENT_ISSUED", "candidate_documents", {
          candidateDocumentId: updated.id,
          applicationId: updated.applicationId,
        });
        results.push({ id: candidate.id, outcome: "issued" });
      } else {
        results.push({ id: candidate.id, outcome: "not_ready" });
      }
    } catch {
      results.push({ id: candidate.id, outcome: "not_ready" });
    }
  }

  return NextResponse.json({
    processed: results.length,
    issued: results.filter((r) => r.outcome === "issued").length,
    results,
  });
}
