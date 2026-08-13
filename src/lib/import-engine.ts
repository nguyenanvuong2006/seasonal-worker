import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { formQuestions, importBatches, importStagingRows } from "@/db/schema";
import { buildHeaderIndex, getFieldDefinitions, makeFieldPicker, normalizeHeader, type Group } from "@/lib/metadata";
import { CCCD_ERROR_MESSAGE, isValidCccd } from "@/lib/validators";

/**
 * IMPORT ENGINE v2 — service layer dùng chung cho:
 *   /api/admin/import-data/upload  (nạp file -> staging, bulk)
 *   /api/admin/import-data/merge   (staging -> bảng chính, theo lô, resumable)
 *
 * Toàn bộ logic VALIDATE / MAPPING / DATA QUALITY (Error vs Warning) ở đây được
 * chuyển nguyên vẹn từ route.ts cũ (không đổi hành vi nghiệp vụ) — chỉ đổi NGUỒN
 * dữ liệu đầu vào: trước đọc từ mảng JSON do client gửi, nay đọc từ 1 lô
 * import_staging_rows (đã nạp sẵn từ file qua bulk insert).
 */

export const MERGE_CHUNK_SIZE = 300;
export const STAGE_INSERT_CHUNK = 3000; // số dòng / 1 câu lệnh UNNEST bulk insert

export const clean = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" || s === "0" || s === "#N/A" || s === "-" ? null : s;
};
export const digits = (v: unknown): string | null => {
  const s = String(v ?? "").replace(/\D/g, "");
  return s.length ? s : null;
};
export const toISO = (s: unknown): string | null => {
  const m = String(s ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const iso = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0].slice(0, 10) : null;
};

/** Cột nào trong file KHÔNG khớp bất kỳ field_definitions/form_questions nào (chỉ cảnh báo). */
export function findUnrecognizedColumns(headers: string[], acceptedNormalized: Set<string>): string[] {
  return headers.filter((h) => !acceptedNormalized.has(normalizeHeader(h)));
}

/** Tập hợp tên cột được chấp nhận (importColumnName + alias) cho 1 nhóm — dùng để cảnh báo cột lạ. */
export async function getAcceptedColumnNames(importType: Group): Promise<Set<string>> {
  const defs = await getFieldDefinitions(importType);
  const accepted = new Set<string>();
  for (const d of defs) {
    if (d.importColumnName) accepted.add(normalizeHeader(d.importColumnName));
    (d.aliases ?? []).forEach((a) => accepted.add(normalizeHeader(a)));
  }
  if (importType === "daily_application") {
    const questions = await db.select().from(formQuestions);
    for (const q of questions) {
      accepted.add(normalizeHeader(q.questionText));
      (q.aliases ?? []).forEach((a) => accepted.add(normalizeHeader(a)));
    }
  }
  return accepted;
}

/**
 * BULK LOAD (thay parse-toàn-bộ-thành-JSON-rồi-gửi-nhiều-lô-nhỏ ở CLIENT): server nhận
 * mảng rawRows (đã parse server-side từ file upload) và nạp vào staging bằng UNNEST —
 * 1 câu lệnh SQL nạp hàng nghìn dòng, tốc độ tương đương COPY, không round-trip từng dòng.
 */
export async function bulkLoadToStaging(batchId: string, rows: Record<string, string>[]) {
  for (let i = 0; i < rows.length; i += STAGE_INSERT_CHUNK) {
    const chunk = rows.slice(i, i + STAGE_INSERT_CHUNK);
    const rowNumbers = chunk.map((_, idx) => i + idx + 1);
    const rawJson = chunk.map((r) => JSON.stringify(r));
    await pool.query(
      `INSERT INTO import_staging_rows (batch_id, row_number, raw_data, status)
       SELECT $1::uuid, x.rn, x.rd, 'PENDING'
       FROM unnest($2::int[], $3::jsonb[]) AS x(rn, rd)`,
      [batchId, rowNumbers, rawJson],
    );
  }
}

/** Áp dụng mapping thủ công (nếu có) do người dùng chọn ở bước "Map Columns" — đổi tên cột trong rawData
 *  sang đúng importColumnName trước khi đưa vào bộ dò alias tiêu chuẩn (makeFieldPicker không đổi). */
function applyMapping(row: Record<string, string>, mapping: Record<string, string> | null, fieldToImportName: Map<string, string>) {
  if (!mapping) return row;
  const copy = { ...row };
  for (const [fieldKey, uploadedHeader] of Object.entries(mapping)) {
    const canonical = fieldToImportName.get(fieldKey);
    if (canonical && uploadedHeader in copy) copy[canonical] = copy[uploadedHeader];
  }
  return copy;
}

type MergeResult = { processed: number; inserted: number; updated: number; duplicate: number; error: number; warning: number; done: boolean };

/** Xử lý 1 LÔ staging rows đang PENDING của 1 batch — transaction riêng, rollback độc lập nếu lỗi. */
export async function mergeNextChunk(batchId: string, importType: Group, mapping: Record<string, string> | null): Promise<MergeResult> {
  const client = await pool.connect();
  try {
    const pending = await client.query(
      `SELECT id, row_number, raw_data FROM import_staging_rows WHERE batch_id = $1 AND status = 'PENDING' ORDER BY row_number LIMIT $2`,
      [batchId, MERGE_CHUNK_SIZE],
    );
    if (pending.rows.length === 0) return { processed: 0, inserted: 0, updated: 0, duplicate: 0, error: 0, warning: 0, done: true };

    const defs = await getFieldDefinitions(importType);
    const fieldToImportName = new Map(defs.filter((d) => d.importColumnName).map((d) => [d.fieldKey, d.importColumnName as string]));

    let inserted = 0,
      updated = 0,
      duplicate = 0,
      errorC = 0,
      warningC = 0;

    await client.query("BEGIN");
    try {
      if (importType === "department") {
        for (const row of pending.rows) {
          const r = applyMapping(row.raw_data, mapping, fieldToImportName);
          const pick = makeFieldPicker(r, defs);
          const deptName = clean(pick("dept_name", ["Dept.", "Department"]));
          if (!deptName) {
            await markRow(client, row.id, "ERROR", "Thiếu tên Bộ phận (Dept.)");
            errorC++;
            continue;
          }
          const groupName = (clean(pick("dept_group", ["Group"])) ?? "").trim();
          await client.query(
            `INSERT INTO departments (stt, dept_name, group_name, vn_name, supervisor, supervisor_phone, sheet_link, daily_quota)
             VALUES ($1,$2,$3,$4,$5,$6,$7,0)
             ON CONFLICT (dept_name, group_name) WHERE deleted_at IS NULL DO UPDATE SET
               vn_name = EXCLUDED.vn_name, supervisor = EXCLUDED.supervisor,
               supervisor_phone = EXCLUDED.supervisor_phone, sheet_link = EXCLUDED.sheet_link`,
            [
              parseInt(pick("dept_stt", ["STT"]) ?? "") || null,
              deptName,
              groupName,
              clean(pick("dept_vn_name", ["Tên Tiếng Việt"])),
              clean(pick("dept_supervisor", ["Phụ Trách Lao Động"])),
              clean(pick("dept_supervisor_phone", ["SĐT"])),
              clean(pick("dept_note", ["Note here!"])),
            ],
          );
          await markRow(client, row.id, "INSERTED", null);
          inserted++;
        }
      } else if (importType === "dw_data") {
        for (const row of pending.rows) {
          const r = applyMapping(row.raw_data, mapping, fieldToImportName);
          const pick = makeFieldPicker(r, defs);
          const fullName = clean(pick("dw_full_name", ["HỌ TÊN", "Full Name"]));
          if (!fullName) {
            await markRow(client, row.id, "ERROR", "Thiếu Họ tên");
            errorC++;
            continue;
          }
          const cccd = clean(pick("dw_cccd", ["ID No", "CCCD"]));
          if (!isValidCccd(cccd)) {
            await markRow(client, row.id, "ERROR", CCCD_ERROR_MESSAGE);
            errorC++;
            continue;
          }
          try {
            const res = await client.query(
              `INSERT INTO dw_data (code, it_code, old_dw_code, id_vlookup, full_name, gender, bod, profile, dktn,
                 cccd, date_of_issue, place_of_issue, permanent_address, residential_address, phone)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               ON CONFLICT (cccd) WHERE deleted_at IS NULL DO NOTHING
               RETURNING id`,
              [
                clean(pick("dw_code", ["CODE"])),
                clean(pick("dw_it_code", ["IT CODE"])),
                clean(pick("dw_old_code", ["OldDW_VLOOKUP"])),
                clean(pick("dw_id_vlookup", ["ID_VLOOKUP"])),
                fullName,
                clean(pick("dw_gender", ["GENDER"])),
                clean(pick("dw_bod", ["BOD"])),
                clean(pick("dw_profile", ["PROFILE"])),
                clean(pick("dw_dktn", ["ĐKTN"])),
                cccd,
                clean(pick("dw_date_of_issue", ["Date of issue"])),
                clean(pick("dw_place_of_issue", ["Place of issue"])),
                clean(pick("dw_permanent_address", ["Permanent address"])),
                clean(pick("dw_residential_address", ["Residential address"])),
                digits(pick("dw_phone", ["Phone number"])),
              ],
            );
            if (res.rowCount && res.rowCount > 0) {
              await markRow(client, row.id, "INSERTED", null);
              inserted++;
            } else {
              await markRow(client, row.id, "DUPLICATE", cccd ? `CCCD "${cccd}" đã tồn tại trong DW Data` : "Trùng dữ liệu");
              duplicate++;
            }
          } catch (e) {
            await markRow(client, row.id, "ERROR", (e as Error).message);
            errorC++;
          }
        }
      } else if (importType === "daily_application") {
        const questions = await db.select().from(formQuestions).orderBy(asc(formQuestions.sortOrder));
        const { rows: dRows } = await client.query(`SELECT id, dept_name, group_name FROM departments WHERE deleted_at IS NULL`);
        const deptMap = new Map((dRows as { id: string; dept_name: string; group_name: string }[]).map((d) => [`${d.dept_name}|||${d.group_name}`, d.id]));

        for (const row of pending.rows) {
          const r = applyMapping(row.raw_data, mapping, fieldToImportName);
          const pick = makeFieldPicker(r, defs);
          const headerIndex = buildHeaderIndex(r);

          const cccd = clean(pick("da_cccd", ["CCCD"]));
          const fullName = clean(pick("da_full_name", ["Họ và tên"]));
          const phone = digits(pick("da_phone", ["SĐT"]));
          if (!cccd || !fullName || !phone) {
            await markRow(client, row.id, "ERROR", "Thiếu CCCD / Họ tên / SĐT (bắt buộc)");
            errorC++;
            continue;
          }
          if (!isValidCccd(cccd)) {
            await markRow(client, row.id, "ERROR", CCCD_ERROR_MESSAGE);
            errorC++;
            continue;
          }
          const regDate = toISO(pick("da_timestamp", ["Timepstamp", "Timestamp"]));
          if (!regDate) {
            await markRow(client, row.id, "ERROR", "Thiếu hoặc sai định dạng Ngày đăng ký");
            errorC++;
            continue;
          }

          const typeRaw = String(pick("da_declared_type", ["Thông tin lao động"]) ?? "");
          const declaredType = typeRaw.startsWith("Cũ") ? "OLD" : "NEW";
          const deptId = deptMap.get(`${clean(pick("da_dept", ["Bộ phận"])) ?? ""}|||${clean(pick("da_group", ["Nhóm"])) ?? ""}`) ?? null;

          const dobRaw = clean(pick("da_dob", ["Năm sinh"]));
          const birthYear = dobRaw?.match(/(\d{4})/)?.[1];
          const ageRaw = pick("da_age", ["Tuổi"]);

          const warnings: string[] = [];
          if (!/^0\d{8,10}$/.test(phone)) warnings.push(`SĐT "${phone}" có thể sai định dạng`);
          const ageNum = birthYear ? new Date().getFullYear() - parseInt(birthYear) : ageRaw ? parseFloat(ageRaw) : null;
          if (ageNum !== null && (ageNum < 15 || ageNum > 70)) warnings.push(`Tuổi ${ageNum} bất thường`);

          const { rows: match } = await client.query(`SELECT id, code FROM dw_data WHERE cccd = $1 AND deleted_at IS NULL LIMIT 1`, [cccd]);
          const dwMatch = match.length ? "MATCHED" : "NEW";

          const customAnswers: Record<string, string> = {};
          for (const q of questions) {
            for (const name of [q.questionText, ...((q.aliases as string[] | null) ?? [])]) {
              const original = headerIndex.get(normalizeHeader(name));
              if (original !== undefined && String(r[original] ?? "").trim() !== "") {
                customAnswers[q.fieldKey] = String(r[original]);
                break;
              }
            }
          }

          try {
            const res = await client.query(
              `INSERT INTO daily_applications (submitted_at, reg_date, cccd, full_name, gender, dob, birth_year, age,
                 phone, ethnicity, permanent_address, residential_address, declared_type, dw_match, dw_id, dw_code,
                 work_duration, referral_channel, dept_id, status, starting_date, appointment_list, note_worker,
                 vaccine, code_check, custom_answers, is_imported)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,true)
               ON CONFLICT (cccd, reg_date) WHERE deleted_at IS NULL DO NOTHING
               RETURNING id`,
              [
                `${regDate}T00:00:00+07:00`,
                regDate,
                cccd,
                fullName,
                clean(pick("da_gender", ["Giới tính"])),
                dobRaw,
                birthYear ? parseInt(birthYear) : null,
                ageRaw && parseFloat(ageRaw) ? Math.round(parseFloat(ageRaw)) : null,
                phone,
                clean(pick("da_ethnicity", ["Dân tộc"])),
                clean(pick("da_permanent_address", ["Địa chỉ"])),
                clean(pick("da_address", [" Địa chỉ"])),
                declaredType,
                dwMatch,
                match[0]?.id ?? null,
                match[0]?.code ?? null,
                clean(pick("da_work_duration", ["Thời gian đăng ký làm"])),
                clean(pick("da_referral", ["Kênh giới thiệu"])),
                deptId,
                deptId ? "APPROVED" : "PENDING",
                toISO(pick("da_starting_date", ["Starting date (Date)"])),
                clean(pick("da_appointment_list", ["DS hẹn"])),
                clean(pick("da_note", ["Ghi chú về lao động"])),
                clean(pick("da_vaccine", ["Tiêm vacccine"])),
                clean(pick("da_code_check", ["Code check"])),
                JSON.stringify(customAnswers),
              ],
            );
            if (res.rowCount && res.rowCount > 0) {
              if (warnings.length > 0) {
                await markRow(client, row.id, "INSERTED", "⚠ " + warnings.join("; "));
                warningC++;
              } else {
                await markRow(client, row.id, "INSERTED", null);
              }
              inserted++;
            } else {
              await markRow(client, row.id, "DUPLICATE", "Đã tồn tại đơn đăng ký cùng CCCD + ngày");
              duplicate++;
            }
          } catch (e) {
            await markRow(client, row.id, "ERROR", (e as Error).message);
            errorC++;
          }
        }
      }

      await client.query(
        `UPDATE import_batches SET
           processed_count = processed_count + $2,
           inserted_count = inserted_count + $3,
           updated_count = updated_count + $4,
           duplicate_count = duplicate_count + $5,
           error_count = error_count + $6,
           warning_count = warning_count + $7
         WHERE id = $1`,
        [batchId, pending.rows.length, inserted, updated, duplicate, errorC, warningC],
      );

      await client.query("COMMIT");
    } catch (txError) {
      await client.query("ROLLBACK");
      throw txError;
    }

    const remaining = await client.query(`SELECT count(*)::int c FROM import_staging_rows WHERE batch_id = $1 AND status = 'PENDING'`, [batchId]);
    const done = (remaining.rows[0]?.c ?? 0) === 0;

    return { processed: pending.rows.length, inserted, updated, duplicate, error: errorC, warning: warningC, done };
  } finally {
    client.release();
  }
}

async function markRow(client: { query: (q: string, p: unknown[]) => Promise<unknown> }, id: string, status: string, message: string | null) {
  await client.query(`UPDATE import_staging_rows SET status = $2, message = $3 WHERE id = $1`, [id, status, message]);
}

export { db, pool, eq, and, sql, importBatches, importStagingRows };
