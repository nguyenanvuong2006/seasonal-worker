#!/usr/bin/env node
/**
 * VERIFY PRODUCTION GOOGLE AUTH — READ-ONLY, NO CANDIDATE DATA.
 *
 * Directly exercises the EXACT credential the Cloud Run production worker
 * uses (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN —
 * same 3 env vars, same exchange call as src/lib/storage/google-drive.ts's
 * exchangeRefreshToken()) WITHOUT creating any merge job, candidate, or
 * writing anything to Drive/Docs. Proves:
 *   1. the refresh token exchanges for an access token (the exact failure
 *      mode being fixed: "Token has been expired or revoked.")
 *   2. that access token authenticates to Google Drive (files.get metadata
 *      only — never content)
 *   3. that access token authenticates to Google Docs (documents.get with
 *      a fields mask limited to documentId+title — never body content)
 *   4. that the SAME access token can perform the exact plain-text export
 *      call google-docs-service.ts's getDocumentContent() makes — the
 *      function both the Cloud Run worker's real merge jobs and the new
 *      POST /read-google-doc endpoint (the "Quét lại Google Docs" Admin
 *      scan fallback, 2026-09) call. Only the HTTP status and byte length
 *      are reported — document body content is fetched but NEVER printed
 *      or logged.
 * against a REAL, already-committed production template
 * (production-readiness.ts's DANG_KY_TAP_NGHE_GOOGLE_DOC_ID — not a
 * secret, not PII, already public in this repo's source).
 *
 * Cách dùng:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... \
 *     node scripts/verify-production-google-auth.mjs
 *
 * Never prints access_token/refresh_token/client_secret — only booleans,
 * HTTP status codes, and non-sensitive document metadata (id/title/name/
 * mimeType/modifiedTime), never document body content.
 */

// Same real production template already referenced by
// src/lib/document-merge/production-readiness.ts — public in source, not a
// secret, not candidate data.
const TEMPLATE_GOOGLE_DOC_ID = "10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim();
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim();
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN?.trim();

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("❌ Thiếu GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN.");
  process.exit(1);
}

const results = {};
let exitCode = 0;

// 1) Exchange refresh token for an access token — the exact call and the
// exact failure mode being verified as fixed.
const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: "refresh_token",
  }),
});
const tokenJson = await tokenRes.json();
const accessToken = tokenJson.access_token;
results.refresh_token_exchange = {
  httpStatus: tokenRes.status,
  ok: Boolean(accessToken),
  // Google's own error/error_description on failure — this is exactly
  // where "Token has been expired or revoked." would appear; never the
  // token itself.
  error: accessToken ? null : (tokenJson.error_description || tokenJson.error || "unknown"),
};
console.log(JSON.stringify({ event: "refresh_token_exchange", ...results.refresh_token_exchange }));

if (!accessToken) {
  console.log(JSON.stringify({ event: "done", allPass: false, reason: "refresh token exchange failed" }));
  process.exit(1);
}

// 2) Drive auth — metadata-only read of a real production template file.
// Never requests or logs file content.
const driveRes = await fetch(
  `https://www.googleapis.com/drive/v3/files/${TEMPLATE_GOOGLE_DOC_ID}?fields=id,name,mimeType,modifiedTime,trashed`,
  { headers: { Authorization: `Bearer ${accessToken}` } },
);
const driveJson = await driveRes.json().catch(() => ({}));
results.google_drive_auth = {
  httpStatus: driveRes.status,
  ok: driveRes.ok,
  name: driveRes.ok ? driveJson.name : undefined,
  mimeType: driveRes.ok ? driveJson.mimeType : undefined,
  modifiedTime: driveRes.ok ? driveJson.modifiedTime : undefined,
  trashed: driveRes.ok ? driveJson.trashed : undefined,
  error: driveRes.ok ? null : (driveJson.error?.message ?? `HTTP ${driveRes.status}`),
};
console.log(JSON.stringify({ event: "google_drive_auth", ...results.google_drive_auth }));
if (!driveRes.ok) exitCode = 1;

// 3) Docs auth — fields mask limited to documentId+title ONLY. Never reads
// or logs body/placeholder content.
const docsRes = await fetch(
  `https://docs.googleapis.com/v1/documents/${TEMPLATE_GOOGLE_DOC_ID}?fields=documentId,title`,
  { headers: { Authorization: `Bearer ${accessToken}` } },
);
const docsJson = await docsRes.json().catch(() => ({}));
results.google_docs_auth = {
  httpStatus: docsRes.status,
  ok: docsRes.ok,
  title: docsRes.ok ? docsJson.title : undefined,
  error: docsRes.ok ? null : (docsJson.error?.message ?? `HTTP ${docsRes.status}`),
};
console.log(JSON.stringify({ event: "google_docs_auth", ...results.google_docs_auth }));
if (!docsRes.ok) exitCode = 1;

// 4) Plain-text export — the EXACT call getDocumentContent() makes
// (google-docs-service.ts), now also reachable from the Cloud Run worker's
// POST /read-google-doc for the Admin "Quét lại Google Docs" scan fallback.
// Content is read to measure length only; never printed/logged.
const exportRes = await fetch(
  `https://www.googleapis.com/drive/v3/files/${TEMPLATE_GOOGLE_DOC_ID}/export?mimeType=${encodeURIComponent("text/plain")}&supportsAllDrives=true`,
  { headers: { Authorization: `Bearer ${accessToken}` } },
);
const exportText = exportRes.ok ? await exportRes.text() : await exportRes.text().catch(() => "");
results.google_docs_plaintext_export = {
  httpStatus: exportRes.status,
  ok: exportRes.ok,
  contentLength: exportRes.ok ? exportText.length : undefined,
  error: exportRes.ok ? null : `HTTP ${exportRes.status}`,
};
console.log(JSON.stringify({ event: "google_docs_plaintext_export", ...results.google_docs_plaintext_export }));
if (!exportRes.ok) exitCode = 1;

const allPass =
  results.refresh_token_exchange.ok &&
  results.google_drive_auth.ok &&
  results.google_docs_auth.ok &&
  results.google_docs_plaintext_export.ok;
console.log(JSON.stringify({ event: "done", allPass }));
process.exit(exitCode);
