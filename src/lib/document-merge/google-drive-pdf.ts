import crypto from "node:crypto";
import { fetchWithTimeout } from "./merge-timing.ts";

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type AuthSource = "oauth_user" | "service_account";

let cachedToken: { value: string; expiresAt: number; source: AuthSource } | null = null;

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

async function exchangeRefreshToken(clientId: string, clientSecret: string, refreshToken: string): Promise<TokenResponse> {
  const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  return response.json() as Promise<TokenResponse>;
}

async function exchangeServiceAccountToken(email: string, privateKey: string, impersonateUser?: string): Promise<TokenResponse> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payloadData: Record<string, string | number> = {
    iss: email,
    scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  if (impersonateUser) payloadData.sub = impersonateUser;
  const payload = base64Url(JSON.stringify(payloadData));
  const signingInput = `${header}.${payload}`;
  const normalizedKey = privateKey.replace(/\\n/g, "\n");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), normalizedKey);
  const assertion = `${signingInput}.${base64Url(signature)}`;

  const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  return response.json() as Promise<TokenResponse>;
}

async function resolveAccessToken(): Promise<string> {
  const hasOAuth = Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim() &&
      process.env.GOOGLE_REFRESH_TOKEN?.trim(),
  );
  const source: AuthSource = hasOAuth ? "oauth_user" : "service_account";

  if (cachedToken && cachedToken.source === source && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  let result: TokenResponse | null = null;
  if (hasOAuth) {
    result = await exchangeRefreshToken(
      process.env.GOOGLE_CLIENT_ID!.trim(),
      process.env.GOOGLE_CLIENT_SECRET!.trim(),
      process.env.GOOGLE_REFRESH_TOKEN!.trim(),
    );
  } else {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
    const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
    if (email && key) {
      result = await exchangeServiceAccountToken(
        email,
        key,
        process.env.GOOGLE_IMPERSONATE_USER_EMAIL?.trim() || undefined,
      );
    }
  }

  if (!result?.access_token) {
    throw new Error(
      `BATCH_PDF_GOOGLE_AUTH_FAILED: ${result?.error_description || result?.error || "missing Google OAuth credentials"}`,
    );
  }

  cachedToken = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(300, result.expires_in ?? 3600) * 1000,
    source,
  };
  return cachedToken.value;
}

async function authHeaders(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await resolveAccessToken()}` };
}

export async function exportGoogleDocAsPdf(docId: string): Promise<Uint8Array> {
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/export?mimeType=${encodeURIComponent("application/pdf")}`,
    { headers: await authHeaders() },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`BATCH_PDF_EXPORT_${response.status}: ${detail.slice(0, 800)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function uploadPdfToDrive(
  filename: string,
  bytes: Uint8Array,
  folderId?: string | null,
): Promise<{ id: string; webViewLink: string | null; webContentLink: string | null }> {
  const boundary = `seasonal_worker_${crypto.randomBytes(12).toString("hex")}`;
  const metadata: Record<string, unknown> = {
    name: filename.endsWith(".pdf") ? filename : `${filename}.pdf`,
    mimeType: "application/pdf",
  };
  if (folderId) metadata.parents = [folderId];

  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, Buffer.from(bytes), tail]);

  const response = await fetchWithTimeout(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        ...(await authHeaders()),
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`BATCH_PDF_UPLOAD_${response.status}: ${detail.slice(0, 800)}`);
  }

  const result = (await response.json()) as {
    id: string;
    webViewLink?: string;
    webContentLink?: string;
  };
  return {
    id: result.id,
    webViewLink: result.webViewLink ?? null,
    webContentLink: result.webContentLink ?? null,
  };
}
