/**
 * Document Merge — safe, non-secret database identity fingerprint.
 *
 * Dùng để chứng minh (không đoán) Vercel (Next.js) và Cloud Run worker có
 * đang trỏ vào CÙNG MỘT database/branch Neon hay không — trước khi nghi ngờ
 * claimItems() có bug. Nếu 2 phía trỏ vào 2 database khác nhau, seed item ở
 * Vercel sẽ KHÔNG BAO GIỜ được worker claim, dù claimItems() hoàn toàn đúng.
 *
 * AN TOÀN: KHÔNG BAO GIỜ trả về DATABASE_URL đầy đủ, user, password, port,
 * hay query string — chỉ hostname (không phải secret, đã hiển thị công khai
 * trên Neon dashboard) + metadata không nhạy cảm đọc được từ chính DB.
 *
 * Module này KHÔNG import server-only / auth (Cloud Run worker là Node
 * thuần, import relative — xem queue.ts).
 */

import { sql, type SQLWrapper } from "drizzle-orm";

export interface DbIdentity {
  /** Chỉ hostname parse từ DATABASE_URL — KHÔNG có user/password/port/dbname/query. */
  hostFromConnectionString: string | null;
  currentDatabase: string | null;
  currentSchema: string | null;
  /** pg_control_system().system_identifier — best-effort, null nếu role không có quyền đọc. */
  systemIdentifier: string | null;
  systemIdentifierError: string | null;
}

/** Parse CHỈ hostname từ connection string — không bao giờ trả phần còn lại. */
export function getConnectionHostname(rawUrl: string = process.env.DATABASE_URL ?? ""): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname || null;
  } catch {
    return null;
  }
}

export interface ExecutableDb {
  execute: (query: string | SQLWrapper) => Promise<{ rows: unknown[] }>;
}

export async function getDbIdentity(database: ExecutableDb): Promise<DbIdentity> {
  const hostFromConnectionString = getConnectionHostname();

  let currentDatabase: string | null = null;
  let currentSchema: string | null = null;
  try {
    const result = await database.execute(sql`SELECT current_database() AS db, current_schema() AS schema`);
    const row = result.rows?.[0] as { db?: string; schema?: string } | undefined;
    currentDatabase = row?.db ?? null;
    currentSchema = row?.schema ?? null;
  } catch {
    // Không throw — identity check là diagnostic, không được làm hỏng route gọi nó.
  }

  let systemIdentifier: string | null = null;
  let systemIdentifierError: string | null = null;
  try {
    const result = await database.execute(sql`SELECT system_identifier::text AS sid FROM pg_control_system()`);
    systemIdentifier = (result.rows?.[0] as { sid?: string } | undefined)?.sid ?? null;
  } catch (error) {
    // pg_control_system() thường yêu cầu quyền superuser/pg_read_all_stats —
    // role app trên Neon nhiều khả năng KHÔNG có quyền này. Đây là kết quả
    // hợp lệ (không phải lỗi chẩn đoán) — ghi lại lý do, không giả vờ null.
    systemIdentifierError = error instanceof Error ? error.message.slice(0, 200) : String(error);
  }

  return { hostFromConnectionString, currentDatabase, currentSchema, systemIdentifier, systemIdentifierError };
}
