/**
 * READ-ONLY diagnosis of the "blank PDF viewer" defect reported against the
 * one authorized candidate_document (2026-09). Verifies whether the STORED
 * ARTIFACT itself is valid — separately from the candidate-facing API/route/
 * viewer code, which are audited by reading source, not by this script.
 *
 * UPDATE (worker-fallback verification): after the local storage.get()
 * attempt (kept for continuity/comparison — it is expected to keep failing
 * with GOOGLE_DRIVE_AUTH_FAILED until Vercel's own credential is rotated,
 * which is intentionally OUT OF SCOPE for this fix), this ALSO verifies the
 * new worker endpoint (POST /read-stored-pdf, added alongside this route's
 * fallback change) directly — the exact mechanism the real Vercel route now
 * falls back to. This is NOT the candidate-facing PDF route: it never
 * resolves an access session, never checks IDOR, and critically never
 * touches candidate_documents.status — it is a pure worker-side artifact
 * fetch, safe to call directly for verification without ever marking this
 * real document VIEWED/CONFIRMED.
 *
 * SAFETY / SCOPE:
 *  - Zero writes: never calls storage.put(), never updates candidateDocuments,
 *    never inserts audit rows.
 *  - Never calls the candidate-facing PDF route (GET .../documents/[id]/pdf)
 *    — that would advance ISSUED -> VIEWED on this real document, which the
 *    mission explicitly prohibits.
 *  - Never logs the storage key or filename verbatim — both are built from
 *    the candidate's real name (see src/lib/document-merge/filename.ts) and
 *    are therefore PII. Only booleans/lengths/hashes are logged.
 *  - Refuses to run against any id other than the one this mission is
 *    diagnosing (same hard guardrail pattern as the issue script).
 *
 * Cách dùng:
 *   DATABASE_URL=... STORAGE_PROVIDER=google_drive GOOGLE_CLIENT_ID=... \
 *   GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... GOOGLE_DRIVE_ROOT_FOLDER_ID=... \
 *   [PDF_MERGE_WORKER_URL=... MERGE_WORKER_SECRET=... WORKER_ID_TOKEN=...] \
 *   CANDIDATE_DOCUMENT_ID=9bd3e051-c9f5-48b7-b495-dd73db8a9340 \
 *     node --import tsx scripts/diagnose-econf-blank-pdf.ts
 */
import { db, pool } from "../src/db/index.ts";
import { candidateDocuments } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { getStorageProvider, resolveStorageProviderKind } from "../src/lib/storage/index.ts";
import { createHash } from "node:crypto";

const EXPECTED_CANDIDATE_DOCUMENT_ID = "9bd3e051-c9f5-48b7-b495-dd73db8a9340";
const WORKER_URL = (process.env.PDF_MERGE_WORKER_URL ?? "").replace(/\/+$/, "");
const WORKER_SECRET = process.env.MERGE_WORKER_SECRET ?? "";
const WORKER_ID_TOKEN = process.env.WORKER_ID_TOKEN ?? "";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

/**
 * Truncates and strips anything that looks like an actual OAuth token/secret
 * before logging a raw error message — but preserves our own internal
 * GOOGLE_DRIVE_* error-code prefixes and Google's own (non-secret) JSON
 * error body, which are exactly what's needed to diagnose a storage.get()
 * failure. A blanket "redact anything 24+ chars" pattern is too aggressive:
 * it eats our own ~30-char error-code identifiers along with real secrets.
 * Real tokens (OAuth access/refresh tokens, client secrets) are reliably
 * much longer (60+ chars) or match a known prefix, so only those are masked.
 */
function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw
    .replace(/ya29\.[A-Za-z0-9_-]+/g, "[redacted-access-token]")
    .replace(/GOCSPX-[A-Za-z0-9_-]+/g, "[redacted-client-secret]")
    .replace(/[A-Za-z0-9_-]{60,}/g, "[redacted-long-token]")
    .slice(0, 500);
}

/** Calls the Cloud Run worker directly — same header contract callWorker()
 *  expects, sourced from this workflow's own GitHub Actions WIF identity
 *  (same pattern as scripts/verify-econf-single-candidate.ts's identical
 *  helper). Used ONLY to verify the new /read-stored-pdf endpoint — never
 *  the candidate-facing PDF route. */
async function callWorkerDirect<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<{ ok: boolean; status: number; data: T | { error?: string } }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (WORKER_ID_TOKEN) headers["X-Serverless-Authorization"] = `Bearer ${WORKER_ID_TOKEN}`;
  if (WORKER_SECRET) {
    headers.Authorization = `Bearer ${WORKER_SECRET}`;
    headers["X-Merge-Worker-Secret"] = WORKER_SECRET;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WORKER_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  const targetId = process.env.CANDIDATE_DOCUMENT_ID ?? "";
  if (targetId !== EXPECTED_CANDIDATE_DOCUMENT_ID) {
    log("guardrail_id_mismatch", { expected: EXPECTED_CANDIDATE_DOCUMENT_ID, got: targetId || "(empty)" });
    console.error("❌ CANDIDATE_DOCUMENT_ID không khớp id đang chẩn đoán. Dừng lại.");
    process.exit(1);
  }

  const [doc] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, targetId)).limit(1);
  if (!doc) {
    log("not_found", { targetId });
    console.error("❌ Không tìm thấy candidate_document.");
    process.exit(1);
  }

  log("STORED_ROW", {
    id: doc.id,
    status: doc.status,
    storageProvider: doc.storageProvider,
    storageKeyPresent: Boolean(doc.storageKey),
    storageKeyLength: doc.storageKey?.length ?? 0,
    filenamePresent: Boolean(doc.filename),
    fileSizeColumn: doc.fileSize,
    pdfSha256: doc.pdfSha256,
    viewedAt: doc.viewedAt,
  });

  if (!doc.storageKey) {
    log("STORED_PDF_EXISTS", { value: false, reason: "no storage_key on row" });
    await pool.end();
    return;
  }

  const resolvedKind = resolveStorageProviderKind();
  log("resolved_storage_provider_kind", { kind: resolvedKind, rowSaysProvider: doc.storageProvider });

  const storage = getStorageProvider();

  let localBytes: Buffer | null = null;
  try {
    localBytes = await storage.get(doc.storageKey);
    checkBytes("LOCAL", localBytes, doc.pdfSha256);
  } catch (error) {
    log("LOCAL_STORAGE_GET_FAILED", { error: safeErrorMessage(error) });
    log("LOCAL_STORED_PDF_EXISTS", { value: false });
  }

  // Verify the NEW worker fallback mechanism directly (POST /read-stored-pdf)
  // — this is NOT the candidate-facing PDF route: no session, no IDOR check,
  // no candidate_documents write of any kind. Safe to call unconditionally
  // for verification, regardless of whether the local read above succeeded.
  if (WORKER_URL) {
    try {
      const result = await callWorkerDirect<{ pdfBase64?: string; error?: string }>("/read-stored-pdf", { key: doc.storageKey });
      log("WORKER_READ_STORED_PDF_RESPONSE", { ok: result.ok, status: result.status, hasError: Boolean((result.data as { error?: string })?.error) });
      const pdfBase64 = (result.data as { pdfBase64?: string })?.pdfBase64;
      if (result.ok && typeof pdfBase64 === "string") {
        const workerBytes = Buffer.from(pdfBase64, "base64");
        checkBytes("WORKER", workerBytes, doc.pdfSha256);
      } else {
        log("WORKER_STORED_PDF_EXISTS", { value: false, error: safeErrorMessage((result.data as { error?: string })?.error ?? "no pdfBase64 in response") });
      }
    } catch (error) {
      log("WORKER_CALL_FAILED", { error: safeErrorMessage(error) });
    }
  } else {
    log("worker_verification_skipped", { reason: "PDF_MERGE_WORKER_URL not configured for this run" });
  }

  if (!localBytes) {
    await pool.end();
    return;
  }

  await pool.end();
}

function checkBytes(source: "LOCAL" | "WORKER", bytes: Buffer, storedSha256: string | null): void {
  const byteLength = bytes.byteLength;
  const signatureBytes = bytes.subarray(0, 5).toString("latin1");
  const signatureValid = signatureBytes === "%PDF-";
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  const sha256Match = Boolean(storedSha256) && actualSha256 === storedSha256;

  // Minimal structural parse check — a real PDF must also end with %%EOF
  // (allowing trailing whitespace/newlines) and contain at least one
  // "/Type /Catalog" or "startxref" marker. Not a full parser, but enough to
  // distinguish "truncated/corrupt bytes" from "well-formed PDF".
  const tail = bytes.subarray(Math.max(0, byteLength - 1024)).toString("latin1");
  const hasEof = /%%EOF\s*$/.test(tail);
  const hasStartxref = bytes.toString("latin1").includes("startxref");
  const parseValid = signatureValid && hasEof && hasStartxref;

  log(`${source}_STORED_PDF_EXISTS`, { value: true });
  log(`${source}_STORED_PDF_BYTES`, { value: byteLength });
  log(`${source}_PDF_SIGNATURE_VALID`, { value: signatureValid });
  log(`${source}_PDF_SHA256_MATCH`, { value: sha256Match, actualPrefix: actualSha256.slice(0, 8), storedPrefix: storedSha256?.slice(0, 8) ?? null });
  log(`${source}_PDF_PARSE_VALID`, { value: parseValid, hasEof, hasStartxref });
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "fatal_error", error: safeErrorMessage(error) }));
  process.exit(1);
});
