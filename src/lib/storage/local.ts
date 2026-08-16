/**
 * LocalFilesystemStorageProvider — dùng cho local dev / CI / tests.
 * Không dùng cho production (filesystem Cloud Run là ephemeral, không chia sẻ
 * giữa các instance). Production dùng GCS/S3 provider (Phase 5).
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StorageProvider, StoredObject } from "./types.ts";

const DEFAULT_ROOT = process.env.STORAGE_LOCAL_ROOT || path.join(process.cwd(), ".storage");

export class LocalFilesystemStorageProvider implements StorageProvider {
  readonly name = "local";
  private readonly root: string;

  constructor(root: string = DEFAULT_ROOT) {
    this.root = root;
  }

  private resolve(key: string): string {
    const normalized = key.replace(/^\/+/, "").replace(/\.\./g, "");
    return path.join(this.root, normalized);
  }

  async put(key: string, body: Uint8Array | Buffer, contentType?: string): Promise<StoredObject> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    const statResult = await stat(target);
    return {
      key,
      url: `/api/document-merge/files?key=${encodeURIComponent(key)}`,
      size: statResult.size,
      contentType,
    };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async getSignedUrl(key: string, _expiresInSeconds?: number): Promise<string> {
    // Local provider: URL tương đối (được dev server phục vụ). Production dùng signed URL thật.
    return `/api/document-merge/files?key=${encodeURIComponent(key)}`;
  }
}
