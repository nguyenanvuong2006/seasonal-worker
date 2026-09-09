/**
 * Regression test for the 2026-09 blank-PDF root cause: a Google OAuth
 * token-exchange failure (invalid_grant) was surfaced as
 * "GOOGLE_DRIVE_AUTH_FAILED: Bad Request" — prioritizing the generic
 * error_description over the actionable error code, making the real cause
 * (an invalid/revoked refresh token) undiagnosable from application logs
 * alone. This file gets its own process (node:test isolates separate test
 * files), so the module's cachedToken starts fresh — no cross-test pollution
 * with google-drive.hardening.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("GoogleDriveStorageProvider.get() surfaces BOTH the OAuth error code and description on a failed token exchange", async () => {
  const originalFetch = global.fetch;
  // @ts-ignore
  global.fetch = async (url: string | URL) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("oauth2.googleapis.com/token")) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant", error_description: "Bad Request" }),
        text: async () => JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }),
      } as unknown as Response;
    }
    throw new Error(`Unexpected fetch in this test: ${urlStr}`);
  };

  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "";

  try {
    const { GoogleDriveStorageProvider } = await import("./google-drive.ts");
    const provider = new GoogleDriveStorageProvider();
    await assert.rejects(
      () => provider.get("Candidate Documents/2026/09/09/some-file.pdf"),
      (error: Error) => {
        assert.match(error.message, /GOOGLE_DRIVE_AUTH_FAILED/);
        assert.match(error.message, /invalid_grant/, "the actionable OAuth error code must be included");
        assert.match(error.message, /Bad Request/, "the description must still be included alongside the code");
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});
