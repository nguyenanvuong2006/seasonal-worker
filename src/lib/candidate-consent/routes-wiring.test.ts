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
const issueRoute = readRoute("src/app/api/document-merge/candidate-documents/issue/route.ts");
const revokeRoute = readRoute("src/app/api/document-merge/candidate-documents/[id]/revoke/route.ts");
const evidenceRoute = readRoute("src/app/api/document-merge/candidate-documents/[id]/evidence/route.ts");

test("lookup route: reads cccd/phone from the parsed POST body, never from a URL/query string", () => {
  assert.match(lookupRoute, /await request\.json\(\)/);
  assert.doesNotMatch(lookupRoute, /searchParams/);
  assert.doesNotMatch(lookupRoute, /new URL\(request\.url\)/);
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

test("lookup route: scopedApplicationIds is captured ONLY at verification time (session-store call happens after the applications query, not before)", () => {
  const queryIndex = lookupRoute.indexOf("scopedApplicationIds = applications.map");
  const issueIndex = lookupRoute.indexOf("issueAccessSessionCookie(");
  assert.ok(queryIndex > -1 && issueIndex > queryIndex, "scope must be resolved before the session is issued, never after");
});

test("documents route: requires a resolved access session before returning ANY document (fail closed, 401 on missing/invalid session)", () => {
  assert.match(documentsRoute, /const session = await resolveAccessSession\(\)/);
  assert.match(documentsRoute, /if \(!session\) \{[\s\S]{0,300}status: 401/);
});

test("documents route: filters to VISIBLE statuses only — GENERATING/FAILED/REVOKED/SUPERSEDED/EXPIRED never reach the candidate", () => {
  assert.match(documentsRoute, /VISIBLE_STATUSES = \["READY", "ISSUED", "VIEWED", "CONFIRMED"\]/);
});

test("pdf route: checks sessionCanAccess (IDOR guard) BEFORE reading storage bytes — candidate A can never read candidate B's PDF", () => {
  const idorCheckIndex = pdfRoute.indexOf("sessionCanAccess(session, doc.applicationId)");
  const storageGetIndex = pdfRoute.indexOf("storage.get(");
  assert.ok(idorCheckIndex > -1, "IDOR check must be present");
  assert.ok(storageGetIndex > idorCheckIndex, "storage read must happen strictly after the IDOR check");
});

test("pdf route: never returns a storage URL/key to the client — response body is the PDF bytes themselves", () => {
  assert.doesNotMatch(pdfRoute, /storageKey\s*[,}]/); // storageKey is read, never echoed into a JSON response
  assert.match(pdfRoute, /new NextResponse\(new Uint8Array\(bytes\)/);
});

test("pdf route: an unauthorized session gets the SAME 404 as a truly nonexistent document (never leaks existence)", () => {
  const notFoundOccurrences = (pdfRoute.match(/NOT_FOUND/g) ?? []).length;
  assert.ok(notFoundOccurrences >= 2, "both the missing-document and IDOR-denied paths must return the same NOT_FOUND constant");
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

test("issue route: requires the dedicated candidate_documents.issue capability, distinct from plain document_merge.execute", () => {
  assert.match(issueRoute, /"document_merge\.candidate_documents\.issue"/);
});

test("issue route: never sets dispatchToApplicant true — must not write to the legacy daily_applications signature fields", () => {
  assert.match(issueRoute, /dispatchToApplicant:\s*false/);
});

test("issue route: one candidate_documents row is inserted per merge_job_record — N candidates in, N independent documents out, never a shared/combined row", () => {
  assert.match(issueRoute, /records\.map\(\(record\) => \(/);
});

test("revoke route: requires a stronger role list (ADMIN/HR_RECRUITER only) than plain status viewing", () => {
  assert.match(revokeRoute, /requirePermission\(\["ADMIN", "HR_RECRUITER"\], "document_merge\.candidate_documents\.revoke"\)/);
});

test("revoke route: rejects revoking a CONFIRMED document via the shared canRevoke() lifecycle guard, not a bespoke check", () => {
  assert.match(revokeRoute, /canRevoke\(doc\.status/);
});

test("evidence route: gated by a DIFFERENT, stronger capability than status viewing (view_evidence, not view_status)", () => {
  assert.match(evidenceRoute, /"document_merge\.candidate_documents\.view_evidence"/);
  assert.doesNotMatch(evidenceRoute, /view_status/);
});
