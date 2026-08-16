/**
 * Document Merge Engine — Google Docs / Drive service.
 *
 * Production merge MUST preserve the real Google Docs template formatting.
 * A rendered single-record document is therefore created by copying the
 * source template and replacing <<placeholders>> on the copy. We never
 * rebuild a template from exported plain text in production.
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

type AuthSource = "oauth_user" | "service_account";

type TemplateSnapshot = {
  docId: string;
  content: string;
  capturedAt: number;
};

let cachedToken: { value: string; expiresAt: number; source: AuthSource } | null = null;

// The merge route reads the source template before it creates the output.
// Keep a short-lived in-process snapshot so createDocument() can identify
// which real template produced the rendered text and copy that template.
const templateSnapshots = new Map<string, TemplateSnapshot>();
const FORMAT_PRESERVED_OUTPUTS = new Set<string>();
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const MAX_TEMPLATE_SNAPSHOTS = 30;

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

async function exchangeServiceAccountToken(
  email: string,
  privateKey: string,
  impersonateUser?: string,
): Promise<TokenResponse> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const jwtPayload: Record<string, string | number> = {
    iss: email,
    scope: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  // Optional Google Workspace domain-wide delegation. When configured by a
  // Workspace admin, this lets the service account act as a real Drive user
  // for My Drive write operations instead of trying to own files itself.
  if (impersonateUser) jwtPayload.sub = impersonateUser;

  const payload = base64Url(JSON.stringify(jwtPayload));
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

function configuredAuthSource(): AuthSource | null {
  const hasOAuth = Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim() &&
      process.env.GOOGLE_REFRESH_TOKEN?.trim(),
  );
  if (hasOAuth) return "oauth_user";

  const hasServiceAccount = Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() &&
      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim(),
  );
  if (hasServiceAccount) return "service_account";

  return null;
}

async function resolveAccessToken(explicitToken?: string): Promise<string> {
  if (explicitToken) return explicitToken;

  const preferredSource = configuredAuthSource();
  if (
    cachedToken &&
    cachedToken.source === preferredSource &&
    cachedToken.expiresAt > Date.now() + 60_000
  ) {
    return cachedToken.value;
  }

  let result: TokenResponse | null = null;
  let source: AuthSource | null = null;

  // OAuth user credentials are intentionally preferred over Service Account.
  // A real OAuth user can own/copy files in My Drive, while a Service Account
  // has no personal Drive storage quota and may fail with storageQuotaExceeded.
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  if (clientId && clientSecret && refreshToken) {
    source = "oauth_user";
    result = await exchangeRefreshToken(clientId, clientSecret, refreshToken);
  } else {
    const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
    const servicePrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
    if (serviceEmail && servicePrivateKey) {
      source = "service_account";
      result = await exchangeServiceAccountToken(
        serviceEmail,
        servicePrivateKey,
        process.env.GOOGLE_IMPERSONATE_USER_EMAIL?.trim() || undefined,
      );
    }
  }

  if (!result?.access_token || !source) {
    const detail = result?.error_description || result?.error || "missing Google OAuth credentials";
    throw new Error(
      `Document Merge chưa kết nối Google Docs/Drive (${detail}). Ưu tiên cấu hình GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN; Service Account chỉ là fallback.`,
    );
  }

  cachedToken = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(300, result.expires_in ?? 3600) * 1000,
    source,
  };
  return cachedToken.value;
}

function rememberTemplateSnapshot(docId: string, content: string): void {
  const now = Date.now();
  for (const [key, snapshot] of templateSnapshots) {
    if (now - snapshot.capturedAt > SNAPSHOT_TTL_MS) templateSnapshots.delete(key);
  }
  if (templateSnapshots.size >= MAX_TEMPLATE_SNAPSHOTS) {
    const oldest = [...templateSnapshots.entries()].sort((a, b) => a[1].capturedAt - b[1].capturedAt)[0];
    if (oldest) templateSnapshots.delete(oldest[0]);
  }
  templateSnapshots.set(docId, { docId, content, capturedAt: now });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferReplacements(templateContent: string, renderedContent: string): PlaceholderReplacement[] | null {
  const matcher = /<<\s*([^<>]+?)\s*>>/g;
  const placeholders: string[] = [];
  const literalParts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(templateContent)) !== null) {
    literalParts.push(templateContent.slice(cursor, match.index));
    placeholders.push(match[1].trim());
    cursor = match.index + match[0].length;
  }
  literalParts.push(templateContent.slice(cursor));

  if (placeholders.length === 0) return templateContent === renderedContent ? [] : null;

  let pattern = "^";
  for (let index = 0; index < placeholders.length; index++) {
    pattern += escapeRegex(literalParts[index]);
    pattern += "([\\s\\S]*?)";
  }
  pattern += escapeRegex(literalParts[literalParts.length - 1]);
  pattern += "$";

  const result = new RegExp(pattern).exec(renderedContent);
  if (!result) return null;

  const values = new Map<string, string>();
  for (let index = 0; index < placeholders.length; index++) {
    const placeholder = placeholders[index];
    const value = result[index + 1] ?? "";
    const previous = values.get(placeholder);
    if (previous !== undefined && previous !== value) return null;
    values.set(placeholder, value);
  }

  return [...values.entries()].map(([placeholder, value]) => ({ placeholder, value }));
}

function findSourceTemplate(renderedContent: string): { snapshot: TemplateSnapshot; replacements: PlaceholderReplacement[] } | null {
  const now = Date.now();
  const candidates = [...templateSnapshots.values()]
    .filter((snapshot) => now - snapshot.capturedAt <= SNAPSHOT_TTL_MS)
    .sort((a, b) => b.capturedAt - a.capturedAt);

  for (const snapshot of candidates) {
    const replacements = inferReplacements(snapshot.content, renderedContent);
    if (replacements) return { snapshot, replacements };
  }
  return null;
}

function explainWrite403(detail: string): string {
  const lower = detail.toLowerCase();
  if (lower.includes("storage quota") || lower.includes("service account")) {
    return (
      "Google Drive từ chối tạo bản sao. Nếu đã cấu hình OAuth user, kiểm tra GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN và redeploy. " +
      "Nếu backend đang fallback sang Service Account thì My Drive có thể trả storageQuotaExceeded; hãy dùng OAuth user, Shared Drive hoặc Domain-Wide Delegation."
    );
  }
  return (
    "Google Drive từ chối thao tác ghi. Kiểm tra quyền Editor của template/output folder và tài khoản OAuth đang dùng. " +
    "Nếu backend đang dùng Service Account với My Drive, hãy chuyển sang OAuth user, Shared Drive hoặc Domain-Wide Delegation."
  );
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
      if (response.status === 403) {
        throw new Error(`Google API 403: ${explainWrite403(detail)} Chi tiết: ${detail.slice(0, 500)}`);
      }
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
    const url = `${this.driveUrl}/files/${encodeURIComponent(docId)}/export?mimeType=${encodeURIComponent("text/plain")}&supportsAllDrives=true`;
    const response = await fetch(url, { headers: await this.authHeader() });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Không đọc được Google Docs (${response.status}): ${detail.slice(0, 500)}`);
    }
    const content = await response.text();
    rememberTemplateSnapshot(docId, content);
    return content;
  }

  async copyDocument(docId: string, folderId?: string, title?: string): Promise<string> {
    const body: Record<string, unknown> = { name: title || `Merge_${Date.now()}` };
    if (folderId) body.parents = [folderId];
    const result = await this.requestJson<{ id: string }>(
      `${this.driveUrl}/files/${encodeURIComponent(docId)}/copy?fields=id&supportsAllDrives=true`,
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
    // The current merge route calls updateDocumentContent immediately after
    // createDocument. When createDocument already copied the real template and
    // replaced placeholders, rewriting the body would destroy formatting.
    // Treat that follow-up call as an intentional no-op.
    if (FORMAT_PRESERVED_OUTPUTS.has(docId)) {
      FORMAT_PRESERVED_OUTPUTS.delete(docId);
      return;
    }

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
    // Never silently flatten a multi-record batch into plain text. That would
    // destroy tables, fonts, images, headers/footers and page formatting.
    if (content.includes(PAGE_BREAK_TEXT)) {
      throw new Error(
        "FORMAT_PRESERVING_BATCH_REQUIRED: Merge nhiều hồ sơ vào 1 Google Doc đang bị chặn để tránh làm mất format template. " +
          "Hệ thống phải dùng bộ ghép cấu trúc tài liệu thay vì export/import plain text.",
      );
    }

    const source = findSourceTemplate(content);
    if (!source) {
      throw new Error(
        "FORMAT_SOURCE_NOT_FOUND: Không xác định được Google Docs template nguồn của nội dung merge; hệ thống từ chối tạo file plain-text để bảo toàn format.",
      );
    }

    const docId = await this.copyDocument(source.snapshot.docId, folderId, title);
    await this.replacePlaceholders(docId, source.replacements);
    FORMAT_PRESERVED_OUTPUTS.add(docId);
    return docId;
  }

  async documentExists(docId: string): Promise<boolean> {
    try {
      await this.requestJson(`${this.driveUrl}/files/${encodeURIComponent(docId)}?fields=id,trashed&supportsAllDrives=true`);
      return true;
    } catch {
      return false;
    }
  }

  async getDocumentPermissions(docId: string): Promise<string[]> {
    const result = await this.requestJson<{ permissions?: Array<{ type: string }> }>(
      `${this.driveUrl}/files/${encodeURIComponent(docId)}/permissions?fields=permissions(type)&supportsAllDrives=true`,
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
