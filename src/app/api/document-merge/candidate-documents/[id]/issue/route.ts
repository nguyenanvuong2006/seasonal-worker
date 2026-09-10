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
 *
 * CONFIRMATION DEADLINE (2026-09-10) — every issue freezes an absolute
 * confirmation_deadline_at, computed from the request body's deadline
 * policy (deadlineAt for a custom absolute date/time, else deadlineDays,
 * else the DEFAULT_CONFIRMATION_WINDOW_DAYS default) against the SAME
 * server `now` used for issuedAt — never the browser clock. Invalid policy
 * input is rejected before the CAS UPDATE runs at all.
 */

import { NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments } from "@/db/schema";
import { parseDeadlinePolicyFromBody, resolveConfirmationDeadline } from "@/lib/candidate-consent/confirmation-deadline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_VIEWABLE_YET = new Set(["ISSUED", "VIEWED", "CONFIRMED"]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "HR_SUPPORT"],
    "document_merge.candidate_documents.issue",
  );
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  let body: { deadlineDays?: unknown; deadlineAt?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* deadline policy is optional — empty body means the default 3-day window */
  }

  const { id } = await params;
  const now = new Date();
  const deadlineResult = resolveConfirmationDeadline(parseDeadlinePolicyFromBody(body), now);
  if (!deadlineResult.ok) {
    return NextResponse.json({ error: deadlineResult.error }, { status: 400 });
  }
  const confirmationDeadlineAt = deadlineResult.deadlineAt;

  // Single atomic CAS UPDATE — the WHERE clause IS the eligibility check
  // (READY + artifact + hash all present), not a separate SELECT-then-write
  // that a concurrent request could race past.
  const [updated] = await db
    .update(candidateDocuments)
    .set({ status: "ISSUED", issuedAt: now, issuedBy: guard.session.username, confirmationDeadlineAt, updatedAt: now })
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
      confirmationDeadlineAt: confirmationDeadlineAt.toISOString(),
    });
    await writeAudit(guard.session, "CONFIRMATION_DEADLINE_SET", "candidate_documents", {
      candidateDocumentId: updated.id,
      deadlineAt: confirmationDeadlineAt.toISOString(),
    });
    return NextResponse.json({ success: true, id: updated.id, status: "ISSUED", alreadyIssued: false, confirmationDeadlineAt });
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
