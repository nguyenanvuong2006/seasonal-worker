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
 * WORKER FALLBACK (2026-09, same root cause + fix pattern as the candidate
 * route — see that file's docblock and PR #170): tries the local storage
 * read first (unchanged when Vercel's own Google credential is healthy)
 * and, only on a confirmed local Google-auth failure, falls back to the
 * worker's /read-stored-pdf endpoint via the same callWorker() channel.
 * Admin View/Download/Print must retrieve the SAME persisted artifact the
 * candidate route now can — never a regenerated one, never a different
 * credential-dependent code path per surface.
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
import { callWorker } from "@/lib/verification/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Detects a LOCAL Google-credential failure (missing OR invalid/expired) —
 * never a genuine content/permission error (404/403/quota) the worker would
 * hit identically. Same literal-error matching as finalize/route.ts and the
 * candidate-facing pdf/route.ts's identical helper (independent token-
 * exchange implementations across google-docs-service.ts / google-drive-
 * pdf.ts / storage/google-drive.ts all throw one of these).
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

  let bytes: Buffer;
  try {
    bytes = await readArtifactBytes(request, doc.storageKey);
  } catch (error) {
    console.error("[document-merge/candidate-documents/[id]/pdf] artifact read failed:", error);
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
