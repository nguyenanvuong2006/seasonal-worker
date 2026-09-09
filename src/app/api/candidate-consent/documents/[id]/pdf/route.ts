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
 *
 * ORDERING (2026-09 fix): the artifact read from storage MUST succeed
 * BEFORE the VIEWED transition is written. A candidate who requests this
 * route while the artifact is unreachable (storage outage, stale
 * credentials) must never have their document marked as viewed — they saw
 * nothing. The previous ordering wrote VIEWED first and only then read the
 * artifact, unguarded, so a read failure both (a) produced an unhandled
 * exception -> generic error response instead of a PDF (blank viewer) and
 * (b) had already, incorrectly, recorded the document as viewed.
 *
 * WORKER FALLBACK (2026-09, same root cause + fix pattern as PR #162's
 * finalize-step fallback): this route runs on Vercel, a runtime separate
 * from the Cloud Run worker, whose own copy of the Google OAuth credential
 * is NOT guaranteed to be in sync with the worker's known-good, Secret-
 * Manager-sourced copy (confirmed via a read-only production diagnostic:
 * Vercel's local read failed with GOOGLE_DRIVE_AUTH_FAILED: invalid_grant).
 * The local storage read is tried first (unchanged behavior when Vercel's
 * own credential is healthy); only on a CONFIRMED local Google-auth failure
 * does this fall back to the worker's /read-stored-pdf endpoint via the
 * SAME callWorker() channel finalize/route.ts already uses. The worker
 * receives only the server-resolved storage key (never the browser, never
 * client input) and returns only PDF bytes — no credential, no storage URL,
 * ever reaches the client. Bytes from either path are verified to start
 * with the PDF magic signature before being trusted.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, candidateDocuments } from "@/db/schema";
import { canView, nextStatusOnView, type CandidateDocumentStatus } from "@/lib/candidate-consent/lifecycle";
import { resolveAccessSession, sessionCanAccess } from "@/lib/candidate-consent/session-store";
import { getStorageProvider } from "@/lib/storage";
import { callWorker } from "@/lib/verification/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = { error: "Không tìm thấy tài liệu hoặc bạn không có quyền truy cập." };

/**
 * Detects a LOCAL Google-credential failure (missing OR invalid/expired) —
 * never a genuine content/permission error (404/403/quota) the worker would
 * hit identically. Same literal-error matching as finalize/route.ts's
 * identical helper (independent token-exchange implementations across
 * google-docs-service.ts / google-drive-pdf.ts / storage/google-drive.ts all
 * throw one of these).
 */
function isMissingGoogleAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  return (
    lower.includes("chưa kết nối google docs") ||
    lower.includes("missing google oauth credentials") ||
    lower.startsWith("batch_pdf_google_auth_failed") ||
    lower.startsWith("google_drive_auth_failed") ||
    lower.includes("invalid_grant") ||
    lower.includes("token has been expired or revoked")
  );
}

function isValidPdfBytes(bytes: Buffer): boolean {
  return bytes.byteLength > 0 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

async function readArtifactBytes(request: Request, storageKey: string): Promise<Buffer> {
  const storage = getStorageProvider();
  let bytes: Buffer;
  try {
    bytes = await storage.get(storageKey);
  } catch (error) {
    if (!isMissingGoogleAuthError(error)) throw error;
    const result = await callWorker<{ pdfBase64?: string; error?: string }>(
      "/read-stored-pdf",
      { key: storageKey },
      60_000,
      { request },
    );
    const data = result.data as { pdfBase64?: string; error?: string } | undefined;
    if (!result.ok || typeof data?.pdfBase64 !== "string") {
      throw new Error(data?.error || "Không đọc được tài liệu qua worker.");
    }
    bytes = Buffer.from(data.pdfBase64, "base64");
  }
  if (!isValidPdfBytes(bytes)) {
    throw new Error("Dữ liệu PDF trả về không hợp lệ.");
  }
  return bytes;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  let bytes: Buffer;
  try {
    bytes = await readArtifactBytes(request, doc.storageKey);
  } catch (error) {
    console.error("[candidate-consent/documents/[id]/pdf] artifact read failed:", error);
    return NextResponse.json({ error: "Không đọc được tài liệu. Vui lòng thử lại sau." }, { status: 502 });
  }

  // Only a successful, authorized artifact retrieval qualifies for the
  // VIEWED transition — see the ORDERING note above.
  const nextStatus = nextStatusOnView(doc.status as CandidateDocumentStatus);
  if (nextStatus !== doc.status) {
    await db
      .update(candidateDocuments)
      .set({ status: nextStatus, viewedAt: doc.viewedAt ?? new Date(), updatedAt: new Date() })
      .where(eq(candidateDocuments.id, id));
    try {
      await db.insert(auditLogs).values({
        userId: null,
        username: "candidate",
        action: "DOCUMENT_VIEWED",
        targetType: "candidate_documents",
        category: "AUDIT",
        details: { candidateDocumentId: id, applicationId: doc.applicationId },
      });
    } catch {
      /* audit must never break the request */
    }
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${(doc.filename ?? "ho-so.pdf").replace(/[^\w.-]/g, "_")}"`,
      "cache-control": "private, no-store",
    },
  });
}
