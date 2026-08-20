/**
 * Storage factory — chọn provider theo STORAGE_PROVIDER env.
 *
 * - "local" (default): LocalFilesystemStorageProvider (dev/test).
 * - "gcs" / "s3" / "vercel-blob": production providers (Phase 5) — hiện chưa cài
 *   dependency, factory sẽ ném lỗi rõ ràng nếu chọn mà chưa triển khai.
 *
 * Tránh import server-only vào worker (Cloud Run) — module này thuần, không I/O
 * lúc import.
 */

import { LocalFilesystemStorageProvider } from "./local.ts";
import { GoogleDriveStorageProvider } from "./google-drive.ts";
import type { StorageProvider } from "./types.ts";

export type StorageProviderKind = "local" | "google_drive" | "gcs" | "s3" | "vercel-blob";

export function resolveStorageProviderKind(): StorageProviderKind {
  const raw = (process.env.STORAGE_PROVIDER ?? "local").trim().toLowerCase();
  switch (raw) {
    case "google_drive":
    case "gcs":
    case "s3":
    case "vercel-blob":
    case "local":
      return raw;
    default:
      return "local";
  }
}

let cached: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (cached) return cached;

  const kind = resolveStorageProviderKind();
  switch (kind) {
    case "local":
      cached = new LocalFilesystemStorageProvider();
      return cached;
    case "google_drive":
      cached = new GoogleDriveStorageProvider();
      return cached;
    case "gcs":
    case "s3":
    case "vercel-blob":
    default:
      throw new Error(
        `Storage provider "${kind}" chưa được triển khai. Dùng STORAGE_PROVIDER=local cho dev/test hoặc google_drive cho production.`,
      );
  }
}

export type { StorageProvider, StoredObject } from "./types.ts";
