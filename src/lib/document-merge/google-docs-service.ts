/**
 * Document Merge Engine — Google Docs / Drive service.
 *
 * Production merge copies the real Google Docs template and performs
 * replaceAllText on the copy, preserving the original document formatting.
 * Batch-print output uses real Docs insertPageBreak requests.
 */

import crypto from "node:crypto";
import { replaceMultiplePlaceholders } from "./placeholder-extractor.ts";

export const PAGE_BREAK_TEXT = "\n\n--- DOCUMENT_MERGE_PAGE_BREAK ---\n\n";

export interface GoogleDocsService {
  getDocumentContent(docId: string): Promise<string>;
  copyDocument(docId: string, folderId?: string, title?: string): Promise<string>;
  updateDocumentContent(docId: string, content: string): Promise<void>;
  replacePlaceholders(docId: string, replacements: PlaceholderReplacement[]): Promise<void>;
  createDocument(title: string, content: string, folderId?: string): Promise<string>;
  documentExists(docId: string): Promise<boolean>;
  getDocumentPermissions(docId: string): Promise<string[]>;
}

export interface PlaceholderReplacement {
  placeholder: string;
  value: string;
}

type MockDoc = { title: string; content: string };

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

async function exchangeServiceAccountToken(email: string, privateKey: string): Promise<TokenResponse> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const normalizedKey = privateKey.replace(/\\n/g, "\n");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), normalizedKey);
  const assertion = `${signingInput}.${base64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  return response.json() as Promise<TokenResponse>;
}

async function exchangeRefreshToken(clientId: string, clientSecret: string, refreshToken: string): Promise<TokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
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

async function resolveAccessToken(explicitToken?: string): Promise<string> {
  if (explicitToken) return explicitToken;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  let result: TokenResponse | null = null;
  const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const servicePrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (serviceEmail && servicePrivateKey) {
    result = await exchangeServiceAccountToken(serviceEmail, servicePrivateKey);
  } else {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (clientId && clientSecret && refreshToken) {
      result = await exchangeRefreshToken(clientId, clientSecret, refreshToken);
    }
  }

  if (!result?.access_token) {
    const detail = result?.error_description || result?.error || "missing Google OAuth credentials";
    throw new Error(
      `Document Merge chưa kết nối Google Docs/Drive (${detail}). Cấu hình service account hoặc OAuth refresh token trong Vercel.`,
    );
  }

  cachedToken = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(300, result.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

export class MockGoogleDocsService implements GoogleDocsService {
  private documents = new Map<string, MockDoc>();

  async getDocumentContent(docId: string): Promise<string> {
    const doc = this.documents.get(docId);
    if (doc) return doc.content;
    return [
      "HỌ TÊN: <<Ho_ten>>",
      "NGÀY SINH: <<Ngay_sinh>>",
      "SỐ CCCD: <<So_CCCD>>",
      "ĐỊA CHỈ: <<Dia_chi>>",
      "NGÀY ĐĂNG KÝ: <<Ngay_dang_ky>>",
      "BỘ PHẬN: <<Bo_phan>>",
    ].join("\n");
  }

  async copyDocument(docId: string, _folderId?: string, title?: string): Promise<string> {
    const sourceDoc = await this.getDocumentContent(docId);
    const newId = `mock_copy_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.documents.set(newId, { title: title || `Copy of ${docId}`, content: sourceDoc });
    return newId;
  }

  async updateDocumentContent(docId: string, content: string): Promise<void> {
    const existing = this.documents.get(docId);
    this.documents.set(docId, { title: existing?.title || docId, content });
  }

  async replacePlaceholders(docId: string, replacements: PlaceholderReplacement[]): Promise<void> {
    const content = await this.getDocumentContent(docId);
    const values: Record<string, string> = {};
    for (const item of replacements) values[item.placeholder] = item.value;
    await this.updateDocumentContent(docId, replaceMultiplePlaceholders(content, values));
  }

  async createDocument(title: string, content: string, _folderId?: string): Promise<string> {
    const id = `mock_new_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.documents.set(id, { title, content });
    return id;
  }

  async documentExists(docId: string): Promise<boolean> {
    return this.documents.has(docId) || /^\d/.test(docId) || docId.startsWith("mock_");
  }

  async getDocumentPermissions(_docId: string): Promise<string[]> {
    return ["anyone"];
  }
}

export class RealGoogleDocsService implements GoogleDocsService {
  private readonly explicitAccessToken?: string;
  private readonly docsUrl = "https://docs.googleapis.com/v1";
  private readonly driveUrl = "https://www.googleapis.com/drive/v3";

  constructor(accessToken?: string) {
    this.explicitAccessToken = accessToken;
  }

  private async authHeader(): Promise<Record<string, string>> {
    const token = await resolveAccessToken(this.explicitAccessToken);
    return { Authorization: `Bearer ${token}` };
  }

  private async requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(await this.authHeader()),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Google API ${response.status}: ${detail.slice(0, 800)}`);
    }
    return response.json() as Promise<T>;
  }

  private async docsBatchUpdate(docId: string, requests: Record<string, unknown>[]): Promise<void> {
    if (requests.length === 0) return;
    await this.requestJson(`${this.docsUrl}/documents/${encodeURIComponent(docId)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests }),
    });
  }

  async getDocumentContent(docId: string): Promise<string> {
    const url = `${this.driveUrl}/files/${encodeURIComponent(docId)}/export?mimeType=${encodeURIComponent("text/plain")}`;
    const response = await fetch(url, { headers: await this.authHeader() });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Không đọc được Google Docs (${response.status}): ${detail.slice(0, 500)}`);
    }
    return response.text();
  }

  async copyDocument(docId: string, folderId?: string, title?: string): Promise<string> {
    const body: Record<string, unknown> = { name: title || `Merge_${Date.now()}` };
    if (folderId) body.parents = [folderId];
    const result = await this.requestJson<{ id: string }>(
      `${this.driveUrl}/files/${encodeURIComponent(docId)}/copy?fields=id`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return result.id;
  }

  async replacePlaceholders(docId: string, replacements: PlaceholderReplacement[]): Promise<void> {
    const requests = replacements
      .filter((item) => item.placeholder.trim().length > 0)
      .map((item) => ({
        replaceAllText: {
          containsText: {
            text: `<<${item.placeholder.replace(/^<<|>>$/g, "")}>>`,
            matchCase: true,
          },
          replaceText: item.value ?? "",
        },
      }));
    await this.docsBatchUpdate(docId, requests);
  }

  async updateDocumentContent(docId: string, content: string): Promise<void> {
    const document = await this.requestJson<{ body?: { content?: Array<{ endIndex?: number }> } }>(
      `${this.docsUrl}/documents/${encodeURIComponent(docId)}`,
    );
    const blocks = document.body?.content ?? [];
    const endIndex = blocks.reduce((max, block) => Math.max(max, block.endIndex ?? 1), 1);
    const requests: Record<string, unknown>[] = [];
    if (endIndex > 2) {
      requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
    }

    const parts = content.split(PAGE_BREAK_TEXT);
    let index = 1;
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      if (text) {
        requests.push({ insertText: { location: { index }, text } });
        index += text.length;
      }
      if (i < parts.length - 1) {
        requests.push({ insertPageBreak: { location: { index } } });
        index += 1;
      }
    }
    await this.docsBatchUpdate(docId, requests);
  }

  async createDocument(title: string, content: string, folderId?: string): Promise<string> {
    const created = await this.requestJson<{ documentId: string }>(`${this.docsUrl}/documents`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    const docId = created.documentId;

    if (folderId) {
      const meta = await this.requestJson<{ parents?: string[] }>(
        `${this.driveUrl}/files/${encodeURIComponent(docId)}?fields=parents`,
      );
      const removeParents = (meta.parents ?? []).join(",");
      const params = new URLSearchParams({ addParents: folderId, fields: "id,parents" });
      if (removeParents) params.set("removeParents", removeParents);
      await this.requestJson(`${this.driveUrl}/files/${encodeURIComponent(docId)}?${params.toString()}`, {
        method: "PATCH",
        body: JSON.stringify({}),
      });
    }

    await this.updateDocumentContent(docId, content);
    return docId;
  }

  async documentExists(docId: string): Promise<boolean> {
    try {
      await this.requestJson(`${this.driveUrl}/files/${encodeURIComponent(docId)}?fields=id,trashed`);
      return true;
    } catch {
      return false;
    }
  }

  async getDocumentPermissions(docId: string): Promise<string[]> {
    const result = await this.requestJson<{ permissions?: Array<{ type: string }> }>(
      `${this.driveUrl}/files/${encodeURIComponent(docId)}/permissions?fields=permissions(type)`,
    );
    return (result.permissions ?? []).map((item) => item.type);
  }
}

export function createGoogleDocsService(accessToken?: string): GoogleDocsService {
  const allowMock = process.env.NODE_ENV === "test" || process.env.DOCUMENT_MERGE_USE_MOCK === "true";
  if (allowMock && !accessToken && !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !process.env.GOOGLE_REFRESH_TOKEN) {
    return new MockGoogleDocsService();
  }
  return new RealGoogleDocsService(accessToken);
}

export function replacePlaceholdersInContent(
  content: string,
  replacements: PlaceholderReplacement[],
): string {
  const replacementMap: Record<string, string> = {};
  for (const item of replacements) replacementMap[item.placeholder] = item.value;
  return replaceMultiplePlaceholders(content, replacementMap);
}

export function mergeRecordsToDocument(_baseContent: string, recordContents: string[]): string {
  return recordContents.join(PAGE_BREAK_TEXT);
}
