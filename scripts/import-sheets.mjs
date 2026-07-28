// Nạp dữ liệu thật từ 3 sheet Google (Department, DW Data, Daily Application)
import fs from "node:fs";
import { parse } from "csv-parse/sync";
import pg from "pg";

const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const pool = new pg.Pool({ connectionString: DB });

const read = (f) =>
  parse(fs.readFileSync(f, "utf8"), { columns: true, skip_empty_lines: true, relax_column_count: true });

const clean = (v) => {
  const s = String(v ?? "").trim();
  return s === "" || s === "0" || s === "#N/A" || s === "-" ? null : s;
};
const digits = (v) => {
  const s = String(v ?? "").replace(/\D/g, "");
  return s.length ? s : null;
};

async function main() {
  const c = await pool.connect();
  try {
    /* ---------- 1. DEPARTMENT ---------- */
    const depts = read("data/department.csv");
    let dcount = 0;
    for (const r of depts) {
      const deptName = clean(r["Dept."]);
      if (!deptName) continue;
      const groupName = (clean(r["Group"]) ?? "").trim();
      await c.query(
        `INSERT INTO departments (stt, dept_name, group_name, vn_name, supervisor, supervisor_phone, sheet_link, daily_quota)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (dept_name, group_name) DO UPDATE SET
           vn_name = EXCLUDED.vn_name, supervisor = EXCLUDED.supervisor,
           supervisor_phone = EXCLUDED.supervisor_phone, sheet_link = EXCLUDED.sheet_link`,
        [
          parseInt(r["STT"]) || null,
          deptName,
          groupName,
          clean(r["Tên Tiếng Việt"]),
          clean(r["Phụ Trách Lao Động"]),
          clean(r["SĐT"]),
          clean(r["Note here!"]),
          0,
        ],
      );
      dcount++;
    }
    console.log(`✓ Departments: ${dcount}`);

    /* ---------- 2. DW DATA ---------- */
    const dw = read("data/dw_data.csv");
    const seen = new Set();
    let batch = [];
    let wcount = 0;
    const flush = async () => {
      if (!batch.length) return;
      const vals = [];
      const ph = batch
        .map((row, i) => {
          const b = i * 15;
          vals.push(...row);
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15})`;
        })
        .join(",");
      await c.query(
        `INSERT INTO dw_data (code, it_code, old_dw_code, id_vlookup, full_name, gender, bod, profile, dktn,
           cccd, date_of_issue, place_of_issue, permanent_address, residential_address, phone)
         VALUES ${ph} ON CONFLICT (cccd) DO NOTHING`,
        vals,
      );
      wcount += batch.length;
      batch = [];
    };

    for (const r of dw) {
      const fullName = clean(r["HỌ TÊN"]);
      if (!fullName) continue;
      const cccd = digits(r["ID No"]);
      // CCCD là khoá đối chiếu — bỏ qua bản ghi trùng CCCD trong file
      if (cccd) {
        if (seen.has(cccd)) continue;
        seen.add(cccd);
      }
      batch.push([
        clean(r["CODE"]),
        clean(r["IT CODE"]),
        clean(r["OldDW_VLOOKUP"]),
        clean(r["ID_VLOOKUP"]),
        fullName,
        clean(r["GENDER"]),
        clean(r["BOD"]),
        clean(r["PROFILE"]),
        clean(r["ĐKTN"]),
        cccd,
        clean(r["Date of issue"]),
        clean(r["Place of issue"]),
        clean(r["Permanent address"]),
        clean(r["Residential address"]),
        digits(r["Phone number"]),
      ]);
      if (batch.length >= 400) await flush();
    }
    await flush();
    console.log(`✓ DW Data: ${wcount} hồ sơ lao động`);

    /* ---------- 3. DAILY APPLICATION (lịch sử tham khảo) ---------- */
    const apps = read("data/daily_application.csv");
    const { rows: dRows } = await c.query(`SELECT id, dept_name, group_name FROM departments`);
    const deptMap = new Map(dRows.map((d) => [`${d.dept_name}|||${d.group_name}`, d.id]));

    const toISO = (s) => {
      const m = String(s ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    };

    let acount = 0;
    const dupDate = new Set();
    for (const r of apps) {
      const cccd = digits(r["CCCD"]);
      const fullName = clean(r["Họ và tên"]);
      const phone = digits(r["SĐT"]);
      // YÊU CẦU MỚI: CCCD BẮT BUỘC — bỏ qua bản ghi thiếu CCCD (dữ liệu cũ lỗi)
      if (!cccd || !fullName || !phone) continue;

      const ts = String(r["Timepstamp"] ?? "");
      const regDate = toISO(ts);
      if (!regDate) continue;
      const key = `${cccd}|${regDate}`;
      if (dupDate.has(key)) continue;
      dupDate.add(key);

      const typeRaw = String(r["Thông tin lao động"] ?? "");
      const declaredType = typeRaw.startsWith("Cũ") ? "OLD" : "NEW";
      const deptId = deptMap.get(`${clean(r["Bộ phận"]) ?? ""}|||${clean(r["Nhóm"]) ?? ""}`) ?? null;

      const dobRaw = clean(r["Năm sinh"]);
      const birthYear = dobRaw?.match(/(\d{4})/)?.[1];

      // Đối chiếu DW Data
      const { rows: match } = await c.query(`SELECT id, code FROM dw_data WHERE cccd = $1 LIMIT 1`, [cccd]);
      const dwMatch = match.length ? "MATCHED" : "NEW";

      try {
        await c.query(
          `INSERT INTO daily_applications (submitted_at, reg_date, cccd, full_name, gender, dob, birth_year, age,
             phone, ethnicity, permanent_address, residential_address, declared_type, dw_match, dw_id, dw_code,
             work_duration, referral_channel, dept_id, status, starting_date, appointment_list, note_worker,
             vaccine, code_check, is_imported)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
           ON CONFLICT (cccd, reg_date) DO NOTHING`,
          [
            new Date(`${regDate}T00:00:00+07:00`),
            regDate,
            cccd,
            fullName,
            clean(r["Giới tính"]),
            dobRaw,
            birthYear ? parseInt(birthYear) : null,
            parseFloat(r["Tuổi"]) ? Math.round(parseFloat(r["Tuổi"])) : null,
            phone,
            clean(r["Dân tộc"]),
            clean(r["Địa chỉ"]),
            clean(r[" Địa chỉ"]),
            declaredType,
            dwMatch,
            match[0]?.id ?? null,
            match[0]?.code ?? null,
            clean(r["Thời gian đăng ký làm"]),
            clean(r["Kênh giới thiệu"]),
            deptId,
            deptId ? "APPROVED" : "PENDING",
            toISO(r["Starting date (Date)"]),
            clean(r["DS hẹn"]),
            clean(r["Ghi chú về lao động"]),
            clean(r["Tiêm vacccine"]),
            clean(r["Code check"]),
            true,
          ],
        );
        acount++;
      } catch {
        /* skip bad row */
      }
    }
    console.log(`✓ Daily Applications: ${acount} (đã loại bỏ bản ghi thiếu CCCD)`);

    /* ---------- 4. Cập nhật ngày công vào DW Data ---------- */
    await c.query(`
      UPDATE dw_data w SET
        total_work_days = s.cnt,
        last_work_date  = s.last
      FROM (
        SELECT cccd, count(*)::int AS cnt, max(reg_date) AS last
        FROM daily_applications WHERE status = 'APPROVED' GROUP BY cccd
      ) s WHERE w.cccd = s.cccd
    `);

    const stat = await c.query(`
      SELECT (SELECT count(*) FROM departments) d,
             (SELECT count(*) FROM dw_data) w,
             (SELECT count(*) FROM daily_applications) a,
             (SELECT count(*) FROM daily_applications WHERE dw_match='NEW') n
    `);
    console.log("📊", stat.rows[0]);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
