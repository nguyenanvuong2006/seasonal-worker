/**
 * POST /api/document-merge/candidate-documents/[id]/issue
 *
 * "Phát hành" — the ONLY way a candidate_document ever becomes visible to
 * the candidate. READY -> ISSUED is a distinct STAFF decision from
 * GENERATING -> READY's SYSTEM decision (see finalize/route.ts) — this
 * route is the sole actor for that transition.
 *
 * CAS + idempotent: the UPDATE's WHERE clause itself requires status='READY'
 * AND a non-null pdf_sha256/storage_key (defense in depth — finalize.ts
 * should never write READY without both, but this route re-verifies rather
 * than trusting that invariant blindly). Two concurrent issue requests for
 * the SAME document race on this single atomic UPDATE; Postgres row-level
 * locking guarantees at most one of them actually matches and returns a
 * row, so DOCUMENT_ISSUED is audited exactly once. The request that "loses"
 * the race re-reads the row: if it is now ISSUED (or later), that's treated
 * as an idempotent success (a double-click), not an error.
 */

import { NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_VIEWABLE_YET = new Set(["ISSUED", "VIEWED", "CONFIRMED"]);

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "HR_SUPPORT"],
    "document_merge.candidate_documents.issue",
  );
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await params;
  const now = new Date();

  // Single atomic CAS UPDATE — the WHERE clause IS the eligibility check
  // (READY + artifact + hash all present), not a separate SELECT-then-write
  // that a concurrent request could race past.
  const [updated] = await db
    .update(candidateDocuments)
    .set({ status: "ISSUED", issuedAt: now, issuedBy: guard.session.username, updatedAt: now })
    .where(
      and(
        eq(candidateDocuments.id, id),
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
    return NextResponse.json({ success: true, id: updated.id, status: "ISSUED", alreadyIssued: false });
  }

  // The CAS matched zero rows — find out why, for an accurate response.
  const [current] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, id)).limit(1);
  if (!current) {
    return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });
  }
  if (NOT_VIEWABLE_YET.has(current.status)) {
    // Idempotent: already issued (or further along) — a double-click, not an error.
    return NextResponse.json({ success: true, id: current.id, status: current.status, alreadyIssued: true });
  }
  if (current.status === "READY" && (!current.pdfSha256 || !current.storageKey)) {
    return NextResponse.json(
      { error: "Hồ sơ ở trạng thái SẴN SÀNG nhưng thiếu tệp/mã băm — không thể phát hành." },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { error: `Không thể phát hành hồ sơ ở trạng thái ${current.status} — chỉ hồ sơ SẴN SÀNG mới phát hành được.` },
    { status: 409 },
  );
}
