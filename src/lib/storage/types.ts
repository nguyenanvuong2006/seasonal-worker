/**
 * StorageProvider — abstraction cho object storage.
 *
 * Business logic KHÔNG hardcode storage implementation. Provider được chọn qua
 * STORAGE_PROVIDER env (xem src/lib/storage/index.ts):
 *   - "local" (default) → LocalFilesystemProvider (dev/test/CI).
 *   - "gcs" / "s3" / "vercel-blob" → các provider production (Phase 5).
 *
 * Neon chỉ lưu metadata/job/progress/storage_key + URL — KHÔNG lưu binary.
 */

export interface StoredObject {
  /** Đường dẫn/khóa định danh object trong storage (vd document-merge/{jobId}/individual/001.pdf). */
  key: string;
  /** URL tải về (signed hoặc public, tuỳ provider). */
  url: string;
  size?: number;
  contentType?: string;
}

export interface StorageProvider {
  readonly name: string;

  /** Ghi object lên storage. `body` có thể là Buffer/Uint8Array/ReadableStream. */
  put(key: string, body: Uint8Array | Buffer, contentType?: string): Promise<StoredObject>;

  /** Đọc toàn bộ object về Buffer (chỉ dùng cho object nhỏ / merge chunk). */
  get(key: string): Promise<Buffer>;

  delete(key: string): Promise<void>;

  exists(key: string): Promise<boolean>;

  /** Signed URL (có hạn) hoặc public URL tuỳ provider. */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}
