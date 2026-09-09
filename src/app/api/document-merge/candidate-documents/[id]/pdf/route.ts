/**
 * GET /api/document-merge/candidate-documents/[id]/pdf?mode=view|download
 *
 * ADMIN/STAFF-facing PDF artifact access for "Lịch sử Merge" / "Hồ sơ xác
 * nhận điện tử" reopening (2026-09). candidate_documents has NO direct
 * pdf_url column (unlike merge_job_records) — its PDF was always meant to
 * be served ONLY through a server-side storage-provider proxy, exactly like
 * the candidate-facing GET /api/candidate-consent/documents/[id]/pdf route
 * (see that file's docblock) — bytes are streamed via getStorageProvider(),
 * the storage key itself is never exposed to the browser.
 *
 * This route is the STAFF equivalent of that same mechanism: same
 * getStorageProvider().get(storageKey) streaming pattern, but gated by
 * staff RBAC (document_merge.candidate_documents.view_status — the SAME
 * permission the admin status list already requires) instead of a candidate
 * access session. No new storage/auth architecture — reuses the existing
 * secure artifact access mechanism verbatim.
 *
 * CRITICAL: unlike the candidate-facing route, this NEVER advances the
 * document's lifecycle status. A staff member previewing a document before
 * deciding whether to issue it must never be recorded as the CANDIDATE
 * having viewed it — VIEWED is exclusively driven by the candidate-facing
 * route (see nextStatusOnView there). This route performs zero writes.
 *
 * mode=view (default): inline — opens in the browser's PDF viewer (also
 * used for "In PDF" — the browser's native viewer print button prints the
 * ACTUAL persisted artifact, never a regenerated one).
 * mode=download: attachment — forces a Save-As download.
 *
 * Viewable whenever storageKey is present — i.e. any status from READY
 * onward (READY/ISSUED/VIEWED/CONFIRMED/REVOKED/SUPERSEDED/EXPIRED), NOT
 * gated to ISSUED+ like the candidate route: staff must be able to review
 * a READY-but-not-yet-issued document before releasing it.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { candidateDocuments } from "@/db/schema";
import { getStorageProvider } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "HR_SUPPORT", "HR_DIRECTOR"],
    "document_merge.candidate_documents.view_status",
  );
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await params;
  const mode = new URL(request.url).searchParams.get("mode") === "download" ? "download" : "view";

  const [doc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, id)).limit(1);
  if (!doc || !doc.storageKey) {
    return NextResponse.json({ error: "Chưa có PDF cho hồ sơ này." }, { status: 404 });
  }

  const storage = getStorageProvider();
  let bytes: Buffer;
  try {
    bytes = await storage.get(doc.storageKey);
  } catch {
    return NextResponse.json({ error: "Không đọc được PDF từ storage." }, { status: 502 });
  }

  const filename = (doc.filename ?? `${id}.pdf`).replace(/[^\w.-]/g, "_");
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${mode === "download" ? "attachment" : "inline"}; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
