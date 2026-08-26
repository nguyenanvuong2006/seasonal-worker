/**
 * PDF Overlay — REQUIRED SCHEMA CONTRACT (PR5 root-cause hardening).
 *
 * Nguồn sự thật DUY NHẤT cho "schema nào /run-overlay cần để chạy được". Cả
 * worker (`worker-overlay-e2e.ts`) VÀ standalone verifier (`scripts/verify-
 * required-schema.mjs`) + staging E2E (`scripts/staging-e2e-overlay.mjs`) đều
 * đọc contract này — không có 2 danh sách hardcode riêng dễ lệch nhau (drift).
 *
 * Mục tiêu root-cause: /run-overlay PHẢI phát hiện deterministic thiếu/không
 * tương thích schema (bảng/cột) TRƯỚC khi thực hiện overlay query bình thường
 * — thay vì để query thật nổ lỗi mờ ở giữa vòng claim/render. Khi schema chưa
 * sẵn sàng, worker throw OverlaySchemaError (code SCHEMA_MISMATCH) mang đủ thông
 * tin để operator biết chính xác migration nào đang thiếu.
 *
 * Module THUẦN (KHÔNG import drizzle/pg/server-only/DB) để:
 *   - worker-overlay-e2e.ts import trực tiếp (Cloud Run worker, tsx),
 *   - scripts/verify-required-schema.mjs import qua `node --import tsx`,
 *   - bộ test `node --test` nạp trực tiếp,
 *   không có side-effect/kết nối DB lúc import.
 */

/** 1 bảng bắt buộc + lý do (operator-facing) + các cột bắt buộc (tên vật lý). */
export interface RequiredTableSchema {
  /** Tên bảng vật lý trong Postgres (vd: "merge_jobs"). */
  readonly table: string;
  /** Lý do bảng này cần cho /run-overlay — xuất hiện trong chẩn đoán SCHEMA_MISMATCH. */
  readonly reason: string;
  /** Cột bắt buộc (tên vật lý) — path overlay E2E đọc/ghi transitively. */
  readonly columns: readonly string[];
}

/**
 * Contract canonical — deterministic preflight cho /run-overlay.
 *
 * Mỗi bảng/cột đều là thứ path overlay E2E (worker-overlay-e2e.ts → queue.ts
 * → document-history.ts → batch-finalize.ts) thực sự đọc/ghi. Thiếu bất kỳ cái
 * nào → /run-overlay không thể hoàn thành → phải chặn ngay từ preflight.
 *
 * CHỈ BẢO ĐẢM: đây là tập con tối thiểu; thêm migration mới mở rộng path overlay
 * thì cập nhật contract này + test (single source of truth, không drift).
 */
export const REQUIRED_OVERLAY_SCHEMA: readonly RequiredTableSchema[] = [
  {
    table: "merge_jobs",
    reason: "queue job — /run-overlay chọn job theo id/engine/metadata, ghi progress + finalize.",
    columns: [
      "id",
      "status",
      "engine",
      "metadata",
      "created_by",
      "started_at",
      "completed_at",
      // Async PDF engine (migration 2026-08-20) — progress recompute.
      "queued_count",
      "processing_count",
      "completed_count",
      "failed_count",
      "progress_percent",
      // Batch finalize outputs.
      "output_pdf_url",
      "output_zip_url",
      "output_pdf_file_id",
      "output_zip_file_id",
      "batch_expires_at",
      "error_summary",
    ],
  },
  {
    table: "merge_job_records",
    reason: "queue item — claim/complete/fail/retry từng record overlay.",
    columns: [
      "id",
      "merge_job_id",
      "source_record_id",
      "sort_order",
      "status",
      "attempt_count",
      "leased_until",
      "retry_at",
      "pdf_url",
      "storage_key",
      "filename",
      "file_size",
      "sha256",
      "document_history_id",
      "error_code",
      "error_message",
      "started_at",
      "completed_at",
    ],
  },
  {
    table: "document_history",
    reason: "mỗi PDF overlay = 1 record history (retention snapshot, NON-PRODUCTION).",
    columns: [
      "id",
      "candidate_id",
      "application_id",
      "merge_job_id",
      "merge_job_record_id",
      "template_id",
      "template_version",
      "document_type",
      "generated_at",
      "filename",
      "storage_provider",
      "storage_file_id",
      "file_size",
      "sha256",
      "retention_until",
      "retention_policy_snapshot",
      "archive_status",
      "created_by",
      "created_at",
      "updated_at",
    ],
  },
];

/** Tên bảng bắt buộc (rút từ contract — tiện cho log/chẩn đoán). */
export const REQUIRED_OVERLAY_TABLES: readonly string[] = REQUIRED_OVERLAY_SCHEMA.map((t) => t.table);

/** 1 bảng quan sát được từ information_schema (tên + các cột đang có). */
export interface ObservedTable {
  readonly table: string;
  readonly columns: readonly string[];
}

/** Kết quả probe schema thực tế từ DB. */
export interface ObservedSchema {
  /** current_schema() của connection (để chẩn đoán nếu lệch schema mong đợi). */
  readonly schema: string | null;
  readonly tables: readonly ObservedTable[];
}

/** Kết quả so sánh observed-vs-required. */
export interface SchemaCheckResult {
  /** true nếu ĐỦ bảng + ĐỦ cột (path overlay có thể chạy). */
  readonly ok: boolean;
  readonly requiredTableCount: number;
  readonly observedTableCount: number;
  /** Các bảng bắt buộc KHÔNG tồn tại (toàn bộ bảng thiếu). */
  readonly missingTables: readonly string[];
  /** Các bảng tồn tại nhưng thiếu cột bắt buộc (cột thiếu kèm). */
  readonly missingColumns: readonly { readonly table: string; readonly columns: readonly string[] }[];
}

/**
 * Querier DB-agnostic — nhận 1 câu SQL (không tham số, chỉ chứa identifier từ
 * contract nên an toàn) và trả về mảng row. Cả drizzle (`db.execute`) và pg
 * (`client.query`) đều bọc thành interface này bằng adapter 3 dòng → probe +
 * evaluate + contract chỉ có 1 bản duy nhất.
 */
export type SchemaQuerier = (sqlText: string) => Promise<readonly Record<string, unknown>[]>;

const SAFE_NAME = /^[a-z_][a-z0-9_]*$/;

/** Ép tên thành string literal an toàn cho SQL (chỉ chữ thường/số/gạch dưới). */
function sqlStringLiteral(name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Overlay schema contract chứa tên không hợp lệ: ${JSON.stringify(name)}`);
  }
  return `'${name}'`;
}

/**
 * Câu probe duy nhất — đọc information_schema.columns trong current_schema() cho
 * các bảng bắt buộc. 1 bảng tồn tại ⟺ có ≥1 cột trả về. An toàn: identifier chỉ
 * tới tên từ contract (không phải input người dùng), được SAFE_NAME kiểm soát.
 */
export function buildOverlaySchemaProbeSql(): string {
  const literals = REQUIRED_OVERLAY_SCHEMA.map((t) => sqlStringLiteral(t.table)).join(", ");
  return [
    "SELECT current_schema() AS probe_schema, table_name, column_name",
    "FROM information_schema.columns",
    "WHERE table_schema = current_schema()",
    `  AND table_name IN (${literals})`,
    "ORDER BY table_name, column_name",
  ].join("\n");
}

/** Probe DB thật (qua querier) → ObservedSchema. Không throw khi thiếu — trả observed. */
export async function probeOverlaySchema(querier: SchemaQuerier): Promise<ObservedSchema> {
  const rows = await querier(buildOverlaySchemaProbeSql());
  let schema: string | null = null;
  const byTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const probeSchema = row.probe_schema;
    if (typeof probeSchema === "string" && schema === null) schema = probeSchema;
    const table = String(row.table_name ?? "");
    const column = String(row.column_name ?? "");
    if (!table || !column) continue;
    let set = byTable.get(table);
    if (!set) {
      set = new Set<string>();
      byTable.set(table, set);
    }
    set.add(column);
  }
  const tables: ObservedTable[] = Array.from(byTable.entries())
    .map(([table, cols]) => ({ table, columns: Array.from(cols).sort() }))
    .sort((a, b) => a.table.localeCompare(b.table));
  return { schema, tables };
}

/**
 * So sánh observed-vs-required (PURE — không đụng DB). Trả danh sách thiếu đủ
 * chi tiết để operator biết migration nào cần chạy.
 */
export function evaluateOverlaySchema(observed: ObservedSchema): SchemaCheckResult {
  const presentTables = new Set(observed.tables.map((t) => t.table));
  const columnsByTable = new Map(observed.tables.map((t) => [t.table, new Set(t.columns)]));
  const missingTables: string[] = [];
  const missingColumns: { table: string; columns: string[] }[] = [];
  for (const required of REQUIRED_OVERLAY_SCHEMA) {
    if (!presentTables.has(required.table)) {
      missingTables.push(required.table);
      continue;
    }
    const present = columnsByTable.get(required.table) ?? new Set<string>();
    const missing = required.columns.filter((c) => !present.has(c));
    if (missing.length > 0) missingColumns.push({ table: required.table, columns: missing });
  }
  return {
    ok: missingTables.length === 0 && missingColumns.length === 0,
    requiredTableCount: REQUIRED_OVERLAY_SCHEMA.length,
    observedTableCount: observed.tables.length,
    missingTables,
    missingColumns,
  };
}

/** Probe + evaluate trong 1 bước (worker/verifier dùng chung). */
export async function checkOverlaySchema(querier: SchemaQuerier): Promise<SchemaCheckResult> {
  return evaluateOverlaySchema(await probeOverlaySchema(querier));
}

/** Format chẩn đoán SCHEMA_MISMATCH — operator biết chính xác thiếu gì + phải làm gì. */
export function formatOverlaySchemaMismatch(result: SchemaCheckResult): string {
  const detail: string[] = [];
  for (const table of result.missingTables) detail.push(`thiếu bảng ${table}`);
  for (const mc of result.missingColumns) detail.push(`bảng ${mc.table} thiếu cột [${mc.columns.join(", ")}]`);
  if (detail.length === 0) detail.push("(không phát hiện thiếu hụt — kiểm tra lại logic)");
  return [
    "SCHEMA_MISMATCH: /run-overlay (PDF Overlay E2E) yêu cầu schema chưa sẵn sàng —",
    detail.join("; "),
    "Chạy migration staging (scripts/run-migrations.mjs + migrations/*.sql) rồi xác minh lại bằng scripts/verify-required-schema.mjs.",
  ].join(" ");
}

/**
 * Lỗi schema cho /run-overlay. `.code === "SCHEMA_MISMATCH"` để worker/verifier/
 * test nhận diện deterministic; message tự mang chẩn đoán đầy đủ.
 */
export class OverlaySchemaError extends Error {
  readonly code = "SCHEMA_MISMATCH" as const;
  readonly result: SchemaCheckResult;
  constructor(result: SchemaCheckResult) {
    super(formatOverlaySchemaMismatch(result));
    this.name = "OverlaySchemaError";
    this.result = result;
  }
}

/** Type guard — nhận diện OverlaySchemaError (dùng ở worker HTTP / verifier). */
export function isOverlaySchemaError(error: unknown): error is OverlaySchemaError {
  return error instanceof OverlaySchemaError;
}

/**
 * Probe + evaluate + throw OverlaySchemaError nếu schema KHÔNG đủ. Đây là hàm
 * default mà worker /run-overlay chạy trước overlay query (xem worker-overlay-
 * e2e.ts). Verifier/test có thể gọi checkOverlaySchema trực tiếp khi muốn kết
 * quả thay vì throw.
 */
export async function assertOverlayRequiredSchema(querier: SchemaQuerier): Promise<void> {
  const result = await checkOverlaySchema(querier);
  if (!result.ok) throw new OverlaySchemaError(result);
}
