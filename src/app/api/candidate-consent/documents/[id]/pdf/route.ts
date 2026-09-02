/**
 * GET /api/candidate-consent/documents/[id]/pdf
 *
 * STEP 3 — streams the EXACT issued PDF bytes to the candidate. Never a
 * public/signed storage URL: bytes are read server-side via the storage
 * provider and piped through this response, so the storage key itself is
 * never exposed to the browser. IDOR-checked against the session's scoped
 * application ids (lifecycle.sessionCanAccessApplication) — a session
 * scoped to candidate A's applications can never read candidate B's
 * document by guessing/incrementing an id. First successful view marks the
 * document VIEWED (never regresses CONFIRMED back to VIEWED).
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { candidateDocuments } from "@/db/schema";
import { canView, nextStatusOnView, type CandidateDocumentStatus } from "@/lib/candidate-consent/lifecycle";
import { resolveAccessSession, sessionCanAccess } from "@/lib/candidate-consent/session-store";
import { getStorageProvider } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = { error: "Không tìm thấy tài liệu hoặc bạn không có quyền truy cập." };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await resolveAccessSession();
  if (!session) {
    return NextResponse.json({ error: "Phiên tra cứu đã hết hạn. Vui lòng tra cứu lại." }, { status: 401 });
  }

  const { id } = await params;
  const [doc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, id)).limit(1);
  if (!doc) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }
  if (!sessionCanAccess(session, doc.applicationId)) {
    // Same 404 as "not found" — never confirm a document id EXISTS to a session that can't see it.
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }
  if (!canView(doc.status as CandidateDocumentStatus) || !doc.storageKey) {
    return NextResponse.json({ error: "Tài liệu chưa sẵn sàng để xem." }, { status: 409 });
  }

  const nextStatus = nextStatusOnView(doc.status as CandidateDocumentStatus);
  if (nextStatus !== doc.status) {
    await db
      .update(candidateDocuments)
      .set({ status: nextStatus, viewedAt: doc.viewedAt ?? new Date(), updatedAt: new Date() })
      .where(eq(candidateDocuments.id, id));
  }

  const storage = getStorageProvider();
  const bytes = await storage.get(doc.storageKey);

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${(doc.filename ?? "ho-so.pdf").replace(/[^\w.-]/g, "_")}"`,
      "cache-control": "private, no-store",
    },
  });
}
