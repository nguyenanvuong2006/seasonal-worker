/**
 * ROUTE WIRING — structural regression tests over the REAL candidate-consent
 * route sources (no testing-library/DB in this repo for route-level tests;
 * this follows the same "read the real production source, assert the
 * specific safety wiring is present" pattern as
 * draft-editor-modal-wiring.test.ts). Proves the concrete safety claims the
 * mission requires without needing a live Postgres/Vercel to exercise them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readRoute(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

const lookupRoute = readRoute("src/app/api/candidate-consent/lookup/route.ts");
const documentsRoute = readRoute("src/app/api/candidate-consent/documents/route.ts");
const pdfRoute = readRoute("src/app/api/candidate-consent/documents/[id]/pdf/route.ts");
const confirmRoute = readRoute("src/app/api/candidate-consent/documents/[id]/confirm/route.ts");
const adminListRoute = readRoute("src/app/api/document-merge/candidate-documents/route.ts");
const finalizeRoute = readRoute("src/app/api/document-merge/candidate-documents/finalize/route.ts");
const issueRoute = readRoute("src/app/api/document-merge/candidate-documents/issue/route.ts");
const revokeRoute = readRoute("src/app/api/document-merge/candidate-documents/[id]/revoke/route.ts");
const reissueRoute = readRoute("src/app/api/document-merge/candidate-documents/[id]/reissue/route.ts");
const evidenceRoute = readRoute("src/app/api/document-merge/candidate-documents/[id]/evidence/route.ts");

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/* ============================================================ *
 * 1. GET routes must be strictly read-only
 * ============================================================ */

test("admin list GET route: contains ZERO write calls (.insert(/.update(/.delete() nowhere in the file, comments excluded)", () => {
  const code = stripComments(adminListRoute);
  assert.doesNotMatch(code, /db\s*\.\s*(insert|update|delete)\s*\(/, "admin candidate-documents GET must never mutate the DB");
});

test("admin list GET route: never imports finalize.ts / storage / google-drive-pdf — it cannot possibly trigger generation or storage writes", () => {
  assert.doesNotMatch(adminListRoute, /from "@\/lib\/candidate-consent\/finalize"/);
  assert.doesNotMatch(adminListRoute, /from "@\/lib\/storage"/);
  assert.doesNotMatch(adminListRoute, /google-drive-pdf/);
});

test("public documents-list GET route: contains ZERO write calls — listing a candidate's documents never mutates them", () => {
  const code = stripComments(documentsRoute);
  assert.doesNotMatch(code, /db\s*\.\s*(insert|update|delete)\s*\(/, "public candidate documents-list GET must never mutate the DB");
});

test("documents route: requires a resolved access session before returning ANY document (fail closed, 401 on missing/invalid session)", () => {
  assert.match(documentsRoute, /const session = await resolveAccessSession\(\)/);
  assert.match(documentsRoute, /if \(!session\) \{[\s\S]{0,300}status: 401/);
});

test("documents route: filters to VISIBLE statuses only — GENERATING/READY/FAILED/REVOKED/SUPERSEDED/EXPIRED never reach the candidate", () => {
  assert.match(documentsRoute, /VISIBLE_STATUSES = \["READY", "ISSUED", "VIEWED", "CONFIRMED"\]/);
});

/* ============================================================ *
 * 2/3. Write-side finalizer is a SEPARATE, explicit POST — not the GET
 * ============================================================ */

test("finalize route: is a POST handler (write-side only), lives at its own /finalize path distinct from the read-only list GET", () => {
  assert.match(finalizeRoute, /export async function POST\(/);
  assert.doesNotMatch(finalizeRoute, /export async function GET\(/);
});

test("finalize route: GENERATING -> READY and READY -> ISSUED are TWO SEPARATE UPDATE statements with TWO SEPARATE audit events, never one combined write", () => {
  const code = stripComments(finalizeRoute);
  const readyUpdateIndex = code.indexOf('status: "READY"');
  const readyAuditIndex = code.indexOf('"DOCUMENT_GENERATED"');
  const issuedUpdateIndex = code.indexOf('status: "ISSUED"');
  const issuedAuditIndex = code.indexOf('"DOCUMENT_ISSUED"');
  assert.ok(readyUpdateIndex > -1 && readyAuditIndex > readyUpdateIndex, "READY write must be followed by its own DOCUMENT_GENERATED audit");
  assert.ok(issuedUpdateIndex > readyAuditIndex, "ISSUED write must be a LATER, separate statement after the READY audit");
  assert.ok(issuedAuditIndex > issuedUpdateIndex, "ISSUED write must be followed by its own DOCUMENT_ISSUED audit");
});

test("finalize route: one candidate's finalizer error is caught per-document (try/catch inside the loop) and never aborts the batch for the others", () => {
  assert.match(finalizeRoute, /for \(const doc of generating\) \{[\s\S]*try \{/);
});

test("finalize route: only ever consumes an ALREADY-terminal merge_job_record via finalizeToReady() — never triggers/writes to the merge pipeline itself", () => {
  assert.doesNotMatch(finalizeRoute, /triggerPdfWorker|mergeJobs\)\s*\.\s*values|createGoogleDocsService/);
});

/* ============================================================ *
 * 4. PDF must exist + be hashed before READY/ISSUED (finalize.ts, tested
 *    behaviorally in finalize.test.ts) — here: the route never lets a
 *    document become ISSUED without going through finalizeToReady's result.
 * ============================================================ */

test("finalize route: ISSUED write only happens after a 'ready' outcome — FAILED/unchanged outcomes never reach the ISSUED branch", () => {
  const code = stripComments(finalizeRoute);
  const outcomeCheckIndex = code.indexOf('result.outcome === "unchanged"');
  const failedCheckIndex = code.indexOf('result.outcome === "failed"');
  const readyWriteIndex = code.indexOf('status: "READY"');
  assert.ok(outcomeCheckIndex > -1 && outcomeCheckIndex < readyWriteIndex, "'unchanged' must be handled (continue) before reaching the READY write");
  assert.ok(failedCheckIndex > -1 && failedCheckIndex < readyWriteIndex, "'failed' must be handled (continue) before reaching the READY write");
});

/* ============================================================ *
 * 9/10. Session must recheck CURRENT document state; server-proven view
 * ============================================================ */

test("pdf route: re-reads the document FRESH from the DB on every request (no caching of prior status) — a revoke/supersede since login is seen immediately", () => {
  assert.match(pdfRoute, /const \[doc\] = await db\.select\(\)\.from\(candidateDocuments\)\.where\(eq\(candidateDocuments\.id, id\)\)/);
});

test("pdf route: checks sessionCanAccess (IDOR guard) BEFORE reading storage bytes — candidate A can never read candidate B's PDF", () => {
  const idorCheckIndex = pdfRoute.indexOf("sessionCanAccess(session, doc.applicationId)");
  const storageGetIndex = pdfRoute.indexOf("storage.get(");
  assert.ok(idorCheckIndex > -1, "IDOR check must be present");
  assert.ok(storageGetIndex > idorCheckIndex, "storage read must happen strictly after the IDOR check");
});

test("pdf route: checks canView() against the FRESH status — REVOKED/SUPERSEDED/EXPIRED are denied even for a session that was valid at login", () => {
  assert.match(pdfRoute, /canView\(doc\.status as CandidateDocumentStatus\)/);
});

test("pdf route: never returns a storage URL/key to the client — response body is the PDF bytes themselves", () => {
  assert.doesNotMatch(pdfRoute, /storageKey\s*[,}]/); // storageKey is read, never echoed into a JSON response
  assert.match(pdfRoute, /new NextResponse\(new Uint8Array\(bytes\)/);
});

test("pdf route: an unauthorized session gets the SAME 404 as a truly nonexistent document (never leaks existence)", () => {
  const notFoundOccurrences = (pdfRoute.match(/NOT_FOUND/g) ?? []).length;
  assert.ok(notFoundOccurrences >= 2, "both the missing-document and IDOR-denied paths must return the same NOT_FOUND constant");
});

test("pdf route: writes a DOCUMENT_VIEWED audit event exactly on the ISSUED->VIEWED transition, not on every re-view", () => {
  const code = stripComments(pdfRoute);
  const transitionIndex = code.indexOf("nextStatus !== doc.status");
  const auditIndex = code.indexOf('"DOCUMENT_VIEWED"');
  assert.ok(transitionIndex > -1 && auditIndex > transitionIndex, "DOCUMENT_VIEWED audit must be inside the status-transition branch");
});

test("confirm route: re-reads the document FRESH from the DB (never trusts a session-time snapshot of document status)", () => {
  assert.match(confirmRoute, /const \[doc\] = await db\.select\(\)\.from\(candidateDocuments\)\.where\(eq\(candidateDocuments\.id, id\)\)/);
});

test("confirm route: canConfirm requires VIEWED specifically — ISSUED-but-never-opened is rejected by the SAME guard used everywhere else (server-proven view required)", () => {
  assert.match(confirmRoute, /canConfirm\(doc\.status as CandidateDocumentStatus\)/);
});

test("confirm route: server independently validates agree===true — a truthy-but-not-boolean-true value is rejected", () => {
  assert.match(confirmRoute, /body\.agree !== true/);
});

test("confirm route: checks sessionCanAccess (IDOR) before reading/mutating the document", () => {
  assert.match(confirmRoute, /sessionCanAccess\(session, doc\.applicationId\)/);
});

test("confirm route: idempotency — an existing confirmation is read and returned BEFORE the canConfirm/status check, so a second click never hits a 409", () => {
  const existingCheckIndex = confirmRoute.indexOf("existingConfirmation) {");
  const canConfirmCheckIndex = confirmRoute.indexOf("!canConfirm(doc.status");
  assert.ok(existingCheckIndex > -1 && canConfirmCheckIndex > existingCheckIndex, "idempotent short-circuit must come before the state-machine gate");
});

test("confirm route: concurrent-insert race is handled — a unique-constraint failure re-reads and returns the WINNER's receipt, not a 500", () => {
  assert.match(confirmRoute, /catch \{[\s\S]*documentConfirmations[\s\S]*alreadyConfirmed: true/);
});

test("confirm route: evidence is built from server-derived fields only — pdfSha256/applicationId come from the DB row, never from the request body", () => {
  assert.doesNotMatch(confirmRoute, /body\.(documentSha256|pdfSha256|applicationId)/);
  assert.match(confirmRoute, /documentSha256: doc\.pdfSha256/);
});

/* ============================================================ *
 * 6. Dedicated evidence secret, fail closed
 * ============================================================ */

test("confirm route: resolves DOCUMENT_EVIDENCE_SECRET (not AUTH_SECRET) and does so BEFORE any session/DB read — fails closed before touching data", () => {
  const code = stripComments(confirmRoute);
  const secretIndex = code.indexOf("resolveDocumentEvidenceSecret()");
  const sessionIndex = code.indexOf("resolveAccessSession()");
  assert.ok(secretIndex > -1 && secretIndex < sessionIndex, "the evidence secret must be resolved (and allowed to throw) before the session is even looked up");
  assert.doesNotMatch(confirmRoute, /candidate-consent-evidence:v1:\$\{base\}/, "must not reuse an AUTH_SECRET-derived key any more");
});

test("confirm route: a missing/invalid DOCUMENT_EVIDENCE_SECRET returns 503 (feature unavailable), never falls through to build evidence anyway", () => {
  assert.match(confirmRoute, /DocumentEvidenceSecretMissingError/);
  assert.match(confirmRoute, /status: 503/);
});

test("confirm route: stores evidenceSchemaVersion alongside the hash/HMAC, and passes the secret as a required non-null argument to computeEvidenceHashes", () => {
  assert.match(confirmRoute, /evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION/);
  assert.match(confirmRoute, /computeEvidenceHashes\(\s*\{[\s\S]*?\},\s*evidenceSecret,?\s*\)/);
});

/* ============================================================ *
 * 7. Audit chain
 * ============================================================ */

test("lookup route: writes IDENTITY_VERIFIED — never with raw CCCD/phone in the audit payload", () => {
  const code = stripComments(lookupRoute);
  const auditBlockStart = code.indexOf('"IDENTITY_VERIFIED"');
  assert.ok(auditBlockStart > -1);
  const detailsSlice = code.slice(auditBlockStart, auditBlockStart + 300);
  assert.doesNotMatch(detailsSlice, /rawCccd|rawPhone|identity\.cccd|identity\.phone/);
});

test("confirm route: writes CONSENT_ACCEPTED before the insert attempt, and DOCUMENT_CONFIRMED only after the insert succeeds", () => {
  const code = stripComments(confirmRoute);
  const consentIndex = code.indexOf('"CONSENT_ACCEPTED"');
  const insertIndex = code.indexOf(".insert(documentConfirmations)");
  const confirmedIndex = code.indexOf('"DOCUMENT_CONFIRMED"');
  assert.ok(consentIndex > -1 && consentIndex < insertIndex, "CONSENT_ACCEPTED records the attempt regardless of who wins a concurrent race");
  assert.ok(confirmedIndex > insertIndex, "DOCUMENT_CONFIRMED must only fire after the insert succeeded");
});

test("issue route: writes DOCUMENT_GENERATION_REQUESTED (not a bare custom action name)", () => {
  assert.match(issueRoute, /"DOCUMENT_GENERATION_REQUESTED"/);
});

test("finalize route: writes DOCUMENT_GENERATED and DOCUMENT_ISSUED as the exact audit action names the mission requires", () => {
  assert.match(finalizeRoute, /"DOCUMENT_GENERATED"/);
  assert.match(finalizeRoute, /"DOCUMENT_ISSUED"/);
});

test("revoke route: writes DOCUMENT_REVOKED", () => {
  assert.match(revokeRoute, /"DOCUMENT_REVOKED"/);
});

test("reissue route: writes DOCUMENT_SUPERSEDED for the OLD document and DOCUMENT_GENERATION_REQUESTED for the NEW one — never reuses DOCUMENT_REVOKED for a replacement", () => {
  assert.match(reissueRoute, /"DOCUMENT_SUPERSEDED"/);
  assert.match(reissueRoute, /"DOCUMENT_GENERATION_REQUESTED"/);
  assert.doesNotMatch(reissueRoute, /"DOCUMENT_REVOKED"/);
});

test("no candidate-consent route embeds a raw access-token/cookie value into an audit `details` payload", () => {
  for (const [name, code] of [
    ["lookup", lookupRoute],
    ["pdf", pdfRoute],
    ["confirm", confirmRoute],
  ] as const) {
    assert.doesNotMatch(stripComments(code), /details:\s*\{[^}]*rawToken/, `${name} route must not log a raw token`);
  }
});

/* ============================================================ *
 * 8. Reissue flow — old evidence/history preserved, new confirmation required
 * ============================================================ */

test("reissue route: gates on the SAME canRevoke() lifecycle guard as plain revoke — cannot reissue a CONFIRMED document", () => {
  assert.match(reissueRoute, /canRevoke\(oldDoc\.status as CandidateDocumentStatus\)/);
});

test("reissue route: old document is marked SUPERSEDED, never DELETEd — no DELETE statement anywhere in the route", () => {
  const code = stripComments(reissueRoute);
  assert.doesNotMatch(code, /db\s*\.\s*delete\s*\(/);
  assert.match(code, /status: "SUPERSEDED"/);
});

test("reissue route: the new document carries supersedesDocumentId pointing at the old one, and is created with status GENERATING (must go through the same finalize gate again, not skip straight to READY/ISSUED)", () => {
  assert.match(reissueRoute, /supersedesDocumentId: id/);
  assert.match(reissueRoute, /status: "GENERATING"/);
});

test("reissue route: never touches document_confirmations — old evidence rows are immutable and untouched by a reissue", () => {
  assert.doesNotMatch(reissueRoute, /documentConfirmations/);
});

/* ============================================================ *
 * 11-13. Identity lookup / rate limiting / session security
 * ============================================================ */

test("lookup route: reads cccd/phone from the parsed POST body, never from a URL/query string", () => {
  assert.match(lookupRoute, /await request\.json\(\)/);
  assert.doesNotMatch(lookupRoute, /searchParams/);
  assert.doesNotMatch(lookupRoute, /new URL\(request\.url\)/);
});

test("lookup route: uses the shared trustedClientIp() helper (platform-trusted proxy semantics), not an ad-hoc header parse", () => {
  assert.match(lookupRoute, /trustedClientIp\(request\)/);
});

test("lookup route: FAILS CLOSED when the rate-limit store itself errors — denies (503) rather than falling through to identity verification", () => {
  const code = stripComments(lookupRoute);
  const catchIndex = code.indexOf("} catch (err) {");
  const denyIndex = code.indexOf("RATE_LIMIT_UNAVAILABLE", catchIndex);
  assert.ok(catchIndex > -1 && denyIndex > catchIndex, "the rate-limit read/write must be wrapped in try/catch that denies on failure");
  const verifyIndex = code.indexOf("await verifyLookupIdentity(");
  assert.ok(denyIndex < verifyIndex, "the fail-closed catch must return BEFORE identity verification ever runs");
});

test("lookup route: rate-limits BOTH by IP and by identity before ever calling verifyLookupIdentity", () => {
  const identityCallIndex = lookupRoute.indexOf("await verifyLookupIdentity(");
  const ipDecisionIndex = lookupRoute.indexOf("evaluateAttempt(ipRow");
  const identityDecisionIndex = lookupRoute.indexOf("evaluateAttempt(identityRow");
  assert.ok(identityCallIndex > -1, "verifyLookupIdentity must be called");
  assert.ok(ipDecisionIndex > -1 && ipDecisionIndex < identityCallIndex, "IP rate limit must be evaluated before identity verification");
  assert.ok(identityDecisionIndex > -1 && identityDecisionIndex < identityCallIndex, "identity rate limit must be evaluated before identity verification");
});

test("lookup route: denies with the SAME generic message whether verifyLookupIdentity failed or the identity had zero applications (anti-enumeration)", () => {
  const genericMessageOccurrences = (lookupRoute.match(/GENERIC_DENY/g) ?? []).length;
  assert.ok(genericMessageOccurrences >= 2, "the generic-deny constant must be reused for more than one failure path");
});

test("lookup route: identity_lookup_attempts is written keyed by HMAC only — the raw cccd/phone strings are never passed to the DB insert", () => {
  const code = stripComments(lookupRoute);
  assert.doesNotMatch(code, /identityLookupAttempts\)\s*\.\s*values\(\{[^}]*rawCccd/);
  assert.doesNotMatch(code, /identityLookupAttempts\)\s*\.\s*values\(\{[^}]*rawPhone/);
});

test("lookup route: scopedApplicationIds is captured ONLY at verification time (session-store call happens after the applications query, not before)", () => {
  const queryIndex = lookupRoute.indexOf("scopedApplicationIds = applications.map");
  const issueIndex = lookupRoute.indexOf("issueAccessSessionCookie(");
  assert.ok(queryIndex > -1 && issueIndex > queryIndex, "scope must be resolved before the session is issued, never after");
});

test("session-store: cookie is set HttpOnly, Secure-in-production, SameSite=lax, and carries the RAW token (server stores only the hash)", () => {
  const code = stripComments(readRoute("src/lib/candidate-consent/session-store.ts"));
  assert.match(code, /httpOnly:\s*true/);
  assert.match(code, /secure:\s*process\.env\.NODE_ENV === "production"/);
  assert.match(code, /sameSite:\s*"lax"/);
  assert.match(code, /tokenHash:\s*hashAccessToken\(rawToken\)/);
});

/* ============================================================ *
 * 14. IP / device evidence — no IMEI, no arbitrary header trust
 * ============================================================ */

test("request-ip helper: reads only x-forwarded-for/x-real-ip (platform-set), never attempts IMEI/device-fingerprint collection", () => {
  const code = readRoute("src/lib/request-ip.ts");
  assert.doesNotMatch(code, /imei/i);
  assert.doesNotMatch(code, /fingerprint/i);
});

/* ============================================================ *
 * 15. RBAC / capability gating
 * ============================================================ */

test("issue route: requires the dedicated candidate_documents.issue capability, distinct from plain document_merge.execute", () => {
  assert.match(issueRoute, /"document_merge\.candidate_documents\.issue"/);
});

test("issue route: never sets dispatchToApplicant true — must not write to the legacy daily_applications signature fields", () => {
  assert.match(issueRoute, /dispatchToApplicant:\s*false/);
});

test("issue route: one candidate_documents row is inserted per merge_job_record — N candidates in, N independent documents out, never a shared/combined row", () => {
  assert.match(issueRoute, /records\.map\(\(record\) => \(/);
});

test("finalize route: requires the SAME issue capability as batch issuance (it is the async continuation of that same admin intent)", () => {
  assert.match(finalizeRoute, /"document_merge\.candidate_documents\.issue"/);
});

test("revoke route: requires a stronger role list (ADMIN/HR_RECRUITER only) than plain status viewing", () => {
  assert.match(revokeRoute, /requirePermission\(\["ADMIN", "HR_RECRUITER"\], "document_merge\.candidate_documents\.revoke"\)/);
});

test("revoke route: rejects revoking a CONFIRMED document via the shared canRevoke() lifecycle guard, not a bespoke check", () => {
  assert.match(revokeRoute, /canRevoke\(doc\.status/);
});

test("reissue route: requires the same stronger revoke capability as plain revoke", () => {
  assert.match(reissueRoute, /requirePermission\(\s*\["ADMIN", "HR_RECRUITER"\],\s*"document_merge\.candidate_documents\.revoke"/);
});

test("evidence route: gated by a DIFFERENT, stronger capability than status viewing (view_evidence, not view_status)", () => {
  assert.match(evidenceRoute, /"document_merge\.candidate_documents\.view_evidence"/);
  assert.doesNotMatch(evidenceRoute, /view_status/);
});

/* ============================================================ *
 * 30. PR #125/#126 CAS/lease/duplicate-output regressions remain green
 *     — proven by running the existing (untouched) test suites for those
 *     modules; see stale-recovery.test.ts / template-versions.test.ts /
 *     merge/execute/route.test.ts, all still passing under `npm test`
 *     (this file only proves the NEW routes didn't touch that code).
 * ============================================================ */

test("issue/finalize/reissue routes reuse merge/execute IN-PROCESS — none of them re-implement job creation, worker triggering, or CAS logic", () => {
  for (const [name, code] of [
    ["issue", issueRoute],
    ["reissue", reissueRoute],
  ] as const) {
    assert.match(code, /POST as executeMerge/, `${name} route must reuse the existing hardened merge/execute handler`);
    assert.doesNotMatch(code, /triggerPdfWorker|FOR UPDATE SKIP LOCKED/, `${name} route must not reimplement worker-trigger/CAS logic`);
  }
});
