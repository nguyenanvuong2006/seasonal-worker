/**
 * READ-ONLY diagnosis of the "blank PDF viewer" defect reported against the
 * one authorized candidate_document (2026-09). Verifies whether the STORED
 * ARTIFACT itself is valid — separately from the candidate-facing API/route/
 * viewer code, which are audited by reading source, not by this script.
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
 *   CANDIDATE_DOCUMENT_ID=9bd3e051-c9f5-48b7-b495-dd73db8a9340 \
 *     node --import tsx scripts/diagnose-econf-blank-pdf.ts
 */
import { db, pool } from "../src/db/index.ts";
import { candidateDocuments } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { getStorageProvider, resolveStorageProviderKind } from "../src/lib/storage/index.ts";
import { createHash } from "node:crypto";

const EXPECTED_CANDIDATE_DOCUMENT_ID = "9bd3e051-c9f5-48b7-b495-dd73db8a9340";

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

  let bytes: Buffer;
  try {
    bytes = await storage.get(doc.storageKey);
  } catch (error) {
    log("STORAGE_GET_FAILED", { error: safeErrorMessage(error) });
    log("STORED_PDF_EXISTS", { value: false });
    await pool.end();
    return;
  }

  const byteLength = bytes.byteLength;
  const signatureBytes = bytes.subarray(0, 5).toString("latin1");
  const signatureValid = signatureBytes === "%PDF-";
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  const sha256Match = Boolean(doc.pdfSha256) && actualSha256 === doc.pdfSha256;

  // Minimal structural parse check — a real PDF must also end with %%EOF
  // (allowing trailing whitespace/newlines) and contain at least one
  // "/Type /Catalog" or "startxref" marker. Not a full parser, but enough to
  // distinguish "truncated/corrupt bytes" from "well-formed PDF".
  const tail = bytes.subarray(Math.max(0, byteLength - 1024)).toString("latin1");
  const hasEof = /%%EOF\s*$/.test(tail);
  const hasStartxref = bytes.toString("latin1").includes("startxref");
  const parseValid = signatureValid && hasEof && hasStartxref;

  log("STORED_PDF_EXISTS", { value: true });
  log("STORED_PDF_BYTES", { value: byteLength });
  log("PDF_SIGNATURE_VALID", { value: signatureValid });
  log("PDF_SHA256_MATCH", { value: sha256Match, actualPrefix: actualSha256.slice(0, 8), storedPrefix: doc.pdfSha256?.slice(0, 8) ?? null });
  log("PDF_PARSE_VALID", { value: parseValid, hasEof, hasStartxref });

  await pool.end();
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "fatal_error", error: safeErrorMessage(error) }));
  process.exit(1);
});
