/**
 * ISSUE (READY -> ISSUED) exactly ONE, already-created candidate_document —
 * the same one scripts/verify-econf-single-candidate.ts drove to READY
 * (PR #164). 2026-09 — continues that verification into the issue +
 * candidate-access phase of the electronic-confirmation mission.
 *
 * WHY A SCRIPT INSTEAD OF CLICKING THE ADMIN UI: same reason as
 * verify-econf-single-candidate.ts — this environment has no browser session
 * or staff login cookie, and POST candidate-documents/[id]/issue's
 * requirePermission() -> getSession() only resolves inside a live Next.js
 * request. This script instead performs the EXACT SAME atomic CAS UPDATE
 * that route.ts issues (same WHERE clause: status='READY' AND pdf_sha256 IS
 * NOT NULL AND storage_key IS NOT NULL -> status='ISSUED'), then writes the
 * same DOCUMENT_ISSUED audit row that route writes via writeAudit() — never
 * reimplementing the business rule differently.
 *
 * HARD SAFETY GUARDRAIL: refuses to run against any id other than the exact
 * candidate_document this mission authorized ("Issue this SAME document
 * once" / "Do not create another candidate_document"). The expected id is
 * baked in below; the caller must also pass the same id via env as an
 * explicit double-check, and a mismatch aborts before any write.
 *
 * NEVER views the candidate-facing PDF (that would falsely mark VIEWED
 * without a real candidate opening it) and NEVER confirms on the
 * candidate's behalf. Issues once, then stops.
 *
 * Cách dùng:
 *   DATABASE_URL=... CANDIDATE_DOCUMENT_ID=9bd3e051-c9f5-48b7-b495-dd73db8a9340 \
 *     node --import tsx scripts/verify-econf-issue-single-candidate.ts
 */
import { db, pool } from "../src/db/index.ts";
import { candidateDocuments } from "../src/db/schema.ts";
import { and, eq, isNotNull } from "drizzle-orm";

// The ONE candidate_document this mission authorized issuing — see PR #164
// (scripts/verify-econf-single-candidate.ts) for how it reached READY.
const EXPECTED_CANDIDATE_DOCUMENT_ID = "9bd3e051-c9f5-48b7-b495-dd73db8a9340";

// Clearly-labeled automation identity — never impersonates a real staff
// member. audit_logs/candidate_documents.issued_by are plain varchar (no FK
// to users), so this is safe: issuedBy is simply a text label.
const SCRIPT_USERNAME = "prod-verification-script";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  const targetId = process.env.CANDIDATE_DOCUMENT_ID ?? "";
  if (targetId !== EXPECTED_CANDIDATE_DOCUMENT_ID) {
    log("guardrail_id_mismatch", { expected: EXPECTED_CANDIDATE_DOCUMENT_ID, got: targetId || "(empty)" });
    console.error("❌ CANDIDATE_DOCUMENT_ID không khớp id đã được phê duyệt để phát hành. Dừng lại.");
    process.exit(1);
  }

  const [before] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, targetId)).limit(1);
  if (!before) {
    log("not_found", { targetId });
    console.error("❌ Không tìm thấy candidate_document.");
    process.exit(1);
  }
  log("before_state", { id: before.id, applicationId: before.applicationId, status: before.status, pdfSha256Present: Boolean(before.pdfSha256), storageKeyPresent: Boolean(before.storageKey) });

  // ---- Same atomic CAS UPDATE as
  // app/api/document-merge/candidate-documents/[id]/issue/route.ts ----
  const now = new Date();
  const [updated] = await db
    .update(candidateDocuments)
    .set({ status: "ISSUED", issuedAt: now, issuedBy: SCRIPT_USERNAME, updatedAt: now })
    .where(
      and(
        eq(candidateDocuments.id, targetId),
        eq(candidateDocuments.status, "READY"),
        isNotNull(candidateDocuments.pdfSha256),
        isNotNull(candidateDocuments.storageKey),
      ),
    )
    .returning({ id: candidateDocuments.id, applicationId: candidateDocuments.applicationId });

  if (!updated) {
    // CAS matched zero rows — report why, exactly like the real route does.
    const [current] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, targetId)).limit(1);
    log("issue_cas_failed", { currentStatus: current?.status ?? "UNKNOWN" });
    console.error(`❌ Không phát hành được — trạng thái hiện tại: ${current?.status ?? "UNKNOWN"} (cần READY + đã có pdf_sha256/storage_key).`);
    process.exit(1);
  }

  // Same audit shape as auth.ts's writeAudit() for DOCUMENT_ISSUED —
  // userId is null (no real staff session), username is the labeled script identity.
  try {
    const { auditLogs } = await import("../src/db/schema.ts");
    await db.insert(auditLogs).values({
      userId: null,
      username: SCRIPT_USERNAME,
      action: "DOCUMENT_ISSUED",
      targetType: "candidate_documents",
      category: "AUDIT",
      details: { candidateDocumentId: updated.id, applicationId: updated.applicationId },
    });
  } catch (err) {
    log("audit_write_failed_nonfatal", { error: err instanceof Error ? err.message : String(err) });
  }

  const [after] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, targetId)).limit(1);

  log("ISSUED_REACHED", {
    candidateDocumentId: updated.id,
    applicationId: updated.applicationId,
    statusBefore: before.status,
    statusAfter: after?.status,
    issuedAt: after?.issuedAt,
    issuedBy: after?.issuedBy,
  });

  await pool.end();
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "fatal_error", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
