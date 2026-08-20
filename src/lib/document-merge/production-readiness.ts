/**
 * Document Merge — production readiness (READ-ONLY, an toàn để chạy trên
 * PRODUCTION thật, khác hẳn `src/lib/verification/*` vốn CHỈ chạy ở
 * non-production và được phép ghi/xoá dữ liệu thử).
 *
 * NGHIÊM CẤM trong module này (đúng yêu cầu "production verification gate"):
 *   - tạo candidate/job/item giả
 *   - ghi merge job
 *   - claim probe / queue mutation bất kỳ
 *   - upload file thử lên Drive
 *   - benchmark render / visual test render
 *   - archive cleanup / retention deletion
 *
 * Mọi check ở đây CHỈ đọc: SELECT count(*), gọi GET /health, đọc metadata
 * (không ghi) 1 folder Drive đã tồn tại (root folder), đọc presence (không
 * phải giá trị) của biến môi trường.
 *
 * QUAN TRỌNG: overall PASS chỉ được phép khi DOCUMENT_MERGE_ENGINE vẫn là
 * GOOGLE_DOCS — route này đo "hạ tầng đã sẵn sàng chưa", KHÔNG BAO GIỜ được
 * hiểu là "HTML_PDF đã được kích hoạt". Nếu engine đã là HTML_PDF, báo
 * BLOCKED ngay — không đánh giá tiếp phần còn lại như thể mọi thứ bình
 * thường (đây là rào chắn, không phải happy-path).
 */

import { sql, type SQLWrapper } from "drizzle-orm";
import { parseDocumentMergeEngine } from "./engine-config.ts";
import { resolveStorageProviderKind, getStorageProvider } from "../storage/index.ts";
import type { GoogleDriveStorageProvider } from "../storage/google-drive.ts";
import { callWorker, type CallWorkerOptions } from "../verification/helpers.ts";

interface ReadOnlyDb {
  execute: (query: string | SQLWrapper) => Promise<{ rows: unknown[] }>;
}

export interface CheckResult {
  pass: boolean;
  detail?: string;
}

export interface EnvPresenceResult extends CheckResult {
  missing: string[];
}

// ---------------------------------------------------------------
// ENGINE_DEFAULT — đánh giá TRƯỚC TIÊN, quyết định có tiếp tục hay BLOCKED ngay.
// ---------------------------------------------------------------
export function checkEngineDefault(env: Record<string, string | undefined> = process.env): {
  value: string;
  isGoogleDocs: boolean;
} {
  const normalized = parseDocumentMergeEngine(env.DOCUMENT_MERGE_ENGINE);
  return { value: normalized, isGoogleDocs: normalized === "GOOGLE_DOCS" };
}

// ---------------------------------------------------------------
// AUTH — chỉ presence, KHÔNG BAO GIỜ trả giá trị.
// ---------------------------------------------------------------
const AUTH_REQUIRED_KEYS = [
  "PDF_MERGE_WORKER_URL",
  "MERGE_WORKER_SECRET",
  "GOOGLE_WIF_PROJECT_NUMBER",
  "GOOGLE_WIF_POOL_ID",
  "GOOGLE_WIF_PROVIDER_ID",
  "GOOGLE_WIF_SERVICE_ACCOUNT",
] as const;

export function checkAuthEnv(env: Record<string, string | undefined> = process.env): EnvPresenceResult {
  const missing = AUTH_REQUIRED_KEYS.filter((k) => !env[k]?.trim());
  return { pass: missing.length === 0, missing };
}

// ---------------------------------------------------------------
// STORAGE — presence + đúng 1 bộ auth Drive (OAuth HOẶC service-account).
// ---------------------------------------------------------------
export function checkStorageEnv(env: Record<string, string | undefined> = process.env): EnvPresenceResult & { provider: string } {
  const provider = (env.STORAGE_PROVIDER ?? "local").trim().toLowerCase() || "local";
  const missing: string[] = [];
  if (provider !== "google_drive") {
    missing.push("STORAGE_PROVIDER=google_drive");
    return { pass: false, missing, provider };
  }
  if (!env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim()) missing.push("GOOGLE_DRIVE_ROOT_FOLDER_ID");

  const hasOAuth = Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim() && env.GOOGLE_REFRESH_TOKEN?.trim());
  const hasServiceAccount = Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim());
  if (!hasOAuth && !hasServiceAccount) {
    missing.push("GOOGLE_CLIENT_ID+GOOGLE_CLIENT_SECRET+GOOGLE_REFRESH_TOKEN (hoặc GOOGLE_SERVICE_ACCOUNT_EMAIL+GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)");
  }
  return { pass: missing.length === 0, missing, provider };
}

/** Đọc metadata root folder Drive (THUẦN ĐỌC — không ghi/xoá gì). */
export async function checkStorageDriveReachable(): Promise<CheckResult> {
  if (resolveStorageProviderKind() !== "google_drive") {
    return { pass: false, detail: "STORAGE_PROVIDER không phải google_drive — bỏ qua đọc root folder." };
  }
  try {
    const storage = getStorageProvider() as GoogleDriveStorageProvider;
    if (typeof storage.getRootFolderMetadata !== "function") {
      return { pass: false, detail: "Storage provider không hỗ trợ đọc root folder metadata." };
    }
    const meta = await storage.getRootFolderMetadata();
    if (!meta) return { pass: false, detail: "Không đọc được root folder (GOOGLE_DRIVE_ROOT_FOLDER_ID sai hoặc không có quyền truy cập)." };
    if (meta.trashed) return { pass: false, detail: `Root folder "${meta.name}" đang ở Thùng rác Drive.` };
    return { pass: true, detail: `Root folder: "${meta.name}"` };
  } catch (error) {
    return { pass: false, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

// ---------------------------------------------------------------
// DATABASE + MIGRATIONS — chỉ SELECT, không ghi.
// ---------------------------------------------------------------
const EXPECTED_TABLES = [
  "merge_templates",
  "merge_template_fields",
  "merge_template_versions",
  "merge_jobs",
  "merge_job_records",
  "document_history",
  "archive_runs",
] as const;

export interface MigrationsCheckResult {
  pass: boolean;
  tables: Record<(typeof EXPECTED_TABLES)[number], boolean>;
}

export async function checkDatabase(db: ReadOnlyDb): Promise<CheckResult> {
  try {
    const result = await db.execute(sql`SELECT 1 AS ok`);
    const ok = Boolean((result.rows?.[0] as { ok?: number } | undefined)?.ok);
    return { pass: ok };
  } catch (error) {
    return { pass: false, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

export async function checkMigrations(db: ReadOnlyDb): Promise<MigrationsCheckResult> {
  const result = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${[...EXPECTED_TABLES]})
  `);
  const present = new Set((result.rows as { table_name: string }[]).map((r) => r.table_name));
  const tables = Object.fromEntries(EXPECTED_TABLES.map((t) => [t, present.has(t)])) as MigrationsCheckResult["tables"];
  return { pass: EXPECTED_TABLES.every((t) => tables[t]), tables };
}

// ---------------------------------------------------------------
// TEMPLATE — chỉ đếm, không publish/sửa gì.
// ---------------------------------------------------------------
export interface TemplateStateResult {
  templateCount: number;
  fieldCount: number;
  publishedVersionCount: number;
  dangKyTapNghe: { found: boolean; hasPublishedVersion: boolean; draftVersionCount: number } | null;
}

const DANG_KY_TAP_NGHE_GOOGLE_DOC_ID = "10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE";

export async function checkTemplateState(db: ReadOnlyDb): Promise<TemplateStateResult> {
  const counts = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM merge_templates) AS templates,
      (SELECT count(*) FROM merge_template_fields WHERE is_orphaned = false) AS fields,
      (SELECT count(*) FROM merge_template_versions WHERE status = 'PUBLISHED') AS published_versions
  `);
  const row = counts.rows?.[0] as { templates?: number; fields?: number; published_versions?: number } | undefined;

  const dangKy = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE v.status = 'PUBLISHED') AS published_count,
      count(*) FILTER (WHERE v.status = 'DRAFT') AS draft_count
    FROM merge_templates t
    LEFT JOIN merge_template_versions v ON v.template_id = t.id
    WHERE t.google_doc_id = ${DANG_KY_TAP_NGHE_GOOGLE_DOC_ID}
  `);
  const dangKyRow = dangKy.rows?.[0] as { published_count?: number; draft_count?: number } | undefined;
  const dangKyExists = await db.execute(sql`SELECT 1 FROM merge_templates WHERE google_doc_id = ${DANG_KY_TAP_NGHE_GOOGLE_DOC_ID}`);

  return {
    templateCount: Number(row?.templates ?? 0),
    fieldCount: Number(row?.fields ?? 0),
    publishedVersionCount: Number(row?.published_versions ?? 0),
    dangKyTapNghe: (dangKyExists.rows?.length ?? 0) > 0
      ? {
          found: true,
          hasPublishedVersion: Number(dangKyRow?.published_count ?? 0) > 0,
          draftVersionCount: Number(dangKyRow?.draft_count ?? 0),
        }
      : { found: false, hasPublishedVersion: false, draftVersionCount: 0 },
  };
}

// ---------------------------------------------------------------
// CLOUD_RUN — GET /health thật qua callWorker (không /run, không tạo job).
// ---------------------------------------------------------------
export interface CloudRunCheckResult extends CheckResult {
  revision: string | null;
  httpStatus: number | null;
}

export async function checkCloudRun(options: CallWorkerOptions = {}): Promise<CloudRunCheckResult> {
  const result = await callWorker<{ ok?: boolean; revision?: string | null }>("/health", undefined, 15_000, options);
  return {
    pass: result.ok,
    detail: result.ok ? undefined : ((result.data as { error?: string }).error ?? `HTTP ${result.status}`),
    revision: result.ok ? ((result.data as { revision?: string | null }).revision ?? null) : null,
    httpStatus: result.status || null,
  };
}
