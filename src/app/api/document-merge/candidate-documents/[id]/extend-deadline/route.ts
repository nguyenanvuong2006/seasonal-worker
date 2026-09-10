/**
 * POST /api/document-merge/candidate-documents/[id]/extend-deadline
 *
 * "Gia hạn" — lets staff push out an unconfirmed document's confirmation
 * deadline instead of forcing a full reissue. Only allowed while the
 * document is still ISSUED or VIEWED (the exact two statuses a deadline is
 * ever enforced against, per effectiveStatus()) — a document that is
 * already CONFIRMED, or dead (REVOKED/SUPERSEDED/FAILED), has nothing to
 * extend. This is a pure metadata change: it does NOT touch the frozen
 * PDF/hash/template snapshot, and it does NOT reset viewedAt — a candidate
 * who already viewed the document stays VIEWED, simply with more time to
 * confirm.
 *
 * The new deadline must be strictly AFTER the server's current `now` — you
 * cannot "extend" a document to an already-past instant, and this route
 * never shortens a deadline (that would be a silent trap for a candidate
 * mid-flow); an admin who wants a document to expire sooner should revoke
 * it instead. Every extension is fully audited with the OLD deadline, the
 * NEW deadline, the actor, and an optional reason — CONFIRMATION_DEADLINE_
 * EXTENDED, distinct from CONFIRMATION_DEADLINE_SET (initial issuance).
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments } from "@/db/schema";
import { parseDeadlinePolicyFromBody, resolveConfirmationDeadline } from "@/lib/candidate-consent/confirmation-deadline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXTENDABLE_STATUSES = new Set(["ISSUED", "VIEWED"]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "HR_SUPPORT"],
    "document_merge.candidate_documents.issue",
  );
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await params;
  let body: { deadlineDays?: unknown; deadlineAt?: unknown; reason?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Cần cung cấp hạn xác nhận mới." }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;

  const [doc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, id)).limit(1);
  if (!doc) {
    return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });
  }
  if (!EXTENDABLE_STATUSES.has(doc.status)) {
    return NextResponse.json(
      { error: `Không thể gia hạn hồ sơ ở trạng thái ${doc.status} — chỉ hồ sơ ĐÃ PHÁT HÀNH hoặc ĐÃ XEM mới gia hạn được.` },
      { status: 409 },
    );
  }

  const now = new Date();
  // A DAYS policy here means "N days from NOW" (the extension moment), not
  // from the original issuedAt — that is the whole point of an extension.
  const deadlineResult = resolveConfirmationDeadline(parseDeadlinePolicyFromBody(body), now);
  if (!deadlineResult.ok) {
    return NextResponse.json({ error: deadlineResult.error }, { status: 400 });
  }
  const newDeadlineAt = deadlineResult.deadlineAt;

  const oldDeadlineAt = doc.confirmationDeadlineAt;
  if (oldDeadlineAt && newDeadlineAt.getTime() <= oldDeadlineAt.getTime()) {
    return NextResponse.json(
      { error: "Hạn xác nhận mới phải muộn hơn hạn hiện tại — không thể rút ngắn qua chức năng gia hạn." },
      { status: 400 },
    );
  }

  await db
    .update(candidateDocuments)
    .set({ confirmationDeadlineAt: newDeadlineAt, updatedAt: now })
    .where(eq(candidateDocuments.id, id));

  await writeAudit(guard.session, "CONFIRMATION_DEADLINE_EXTENDED", "candidate_documents", {
    candidateDocumentId: id,
    applicationId: doc.applicationId,
    oldDeadlineAt: oldDeadlineAt ? oldDeadlineAt.toISOString() : null,
    newDeadlineAt: newDeadlineAt.toISOString(),
    reason,
  });

  return NextResponse.json({ success: true, id, confirmationDeadlineAt: newDeadlineAt });
}
