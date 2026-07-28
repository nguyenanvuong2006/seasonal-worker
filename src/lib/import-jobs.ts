import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { after } from "next/server";
import { db, pool } from "@/db";
import { formQuestions, importJobErrors, importJobs, stagingDailyApplication, stagingDepartment, stagingDwData } from "@/db/schema";
import { getFieldDefinitions, makeFieldPicker, normalizeHeader, normalizeHeaderFuzzy, type Group } from "@/lib/metadata";
import { parseFlexibleDate, parseFlexibleDateTime } from "@/lib/date-parser";
import { CCCD_PATTERN, NUMBER_PATTERN, VN_PHONE_PATTERN } from "@/lib/validators";

/**
 * IMPORT ENGINE v3 — service layer. Xem ghi chú kiến trúc đầy đủ ở đầu src/db/schema.ts
 * (khối "IMPORT ENGINE v3"). File này chứa:
 *   - Bulk load file đã parse vào staging RIÊNG TỪNG LOẠI (UNNEST, không phải COPY streaming
 *     — lý do kỹ thuật giống Import Engine v2, xem HUONG_DAN_HE_THONG.md mục 12.1).
 *   - Từng giai đoạn (VALIDATING/MATCHING/MERGING/BUILDING_STATS) là SQL SET-BASED — KHÔNG
 *     có vòng lặp SELECT/INSERT theo từng dòng ở bất kỳ đâu trong file này.
 *   - `runNextStep()` xử lý ĐÚNG 1 bước cho 1 job rồi trả về; nơi gọi (worker route) chịu
 *     trách nhiệm tự "chain" bước kế tiếp bằng Next.js `after()`.
 */

export const STAGE_CHUNK = 2000; // số dòng merge / 1 câu lệnh SQL — đủ nhỏ để không chạm giới hạn, đủ lớn để nhanh
const STALE_MS = 90_000; // job không có heartbeat > 90s coi là "treo", watchdog được phép resume

type JobType = "department" | "dw_data" | "daily_application";

export async function createJob(jobType: JobType, fileName: string, checksum: string, createdBy: string, totalRows: number) {
  const [job] = await db
    .insert(importJobs)
    .values({ jobType, fileName, checksum, createdBy, totalRows, status: "QUEUED", currentStage: "STAGING" })
    .returning();
  return job;
}

async function touch(jobId: string, patch: Record<string, unknown>) {
  await db
    .update(importJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(importJobs.id, jobId));
}

async function logErrors(jobId: string, rows: { rowNumber: number; reason: string; data: Record<string, string>; severity?: "ERROR" | "WARNING" }[]) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    await db.insert(importJobErrors).values(
      chunk.map((r) => ({ jobId, rowNumber: r.rowNumber, reason: r.reason, originalData: r.data, severity: r.severity ?? "ERROR" })),
    );
  }
}

/* ============================================================
   BƯỚC 1 — STAGING: bulk load rows đã parse (server-side, từ upload) vào bảng
   staging đúng loại. UNNEST bulk insert (xem lý do kỹ thuật ở đầu file).
   ============================================================ */
export async function stageRows(jobId: string, jobType: JobType, rows: Record<string, string>[]) {
  const defs = await getFieldDefinitions(jobType as Group);
  const pickers = buildColumnPickers(defs, jobType);

  if (jobType === "department") {
    for (let i = 0; i < rows.length; i += 3000) {
      const chunk = rows.slice(i, i + 3000);
      const rn = chunk.map((_, idx) => i + idx + 1);
      await pool.query(
        `INSERT INTO staging_department (job_id, row_number, dept_stt, dept_name, group_name, vn_name, supervisor, supervisor_phone, note)
         SELECT $1::uuid, x.rn, x.stt, x.dn, x.gn, x.vn, x.sup, x.sp, x.nt
         FROM unnest($2::int[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
           AS x(rn, stt, dn, gn, vn, sup, sp, nt)`,
        [
          jobId,
          rn,
          chunk.map((r) => parseInt(pickers.dept_stt(r) ?? "") || null),
          chunk.map((r) => pickers.dept_name(r)),
          chunk.map((r) => pickers.dept_group(r) ?? ""),
          chunk.map((r) => pickers.dept_vn_name(r)),
          chunk.map((r) => pickers.dept_supervisor(r)),
          chunk.map((r) => pickers.dept_supervisor_phone(r)),
          chunk.map((r) => pickers.dept_note(r)),
        ],
      );
    }
  } else if (jobType === "dw_data") {
    for (let i = 0; i < rows.length; i += 3000) {
      const chunk = rows.slice(i, i + 3000);
      const rn = chunk.map((_, idx) => i + idx + 1);
      await pool.query(
        `INSERT INTO staging_dw_data (job_id, row_number, code, it_code, old_dw_code, id_vlookup, full_name, gender, bod,
           profile, dktn, cccd, date_of_issue, place_of_issue, permanent_address, residential_address, phone)
         SELECT $1::uuid, x.rn, x.code, x.itc, x.odc, x.idv, x.fn, x.gd, x.bod, x.pf, x.dk, x.cccd, x.doi, x.poi, x.pa, x.ra, x.ph
         FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                      $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[], $17::text[])
           AS x(rn, code, itc, odc, idv, fn, gd, bod, pf, dk, cccd, doi, poi, pa, ra, ph)`,
        [
          jobId,
          rn,
          chunk.map((r) => pickers.dw_code(r)),
          chunk.map((r) => pickers.dw_it_code(r)),
          chunk.map((r) => pickers.dw_old_code(r)),
          chunk.map((r) => pickers.dw_id_vlookup(r)),
          chunk.map((r) => pickers.dw_full_name(r)),
          chunk.map((r) => pickers.dw_gender(r)),
          chunk.map((r) => pickers.dw_bod(r)),
          chunk.map((r) => pickers.dw_profile(r)),
          chunk.map((r) => pickers.dw_dktn(r)),
          chunk.map((r) => digitsOnly(pickers.dw_cccd(r))),
          chunk.map((r) => pickers.dw_date_of_issue(r)),
          chunk.map((r) => pickers.dw_place_of_issue(r)),
          chunk.map((r) => pickers.dw_permanent_address(r)),
          chunk.map((r) => pickers.dw_residential_address(r)),
          chunk.map((r) => digitsOnly(pickers.dw_phone(r))),
        ],
      );
    }
  } else {
    const questions = await db.select().from(formQuestions);
    for (let i = 0; i < rows.length; i += 3000) {
      const chunk = rows.slice(i, i + 3000);
      const rn = chunk.map((_, idx) => i + idx + 1);
      const customAnswers = chunk.map((r) => {
        const headerIdx = new Map(Object.keys(r).map((k) => [normalizeHeader(k), k]));
        const fuzzyIdx = new Map(Object.keys(r).map((k) => [normalizeHeaderFuzzy(k), k]));
        const ans: Record<string, string> = {};
        for (const q of questions) {
          const names = [q.questionText, ...((q.aliases as string[] | null) ?? [])];
          let original = names.map((n) => headerIdx.get(normalizeHeader(n))).find((v) => v !== undefined);
          if (original === undefined) {
            original = names.map((n) => fuzzyIdx.get(normalizeHeaderFuzzy(n))).find((v) => v !== undefined);
          }
          if (original !== undefined && String(r[original] ?? "").trim() !== "") {
            ans[q.fieldKey] = String(r[original]);
          }
        }
        return JSON.stringify(ans);
      });
      await pool.query(
        `INSERT INTO staging_daily_application (job_id, row_number, cccd, full_name, gender, dob, age, phone, ethnicity,
           permanent_address, residential_address, declared_type_raw, dept_name, group_name, work_duration, referral_channel,
           starting_date_raw, starting_date_parsed, appointment_list, note, vaccine, code_check, reg_date_raw, reg_date_parsed, custom_answers)
         SELECT $1::uuid, x.rn, x.cccd, x.fn, x.gd, x.dob, x.age, x.ph, x.eth, x.pa, x.ra, x.dt, x.dn, x.gn, x.wd, x.rc,
                x.sd, x.sdp, x.al, x.nt, x.vc, x.cc, x.rd, x.rdp, x.ca::jsonb
         FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                      $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[],
                      $17::text[], $18::text[], $19::text[], $20::text[], $21::text[], $22::text[], $23::text[], $24::text[], $25::text[])
           AS x(rn, cccd, fn, gd, dob, age, ph, eth, pa, ra, dt, dn, gn, wd, rc, sd, sdp, al, nt, vc, cc, rd, rdp, ca)`,
        [
          jobId,
          rn,
          chunk.map((r) => digitsOnly(pickers.da_cccd(r))),
          chunk.map((r) => pickers.da_full_name(r)),
          chunk.map((r) => pickers.da_gender(r)),
          chunk.map((r) => pickers.da_dob(r)),
          chunk.map((r) => pickers.da_age(r)),
          chunk.map((r) => digitsOnly(pickers.da_phone(r))),
          chunk.map((r) => pickers.da_ethnicity(r)),
          chunk.map((r) => pickers.da_permanent_address(r)),
          chunk.map((r) => pickers.da_address(r)),
          chunk.map((r) => pickers.da_declared_type(r)),
          chunk.map((r) => pickers.da_dept(r)),
          chunk.map((r) => pickers.da_group(r)),
          chunk.map((r) => pickers.da_work_duration(r)),
          chunk.map((r) => pickers.da_referral(r)),
          // FIX TẬN GỐC lỗi "invalid input syntax for type timestamp": giữ NGUYÊN giá trị gốc
          // (*_raw, để hiện đúng trong báo cáo lỗi) VÀ chuẩn hoá song song bằng parser thống
          // nhất (*_parsed, ISO hợp lệ hoặc NULL) — MERGING chỉ dùng cột *_parsed để cast,
          // không bao giờ nối chuỗi hay cast trực tiếp dữ liệu thô chưa qua parser.
          chunk.map((r) => pickers.da_starting_date(r) ?? null),
          chunk.map((r) => parseFlexibleDate(pickers.da_starting_date(r))),
          chunk.map((r) => pickers.da_appointment_list(r)),
          chunk.map((r) => pickers.da_note(r)),
          chunk.map((r) => pickers.da_vaccine(r)),
          chunk.map((r) => pickers.da_code_check(r)),
          chunk.map((r) => pickers.da_timestamp(r) ?? null),
          chunk.map((r) => parseFlexibleDateTime(pickers.da_timestamp(r))?.iso ?? null),
          customAnswers,
        ],
      );
    }
  }
}

function digitsOnly(v: string | undefined): string | null {
  const s = (v ?? "").replace(/\D/g, "");
  return s.length ? s : null;
}

/** Xây "picker" cho từng field từ field_definitions (alias/import name) — áp dụng 1 lần cho toàn bộ rows khi staging. */
function buildColumnPickers(defs: Awaited<ReturnType<typeof getFieldDefinitions>>, jobType: JobType) {
  const keys =
    jobType === "department"
      ? ["dept_stt", "dept_name", "dept_group", "dept_vn_name", "dept_supervisor", "dept_supervisor_phone", "dept_note"]
      : jobType === "dw_data"
        ? ["dw_code", "dw_it_code", "dw_old_code", "dw_id_vlookup", "dw_full_name", "dw_gender", "dw_bod", "dw_profile", "dw_dktn", "dw_cccd", "dw_date_of_issue", "dw_place_of_issue", "dw_permanent_address", "dw_residential_address", "dw_phone"]
        : ["da_timestamp", "da_cccd", "da_full_name", "da_gender", "da_dob", "da_age", "da_phone", "da_ethnicity", "da_address", "da_permanent_address", "da_declared_type", "da_dept", "da_group", "da_work_duration", "da_referral", "da_starting_date", "da_appointment_list", "da_note", "da_vaccine", "da_code_check"];
  const out: Record<string, (row: Record<string, string>) => string | undefined> = {};
  for (const k of keys) out[k] = (row) => makeFieldPicker(row, defs)(k);
  return out as Record<
    | "dept_stt" | "dept_name" | "dept_group" | "dept_vn_name" | "dept_supervisor" | "dept_supervisor_phone" | "dept_note"
    | "dw_code" | "dw_it_code" | "dw_old_code" | "dw_id_vlookup" | "dw_full_name" | "dw_gender" | "dw_bod" | "dw_profile" | "dw_dktn" | "dw_cccd" | "dw_date_of_issue" | "dw_place_of_issue" | "dw_permanent_address" | "dw_residential_address" | "dw_phone"
    | "da_timestamp" | "da_cccd" | "da_full_name" | "da_gender" | "da_dob" | "da_age" | "da_phone" | "da_ethnicity" | "da_address" | "da_permanent_address" | "da_declared_type" | "da_dept" | "da_group" | "da_work_duration" | "da_referral" | "da_starting_date" | "da_appointment_list" | "da_note" | "da_vaccine" | "da_code_check",
    (row: Record<string, string>) => string | undefined
  >;
}

/* ============================================================
   BƯỚC 2 — VALIDATING (SET-BASED): 1-2 câu UPDATE đánh dấu valid=false +
   invalid_reason cho TOÀN BỘ staging cùng lúc — không lặp từng dòng.
   ============================================================ */
async function runValidating(jobId: string, jobType: JobType) {
  if (jobType === "department") {
    await pool.query(
      `UPDATE staging_department SET valid = false, invalid_reason = 'Thiếu tên Bộ phận (Dept.)'
       WHERE job_id = $1 AND (dept_name IS NULL OR btrim(dept_name) = '')`,
      [jobId],
    );
  } else if (jobType === "dw_data") {
    await pool.query(
      `UPDATE staging_dw_data SET valid = false, invalid_reason = 'Thiếu Họ tên'
       WHERE job_id = $1 AND (full_name IS NULL OR btrim(full_name) = '')`,
      [jobId],
    );
  } else {
    await pool.query(
      `UPDATE staging_daily_application SET valid = false, invalid_reason = 'Thiếu CCCD / Họ tên / SĐT (bắt buộc)'
       WHERE job_id = $1 AND (cccd IS NULL OR full_name IS NULL OR btrim(full_name) = '' OR phone IS NULL)`,
      [jobId],
    );
    await pool.query(
      `UPDATE staging_daily_application SET valid = false,
         invalid_reason = 'Ngày đăng ký không đúng định dạng — giá trị: "' || coalesce(reg_date_raw, '(trống)') || '"'
       WHERE job_id = $1 AND valid = true AND reg_date_parsed IS NULL`,
      [jobId],
    );
    // Ngày bắt đầu (starting_date) không bắt buộc — sai định dạng chỉ CẢNH BÁO, không chặn dòng.
    await pool.query(
      `INSERT INTO import_job_errors (job_id, row_number, reason, original_data, severity)
       SELECT job_id, row_number,
              'Ngày bắt đầu không đúng định dạng — giá trị: "' || starting_date_raw || '" (bỏ qua trường này, các trường khác vẫn nhập)',
              jsonb_build_object('row_number', row_number, 'starting_date_raw', starting_date_raw), 'WARNING'
       FROM staging_daily_application
       WHERE job_id = $1 AND valid = true AND starting_date_raw IS NOT NULL AND btrim(starting_date_raw) <> '' AND starting_date_parsed IS NULL`,
      [jobId],
    );
    // DATA QUALITY (Warning, không chặn — ghi log riêng ở bước ghi lỗi/cảnh báo, không đổi valid).
  }

  // Ghi các dòng invalid vào import_job_errors (set-based INSERT...SELECT, 1 câu lệnh).
  const table = jobType === "department" ? "staging_department" : jobType === "dw_data" ? "staging_dw_data" : "staging_daily_application";
  await pool.query(
    `INSERT INTO import_job_errors (job_id, row_number, reason, original_data, severity)
     SELECT job_id, row_number, invalid_reason, to_jsonb(t) - 'job_id' - 'id' - 'valid' - 'invalid_reason', 'ERROR'
     FROM ${table} t WHERE job_id = $1 AND valid = false`,
    [jobId],
  );
  const errCount = await pool.query(`SELECT count(*)::int c FROM ${table} WHERE job_id = $1 AND valid = false`, [jobId]);
  const warnCount = await pool.query(`SELECT count(*)::int c FROM import_job_errors WHERE job_id = $1 AND severity = 'WARNING'`, [jobId]);
  return { errorRows: errCount.rows[0]?.c ?? 0, warningRows: warnCount.rows[0]?.c ?? 0 };
}

/* ============================================================
   BƯỚC 3 — MATCHING (chỉ daily_application, SET-BASED): 1 câu UPDATE...FROM
   JOIN toàn bộ staging với dw_data + departments 1 LẦN — thay vì
   "SELECT dw_data 15.774 lần" như kiến trúc cũ.
   ============================================================ */
async function runMatching(jobId: string) {
  await pool.query(
    `UPDATE staging_daily_application s SET
       resolved_dw_id = d.id, resolved_dw_code = d.code, resolved_dw_match = 'MATCHED'
     FROM dw_data d
     WHERE s.job_id = $1 AND s.valid = true AND d.cccd = s.cccd AND d.deleted_at IS NULL`,
    [jobId],
  );
  await pool.query(
    `UPDATE staging_daily_application SET resolved_dw_match = 'NEW'
     WHERE job_id = $1 AND valid = true AND resolved_dw_match IS NULL`,
    [jobId],
  );
  await pool.query(
    `UPDATE staging_daily_application s SET resolved_dept_id = dep.id
     FROM departments dep
     WHERE s.job_id = $1 AND s.valid = true AND dep.dept_name = s.dept_name
       AND dep.group_name = coalesce(s.group_name, '') AND dep.deleted_at IS NULL`,
    [jobId],
  );

  // Data Quality — cảnh báo (không chặn) cho CCCD/SĐT sai định dạng — set-based, dùng ĐÚNG
  // pattern từ src/lib/validators.ts (CCCD_PATTERN/VN_PHONE_PATTERN) — không viết lại regex.
  const warn = await pool.query(
    `SELECT row_number, cccd, phone, age,
        CASE WHEN cccd !~ $2 THEN 'CCCD "' || coalesce(cccd,'') || '" không đúng định dạng' END AS r1,
        CASE WHEN phone !~ $3 THEN 'SĐT "' || coalesce(phone,'') || '" có thể sai định dạng' END AS r2,
        CASE WHEN age ~ $4 AND (age::numeric < 15 OR age::numeric > 70) THEN 'Tuổi ' || age || ' bất thường (dưới 15 hoặc trên 70)' END AS r3
      FROM staging_daily_application
      WHERE job_id = $1 AND valid = true
        AND (cccd !~ $2 OR phone !~ $3 OR (age ~ $4 AND (age::numeric < 15 OR age::numeric > 70)))`,
    [jobId, CCCD_PATTERN, VN_PHONE_PATTERN, NUMBER_PATTERN],
  );
  if (warn.rows.length > 0) {
    const errs = warn.rows.flatMap((r: { row_number: number; r1: string | null; r2: string | null; r3: string | null; cccd: string; phone: string; age: string }) => {
      const reasons = [r.r1, r.r2, r.r3].filter(Boolean) as string[];
      return reasons.length ? [{ rowNumber: r.row_number, reason: reasons.join("; "), data: { cccd: r.cccd, phone: r.phone, age: r.age }, severity: "WARNING" as const }] : [];
    });
    await logErrors(jobId, errs);
  }
  return { warningRows: warn.rows.length };
}

/* ============================================================
   BƯỚC 4 — MERGING (SET-BASED, chunked theo row_number để giữ tiến trình +
   resume thật): INSERT...SELECT...ON CONFLICT — 1 câu lệnh xử lý cả lô,
   KHÔNG mở transaction ứng dụng lồng nhau qua nhiều round-trip cho từng dòng.
   ============================================================ */
async function runMergingChunk(jobId: string, jobType: JobType, fromRow: number, toRow: number) {
  if (jobType === "department") {
    const res = await pool.query(
      `INSERT INTO departments (stt, dept_name, group_name, vn_name, supervisor, supervisor_phone, sheet_link, daily_quota)
       SELECT dept_stt, dept_name, coalesce(group_name,''), vn_name, supervisor, supervisor_phone, note, 0
       FROM staging_department
       WHERE job_id = $1 AND valid = true AND row_number BETWEEN $2 AND $3
       ON CONFLICT (dept_name, group_name) WHERE deleted_at IS NULL DO UPDATE SET
         vn_name = EXCLUDED.vn_name, supervisor = EXCLUDED.supervisor,
         supervisor_phone = EXCLUDED.supervisor_phone, sheet_link = EXCLUDED.sheet_link
       RETURNING (xmax = 0) AS inserted`,
      [jobId, fromRow, toRow],
    );
    const inserted = res.rows.filter((r: { inserted: boolean }) => r.inserted).length;
    return { inserted, updated: res.rows.length - inserted, duplicate: 0 };
  }

  if (jobType === "dw_data") {
    const res = await pool.query(
      `INSERT INTO dw_data (code, it_code, old_dw_code, id_vlookup, full_name, gender, bod, profile, dktn,
         cccd, date_of_issue, place_of_issue, permanent_address, residential_address, phone)
       SELECT code, it_code, old_dw_code, id_vlookup, full_name, gender, bod, profile, dktn,
              cccd, date_of_issue, place_of_issue, permanent_address, residential_address, phone
       FROM staging_dw_data
       WHERE job_id = $1 AND valid = true AND row_number BETWEEN $2 AND $3
       ON CONFLICT (cccd) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id`,
      [jobId, fromRow, toRow],
    );
    const attempted = await pool.query(
      `SELECT count(*)::int c FROM staging_dw_data WHERE job_id = $1 AND valid = true AND row_number BETWEEN $2 AND $3 AND cccd IS NOT NULL`,
      [jobId, fromRow, toRow],
    );
    const inserted = res.rowCount ?? 0;
    const duplicate = Math.max(0, (attempted.rows[0]?.c ?? 0) - inserted);
    return { inserted, updated: 0, duplicate };
  }

  // daily_application
  const res = await pool.query(
    `INSERT INTO daily_applications (submitted_at, reg_date, cccd, full_name, gender, dob, birth_year, age, phone,
       ethnicity, permanent_address, residential_address, declared_type, dw_match, dw_id, dw_code, work_duration,
       referral_channel, dept_id, status, starting_date, appointment_list, note_worker, vaccine, code_check,
       custom_answers, is_imported)
     SELECT
       reg_date_parsed::timestamptz, reg_date_parsed::date, cccd, full_name, gender, dob,
       NULLIF(substring(dob from '[0-9]{4}'), '')::int,
       CASE WHEN age ~ '^[0-9]+(\\.[0-9]+)?$' THEN round(age::numeric)::int ELSE NULL END,
       phone, ethnicity, permanent_address, residential_address,
       CASE WHEN declared_type_raw LIKE 'Cũ%' THEN 'OLD' ELSE 'NEW' END,
       resolved_dw_match, resolved_dw_id, resolved_dw_code, work_duration, referral_channel, resolved_dept_id,
       CASE WHEN resolved_dept_id IS NOT NULL THEN 'APPROVED' ELSE 'PENDING' END,
       starting_date_parsed::date, appointment_list, note, vaccine, code_check, coalesce(custom_answers,'{}'::jsonb), true
     FROM staging_daily_application
     WHERE job_id = $1 AND valid = true AND row_number BETWEEN $2 AND $3
     ON CONFLICT (cccd, reg_date) WHERE deleted_at IS NULL DO NOTHING
     RETURNING id`,
    [jobId, fromRow, toRow],
  );
  const attempted = await pool.query(
    `SELECT count(*)::int c FROM staging_daily_application WHERE job_id = $1 AND valid = true AND row_number BETWEEN $2 AND $3`,
    [jobId, fromRow, toRow],
  );
  const inserted = res.rowCount ?? 0;
  const duplicate = Math.max(0, (attempted.rows[0]?.c ?? 0) - inserted);
  return { inserted, updated: 0, duplicate };
}

async function runBuildingStats(jobId: string, jobType: JobType) {
  if (jobType === "department") return;
  // Đồng bộ dw_id/dw_code ngược lại cho các đơn vừa map vào dw_data mới insert cùng đợt (nếu có).
  if (jobType === "daily_application") {
    await pool.query(
      `UPDATE daily_applications a SET dw_id = d.id, dw_code = d.code, dw_match = 'MATCHED'
       FROM dw_data d
       WHERE a.dw_id IS NULL AND a.cccd = d.cccd AND d.deleted_at IS NULL
         AND a.id IN (SELECT id FROM daily_applications WHERE is_imported = true ORDER BY created_at DESC LIMIT 50000)`,
    );
  }
}

/* ============================================================
   ORCHESTRATOR — xử lý ĐÚNG 1 bước rồi trả về. Nơi gọi (worker route) tự
   quyết định có "chain" tiếp hay không (dựa vào done=false).
   ============================================================ */
export async function runNextStep(jobId: string): Promise<{ done: boolean; stage: string; job: typeof importJobs.$inferSelect }> {
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, jobId));
  if (!job) throw new Error("Job không tồn tại.");
  if (job.status === "CANCELLED" || job.status === "DONE") return { done: true, stage: job.currentStage, job };

  await touch(jobId, { status: "RUNNING", startedAt: job.startedAt ?? new Date() });
  const jobType = job.jobType as JobType;

  try {
    if (job.currentStage === "STAGING") {
      // Staging đã chạy xong ở bước upload (đồng bộ, vì thường đủ nhanh) — bước này chỉ là điểm nối,
      // chuyển thẳng sang VALIDATING.
      await touch(jobId, { currentStage: "VALIDATING", progress: 10 });
      return { done: false, stage: "VALIDATING", job };
    }

    if (job.currentStage === "VALIDATING") {
      const { errorRows, warningRows } = await runValidating(jobId, jobType);
      const nextStage = jobType === "daily_application" ? "MATCHING" : "MERGING";
      await touch(jobId, { currentStage: nextStage, progress: 25, errorRows, warningRows });
      return { done: false, stage: nextStage, job };
    }

    if (job.currentStage === "MATCHING") {
      await runMatching(jobId);
      const totalWarnings = await pool.query(`SELECT count(*)::int c FROM import_job_errors WHERE job_id = $1 AND severity = 'WARNING'`, [jobId]);
      await touch(jobId, { currentStage: "MERGING", progress: 40, warningRows: totalWarnings.rows[0]?.c ?? 0 });
      return { done: false, stage: "MERGING", job };
    }

    if (job.currentStage === "MERGING") {
      const cursor = (job.metadata as { mergeCursor?: number })?.mergeCursor ?? 0;
      const fromRow = cursor + 1;
      const toRow = cursor + STAGE_CHUNK;
      const chunkStartedAt = Date.now();
      const { inserted, updated, duplicate } = await runMergingChunk(jobId, jobType, fromRow, toRow);
      const chunkMs = Date.now() - chunkStartedAt;
      const rowsThisChunk = Math.min(toRow, job.totalRows) - cursor;

      // LOGGING (#9) — mỗi lô ghi đủ: thời gian, số dòng, số lỗi/duplicate, throughput, memory.
      // Structured JSON (không phải chuỗi tự do) để dễ lọc/parse trên Vercel Logs khi debug production.
      console.log(
        JSON.stringify({
          event: "import_chunk_merged",
          jobId,
          jobType,
          fromRow,
          toRow,
          rowsThisChunk,
          inserted,
          updated,
          duplicate,
          durationMs: chunkMs,
          throughputRowsPerSec: chunkMs > 0 ? Math.round((rowsThisChunk / chunkMs) * 1000) : null,
          memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          memoryHeapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        }),
      );

      const processedNow = Math.min(toRow, job.totalRows);
      const isLastChunk = toRow >= job.totalRows;
      await touch(jobId, {
        processedRows: processedNow,
        insertedRows: job.insertedRows + inserted,
        updatedRows: job.updatedRows + updated,
        duplicateRows: job.duplicateRows + duplicate,
        progress: Math.min(95, 40 + Math.round((processedNow / Math.max(1, job.totalRows)) * 55)),
        metadata: { ...(job.metadata as object), mergeCursor: toRow, lastChunkMs: chunkMs },
        currentStage: isLastChunk ? "BUILDING_STATS" : "MERGING",
      });
      return { done: false, stage: isLastChunk ? "BUILDING_STATS" : "MERGING", job };
    }

    if (job.currentStage === "BUILDING_STATS") {
      await runBuildingStats(jobId, jobType);
      await touch(jobId, { currentStage: "DONE", progress: 100, status: "DONE", finishedAt: new Date() });
      return { done: true, stage: "DONE", job };
    }

    // Trạng thái không xác định — coi như xong để tránh vòng lặp vô hạn.
    await touch(jobId, { status: "DONE", currentStage: "DONE", progress: 100, finishedAt: new Date() });
    return { done: true, stage: "DONE", job };
  } catch (error) {
    await touch(jobId, { status: "FAILED", lastError: translateError(error as Error) });
    return { done: true, stage: "FAILED", job };
  }
}

/**
 * ERROR REPORT (#6) — không hiển thị lỗi PostgreSQL thô. Đây là LỚP PHÒNG THỦ THỨ 2 (thứ
 * nhất là validate trước khi merge, đã chặn hầu hết trường hợp) — cho các lỗi hệ thống
 * không lường trước (mất kết nối, ràng buộc DB khác...). Dịch các mã lỗi Postgres phổ biến
 * sang tiếng Việt dễ hiểu; nếu không nhận diện được, trả về câu chung chung thay vì rò rỉ
 * chi tiết kỹ thuật.
 */
function translateError(error: Error & { code?: string }): string {
  const code = error.code;
  if (code === "22007" || code === "22008") return "Có dữ liệu ngày/giờ không đúng định dạng trong lô này — vui lòng kiểm tra lại file gốc.";
  if (code === "22P02") return "Có dữ liệu sai kiểu (số/ngày/UUID không hợp lệ) trong lô này.";
  if (code === "23505") return "Có dữ liệu trùng khoá trong lô này (đã được xử lý riêng ở bước kiểm tra trùng lặp).";
  if (code === "23503") return "Có dữ liệu tham chiếu tới bản ghi không tồn tại (bộ phận/lao động đã bị xoá?).";
  if (code === "57014") return "Câu lệnh xử lý quá thời gian cho phép — hệ thống sẽ tự thử lại lô nhỏ hơn.";
  if (code === "ECONNRESET" || code === "ETIMEDOUT") return "Mất kết nối tạm thời tới database — bấm Resume để tiếp tục.";
  return "Lỗi hệ thống khi xử lý lô dữ liệu này — bấm Resume để thử lại, hoặc liên hệ Admin nếu lặp lại nhiều lần.";
}

/** Kích hoạt bước kế tiếp KHÔNG chờ kết quả — dùng Next.js after() để đảm bảo lời gọi thật sự
 *  được gửi đi dù response đã trả về trình duyệt (browser có thể đóng ngay sau khi upload). */
export function triggerWorker(jobId: string, resumeToken: string, baseUrl: string) {
  after(async () => {
    try {
      // FIX VERCEL LOOP PROTECTION: Chạy vòng lặp while ngay trong background 
      // để xử lý nhiều chunk nhất có thể trong 45 giây (dưới ngưỡng 60s maxDuration).
      const deadline = Date.now() + 45000; 
      let isDone = false;
      
      while (!isDone && Date.now() < deadline) {
        const res = await runNextStep(jobId);
        isDone = res.done;
      }

      // Nếu hết 45s mà vẫn chưa done (file cực kỳ lớn), MỚI gọi fetch 1 lần
      // sang một worker mới để nhường resource và né Loop Protection.
      if (!isDone) {
        await fetch(`${baseUrl}/api/import/worker`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId, resumeToken }),
        });
      }
    } catch {
      /* watchdog cron sẽ phát hiện & resume nếu lần "chain" này thất bại (mất mạng, cold start...) */
    }
  });
}

/** Watchdog — job RUNNING/QUEUED nhưng không có heartbeat gần đây (invocation trước đó chết giữa chừng). */
export async function findStalledJobs() {
  const cutoff = new Date(Date.now() - STALE_MS);
  return db
    .select()
    .from(importJobs)
    .where(and(sql`${importJobs.status} IN ('QUEUED','RUNNING')`, sql`${importJobs.updatedAt} < ${cutoff}`));
}
