/**
 * GoogleDriveStorageProvider — production storage cho PDF (Phase 8).
 *
 * - OAuth user (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN)
 *   được ưu tiên để làm OWNER file trong My Drive (PR #53 + spec N).
 *   Service Account chỉ là fallback (không làm owner trong My Drive).
 * - Folder structure (tạo idempotent, cache id trong process):
 *     Seasonal Worker Documents/
 *       Candidate Documents/YYYY/MM/DD/
 *       Batch Outputs/YYYY/MM/<jobId>/
 * - storage_key = đường dẫn tương đối (vd Candidate Documents/2026/08/17/....pdf)
 *   → Neon giữ key, không hardcode URL.
 * - Không expose secret: token chỉ ở server/worker.
 */

import type { StorageProvider, StoredObject } from "./types.ts";

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SCOPE = "https://www.googleapis.com/auth/drive";

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

async function exchangeRefreshToken(): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN?.trim() ?? "",
      grant_type: "refresh_token",
    }),
  });
  return res.json() as Promise<TokenResponse>;
}

async function exchangeServiceAccountToken(): Promise<TokenResponse> {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !key) throw new Error("GOOGLE_DRIVE_AUTH_MISSING: chưa cấu hình OAuth hoặc Service Account.");

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: email,
      scope: SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      ...(process.env.GOOGLE_IMPERSONATE_USER_EMAIL?.trim()
        ? { sub: process.env.GOOGLE_IMPERSONATE_USER_EMAIL.trim() }
        : {}),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const { createSign } = await import("node:crypto");
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key.replace(/\\n/g, "\n")).toString("base64url");
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  return res.json() as Promise<TokenResponse>;
}

async function resolveAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const hasOAuth = Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim() &&
      process.env.GOOGLE_REFRESH_TOKEN?.trim(),
  );
  const result = hasOAuth ? await exchangeRefreshToken() : await exchangeServiceAccountToken();

  if (!result.access_token) {
    throw new Error(
      `GOOGLE_DRIVE_AUTH_FAILED: ${result?.error_description || result?.error || "missing credentials"}`,
    );
  }
  cachedToken = { value: result.access_token, expiresAt: Date.now() + Math.max(300, result.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await resolveAccessToken();
  return fetch(url, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

export class GoogleDriveStorageProvider implements StorageProvider {
  readonly name = "google_drive";
  private readonly rootFolderId: string | null;
  private folderCache = new Map<string, string>(); // path → folder id

  constructor() {
    this.rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() || null;
  }

  // ---------------------------------------------------------------
  // Folder helpers
  // ---------------------------------------------------------------
  private async findFolderByName(name: string, parentId: string | null): Promise<string | null> {
    const q = `mimeType='${FOLDER_MIME}' and name='${name.replace(/'/g, "\\'")}' and trashed=false${
      parentId ? ` and '${parentId}' in parents` : ""
    }`;
    const res = await driveFetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=5`);
    if (!res.ok) return null;
    const data = (await res.json()) as { files?: { id: string }[] };
    return data.files?.[0]?.id ?? null;
  }

  private async createFolder(name: string, parentId: string | null): Promise<string> {
    const res = await driveFetch(`${DRIVE_API}/files?fields=id`, {
      method: "POST",
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`GOOGLE_DRIVE_FOLDER_CREATE_${res.status}: ${detail.slice(0, 500)}`);
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  /** Đảm bảo chuỗi folder theo storage_key; trả folder id của thư mục chứa file. */
  private async ensureFolderPath(pathParts: string[]): Promise<string> {
    let parentId: string | null = this.rootFolderId;
    let acc = "";
    for (const part of pathParts) {
      acc = acc ? `${acc}/${part}` : part;
      const cached = this.folderCache.get(acc);
      if (cached) {
        parentId = cached;
        continue;
      }
      let id = parentId ? await this.findFolderByName(part, parentId) : null;
      if (!id) {
        if (parentId === null && acc === pathParts[0]) {
          // Root 'Seasonal Worker Documents' — tìm hoặc tạo dưới My Drive.
          id = (await this.findFolderByName(part, null)) ?? (await this.createFolder(part, null));
        } else {
          id = await this.createFolder(part, parentId);
        }
      }
      this.folderCache.set(acc, id);
      parentId = id;
    }
    if (!parentId) throw new Error("GOOGLE_DRIVE_ROOT_MISSING");
    return parentId;
  }

  private splitKey(key: string): { dirParts: string[]; filename: string } {
    const parts = key.replace(/^\/+/, "").split("/").filter(Boolean);
    const filename = parts.pop() ?? "";
    return { dirParts: parts, filename };
  }

  // ---------------------------------------------------------------
  // StorageProvider
  // ---------------------------------------------------------------
  async put(key: string, body: Uint8Array | Buffer, contentType = "application/octet-stream"): Promise<StoredObject> {
    const { dirParts, filename } = this.splitKey(key);
    const folderId = await this.ensureFolderPath(dirParts);

    const boundary = `seasonal_worker_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({
        name: filename,
        mimeType: contentType,
        parents: [folderId],
      })}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const payload = Buffer.concat([head, Buffer.from(body), tail]);

    const res = await driveFetch(
      `${UPLOAD_API}/files?uploadType=multipart&fields=id,webViewLink,webContentLink,size&supportsAllDrives=true`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": String(payload.length) },
        body: payload,
      },
    );
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`GOOGLE_DRIVE_UPLOAD_${res.status}: ${detail.slice(0, 800)}`);
    }
    const data = (await res.json()) as {
      id: string;
      webViewLink?: string;
      webContentLink?: string;
      size?: string;
    };
    return {
      key,
      url: data.webViewLink ?? data.webContentLink ?? "",
      size: Number(data.size ?? body.byteLength),
      contentType,
    };
  }

  /** Tìm file theo key (folder path + name). */
  private async findFileId(key: string): Promise<{ id: string; size?: number; sha256?: string } | null> {
    const { dirParts, filename } = this.splitKey(key);
    try {
      const folderId = await this.ensureFolderPath(dirParts);
      const q = `name='${filename.replace(/'/g, "\\'")}' and trashed=false and '${folderId}' in parents`;
      const res = await driveFetch(
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,size,sha256Checksum)&pageSize=10&supportsAllDrives=true`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { files?: { id: string; size?: string; sha256Checksum?: string }[] };
      const file = data.files?.[0];
      return file ? { id: file.id, size: Number(file.size ?? 0), sha256: file.sha256Checksum ?? undefined } : null;
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<Buffer> {
    const found = await this.findFileId(key);
    if (!found) throw new Error(`GOOGLE_DRIVE_FILE_NOT_FOUND: ${key}`);
    const res = await driveFetch(`${DRIVE_API}/files/${found.id}?alt=media&supportsAllDrives=true`);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`GOOGLE_DRIVE_DOWNLOAD_${res.status}: ${detail.slice(0, 500)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const found = await this.findFileId(key);
    if (!found) return;
    const res = await driveFetch(`${DRIVE_API}/files/${found.id}?supportsAllDrives=true`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      const detail = await res.text();
      throw new Error(`GOOGLE_DRIVE_DELETE_${res.status}: ${detail.slice(0, 500)}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.findFileId(key)) !== null;
  }

  async getSignedUrl(key: string, _expiresInSeconds = 3600): Promise<string> {
    const found = await this.findFileId(key);
    if (!found) throw new Error(`GOOGLE_DRIVE_FILE_NOT_FOUND: ${key}`);
    const res = await driveFetch(
      `${DRIVE_API}/files/${found.id}?fields=webViewLink,webContentLink&supportsAllDrives=true`,
    );
    if (!res.ok) throw new Error(`GOOGLE_DRIVE_URL_${res.status}`);
    const data = (await res.json()) as { webViewLink?: string; webContentLink?: string };
    return data.webViewLink ?? data.webContentLink ?? "";
  }

  async getMetadata(key: string): Promise<{ size: number; sha256?: string } | null> {
    const found = await this.findFileId(key);
    if (!found) return null;
    return { size: found.size ?? 0, sha256: found.sha256 };
  }

  /**
   * Đọc metadata CHÍNH thư mục root (GOOGLE_DRIVE_ROOT_FOLDER_ID) — THUẦN
   * ĐỌC, không tạo/sửa/xoá bất kỳ gì. Dùng cho production readiness check
   * (KHÔNG được phép ghi file probe vào Drive production — xem
   * production-readiness.ts) để xác nhận root folder ID cấu hình đúng và
   * account có quyền đọc nó, mà không cần bất kỳ thao tác ghi nào.
   */
  async getRootFolderMetadata(): Promise<{ id: string; name: string; trashed: boolean } | null> {
    if (!this.rootFolderId) return null;
    const res = await driveFetch(
      `${DRIVE_API}/files/${this.rootFolderId}?fields=id,name,trashed&supportsAllDrives=true`,
    );
    if (!res.ok) {
      if (res.status === 404) return null;
      const detail = await res.text();
      throw new Error(`GOOGLE_DRIVE_ROOT_METADATA_${res.status}: ${detail.slice(0, 500)}`);
    }
    const data = (await res.json()) as { id: string; name: string; trashed?: boolean };
    return { id: data.id, name: data.name, trashed: Boolean(data.trashed) };
  }
}
