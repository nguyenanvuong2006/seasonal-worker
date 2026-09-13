#!/usr/bin/env node
/**
 * OPERATIONAL CODE GO-LIVE READINESS — LEGACY INVENTORY (READ-ONLY)
 * ------------------------------------------------------------
 * Mission F section 4-8. Performs ONLY SELECT statements — never
 * INSERT/UPDATE/DELETE/DDL. Reports the CURRENT state of the legacy
 * plain-text `dw_data.code` / IT Code mirrors (`dw_data.it_code`,
 * `worker_profiles.fingerprint_code`, `daily_applications.it_code`)
 * BEFORE any Mission E canonical-pool activation is attempted — this is
 * the P1 bootstrap-safety check: activating the pool allocator with an
 * unsafe `nextSequence` could otherwise issue a code that a real,
 * currently-active worker already holds under the legacy free-text
 * system (see dw-code-pool.ts's docblock — the pool starts empty and has
 * no awareness of pre-existing dw_data.code values).
 *
 * NEVER prints CCCD, phone, or full name — only aggregate counts and,
 * where a specific row must be identified for a conflict, the internal
 * opaque worker_profiles.id (itself not a person-identifying value in
 * isolation).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/diagnose-operational-codes.mjs
 *   node scripts/diagnose-operational-codes.mjs   # reads .env.local
 */
import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local" });
config();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Thiếu DATABASE_URL (đặt trong .env.local hoặc biến môi trường).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });

/** Prefix/sequence/suffix parse — the SAME shape dw-code-pool.ts's formatDwCode() produces
 * (PREFIX + zero-padded digits + separator + suffix), but permissive about prefix/suffix
 * charset since legacy codes were free-typed, never validated by validateDwCodeLocationInput().
 * Anything that doesn't match is UNRECOGNIZED_FORMAT — never guessed/coerced. */
const DW_CODE_RE = /^([A-Z]{1,8})(\d{1,10})([-_]?)([A-Z0-9]{0,8})$/;

function parseDwCode(code) {
  const m = DW_CODE_RE.exec((code || "").trim().toUpperCase());
  if (!m) return null;
  return { prefix: m[1], sequence: Number(m[2]), separator: m[3], suffix: m[4] };
}

async function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  await client.connect();
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "(không parse được host)";
    }
  })();
  console.log(`✅ Kết nối DB: host=${host}`);
  console.log("ℹ️  READ-ONLY — chỉ SELECT, không ghi bất kỳ dòng nào.");

  /* ============================================================
     DW CODE (Mã số công nhật / Internal DW Code) — dw_data.code
     ============================================================ */
  await section("DW CODE — TỔNG QUAN");

  const dwTotal = await client.query(
    `SELECT count(*)::int AS n FROM dw_data WHERE code IS NOT NULL AND trim(code) <> '' AND deleted_at IS NULL`,
  );
  const dwDistinct = await client.query(
    `SELECT count(DISTINCT code)::int AS n FROM dw_data WHERE code IS NOT NULL AND trim(code) <> '' AND deleted_at IS NULL`,
  );
  console.log(`Tổng số dw_data.code khác NULL (chưa xoá): ${dwTotal.rows[0].n}`);
  console.log(`Số code PHÂN BIỆT (distinct): ${dwDistinct.rows[0].n}`);

  const dwDuplicates = await client.query(`
    SELECT code, count(*)::int AS n
    FROM dw_data
    WHERE code IS NOT NULL AND trim(code) <> '' AND deleted_at IS NULL
    GROUP BY code
    HAVING count(*) > 1
    ORDER BY n DESC
    LIMIT 50
  `);
  console.log(`Code bị TRÙNG trên nhiều dòng dw_data (nghiêm trọng — cần xử lý thủ công trước khi bootstrap pool): ${dwDuplicates.rows.length}`);
  for (const r of dwDuplicates.rows) console.log(`  - "${r.code}" xuất hiện ${r.n} lần`);

  await section("DW CODE — NGƯỜI GIỮ HIỆN TẠI (ACTIVE vs FORMER)");

  const dwActiveHolders = await client.query(`
    SELECT count(*)::int AS n
    FROM dw_data d
    JOIN worker_profiles wp ON wp.cccd = d.cccd AND wp.deleted_at IS NULL
    JOIN employment_sessions es ON es.worker_id = wp.id AND es.status = 'APPROVED' AND es.end_date IS NULL
    WHERE d.code IS NOT NULL AND trim(d.code) <> '' AND d.deleted_at IS NULL
  `);
  const dwFormerHolders = await client.query(`
    SELECT count(*)::int AS n
    FROM dw_data d
    WHERE d.code IS NOT NULL AND trim(d.code) <> '' AND d.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM worker_profiles wp
        JOIN employment_sessions es ON es.worker_id = wp.id AND es.status = 'APPROVED' AND es.end_date IS NULL
        WHERE wp.cccd = d.cccd AND wp.deleted_at IS NULL
      )
  `);
  const dwNoWorker = await client.query(`
    SELECT count(*)::int AS n
    FROM dw_data d
    WHERE d.code IS NOT NULL AND trim(d.code) <> '' AND d.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM worker_profiles wp WHERE wp.cccd = d.cccd AND wp.deleted_at IS NULL)
  `);
  console.log(`Code thuộc worker đang CÓ Employment ACTIVE: ${dwActiveHolders.rows[0].n}`);
  console.log(`Code thuộc worker KHÔNG có Employment ACTIVE (cựu nhân sự / chưa xếp việc): ${dwFormerHolders.rows[0].n}`);
  console.log(`Code không map được sang bất kỳ worker_profiles nào (cccd không khớp): ${dwNoWorker.rows[0].n}`);

  const dwMultiActive = await client.query(`
    SELECT d.code, count(DISTINCT wp.id)::int AS active_workers
    FROM dw_data d
    JOIN worker_profiles wp ON wp.cccd = d.cccd AND wp.deleted_at IS NULL
    JOIN employment_sessions es ON es.worker_id = wp.id AND es.status = 'APPROVED' AND es.end_date IS NULL
    WHERE d.code IS NOT NULL AND trim(d.code) <> '' AND d.deleted_at IS NULL
    GROUP BY d.code
    HAVING count(DISTINCT wp.id) > 1
  `);
  console.log(`BLOCKER — code có NHIỀU HƠN 1 worker đang ACTIVE cùng lúc: ${dwMultiActive.rows.length}`);
  for (const r of dwMultiActive.rows) console.log(`  - "${r.code}": ${r.active_workers} worker active`);

  await section("DW CODE — PHÂN TÍCH ĐỊNH DẠNG / PREFIX (mission section 5)");

  const dwAll = await client.query(`
    SELECT d.code,
           EXISTS (
             SELECT 1 FROM worker_profiles wp
             JOIN employment_sessions es ON es.worker_id = wp.id AND es.status = 'APPROVED' AND es.end_date IS NULL
             WHERE wp.cccd = d.cccd AND wp.deleted_at IS NULL
           ) AS is_active
    FROM dw_data d
    WHERE d.code IS NOT NULL AND trim(d.code) <> '' AND d.deleted_at IS NULL
  `);

  const byPrefix = new Map();
  let unrecognized = 0;
  for (const row of dwAll.rows) {
    const parsed = parseDwCode(row.code);
    if (!parsed) {
      unrecognized += 1;
      continue;
    }
    const bucket = byPrefix.get(parsed.prefix) ?? { count: 0, minSeq: Infinity, maxSeq: -Infinity, active: 0, ambiguous: 0 };
    bucket.count += 1;
    bucket.minSeq = Math.min(bucket.minSeq, parsed.sequence);
    bucket.maxSeq = Math.max(bucket.maxSeq, parsed.sequence);
    if (row.is_active) bucket.active += 1;
    if (parsed.suffix === "" || parsed.separator === "") bucket.ambiguous += 1; // format present but incomplete vs. formatDwCode()'s canonical shape
    byPrefix.set(parsed.prefix, bucket);
  }
  console.log("Prefix | Count | Min seq | Max seq | Active | Ambiguous | ĐỀ XUẤT nextSequence bootstrap (>= max quan sát được + 1, KHÔNG tái dùng khoảng trống)");
  for (const [prefix, b] of [...byPrefix.entries()].sort((a, z) => z[1].count - a[1].count)) {
    console.log(`${prefix} | ${b.count} | ${b.minSeq} | ${b.maxSeq} | ${b.active} | ${b.ambiguous} | ${b.maxSeq + 1}`);
  }
  console.log(`UNRECOGNIZED_FORMAT (không khớp mẫu PREFIX+SỐ[+separator][+suffix]): ${unrecognized}`);

  await section("DW CODE — ĐỐI CHIẾU CẤU HÌNH ĐỊA ĐIỂM ĐÃ TỒN TẠI (dw_code_locations)");
  const existingLocations = await client.query(`SELECT prefix, name, next_sequence, is_active FROM dw_code_locations ORDER BY prefix`);
  if (existingLocations.rows.length === 0) {
    console.log("Chưa có location config nào được tạo — MỌI prefix quan sát được ở trên đều LOCATION_PREFIX_MAPPING_REQUIRED.");
  } else {
    const configuredPrefixes = new Set(existingLocations.rows.map((r) => r.prefix));
    for (const row of existingLocations.rows) {
      console.log(`  - ${row.prefix} (${row.name}) — nextSequence hiện tại=${row.next_sequence}, active=${row.is_active}`);
    }
    for (const prefix of byPrefix.keys()) {
      if (!configuredPrefixes.has(prefix)) console.log(`  ⚠ LOCATION_PREFIX_MAPPING_REQUIRED: prefix "${prefix}" quan sát được trong dữ liệu cũ nhưng CHƯA có dw_code_locations config.`);
    }
    for (const [prefix, b] of byPrefix.entries()) {
      const loc = existingLocations.rows.find((r) => r.prefix === prefix);
      if (loc && loc.next_sequence <= b.maxSeq) {
        console.log(`  🛑 SEQUENCE_UNSAFE: prefix "${prefix}" — dw_code_locations.next_sequence=${loc.next_sequence} <= legacy max quan sát được ${b.maxSeq}. Cấp code mới NGAY BÂY GIỜ có thể trùng code cũ đang dùng.`);
      }
    }
  }

  /* ============================================================
     IT CODE — dw_data.it_code / worker_profiles.fingerprint_code / daily_applications.it_code
     ============================================================ */
  await section("IT CODE — TỔNG QUAN (3 mirror hiện có)");

  const itDwData = await client.query(`SELECT count(*)::int AS n FROM dw_data WHERE it_code IS NOT NULL AND trim(it_code) <> '' AND deleted_at IS NULL`);
  const itWorkerProfiles = await client.query(`SELECT count(*)::int AS n FROM worker_profiles WHERE fingerprint_code IS NOT NULL AND trim(fingerprint_code) <> '' AND deleted_at IS NULL`);
  const itDailyApps = await client.query(`SELECT count(DISTINCT cccd)::int AS n FROM daily_applications WHERE it_code IS NOT NULL AND trim(it_code) <> ''`);
  console.log(`dw_data.it_code khác NULL: ${itDwData.rows[0].n}`);
  console.log(`worker_profiles.fingerprint_code khác NULL: ${itWorkerProfiles.rows[0].n}`);
  console.log(`daily_applications.it_code khác NULL (theo CCCD phân biệt): ${itDailyApps.rows[0].n}`);

  await section("IT CODE — ĐỐI CHIẾU 3 MIRROR THEO TỪNG WORKER");

  const mirrorRows = await client.query(`
    SELECT wp.id AS worker_ref,
           wp.fingerprint_code AS wp_code,
           d.it_code AS dw_code,
           es.status AS emp_status,
           es.end_date AS emp_end_date
    FROM worker_profiles wp
    LEFT JOIN dw_data d ON d.cccd = wp.cccd AND d.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT status, end_date FROM employment_sessions
      WHERE worker_id = wp.id
      ORDER BY (status = 'APPROVED' AND end_date IS NULL) DESC, reg_date DESC
      LIMIT 1
    ) es ON true
    WHERE wp.deleted_at IS NULL AND (wp.fingerprint_code IS NOT NULL OR d.it_code IS NOT NULL)
  `);

  let consistent = 0;
  let missingMirror = 0;
  let conflicting = 0;
  let noItCode = 0;
  const employmentStatusBreakdown = new Map();
  for (const row of mirrorRows.rows) {
    const wpVal = (row.wp_code || "").trim() || null;
    const dwVal = (row.dw_code || "").trim() || null;
    if (!wpVal && !dwVal) noItCode += 1;
    else if (wpVal && dwVal && wpVal === dwVal) consistent += 1;
    else if ((wpVal && !dwVal) || (!wpVal && dwVal)) missingMirror += 1;
    else conflicting += 1;

    const activeLabel = row.emp_status === "APPROVED" && !row.emp_end_date ? "ACTIVE" : row.emp_status ? `${row.emp_status}${row.emp_end_date ? "(ENDED)" : ""}` : "NO_SESSION";
    employmentStatusBreakdown.set(activeLabel, (employmentStatusBreakdown.get(activeLabel) ?? 0) + 1);
  }
  console.log(`CONSISTENT (worker_profiles.fingerprint_code == dw_data.it_code): ${consistent}`);
  console.log(`MISSING_MIRROR (chỉ 1 trong 2 mirror có giá trị): ${missingMirror}`);
  console.log(`CONFLICTING_VALUES (2 mirror khác giá trị nhau — CẦN ĐỐI SOÁT THỦ CÔNG, không tự sửa): ${conflicting}`);
  console.log(`NO_IT_CODE: ${noItCode}`);
  console.log("Phân bố theo trạng thái Employment hiện tại của worker có IT Code mirror:");
  for (const [label, n] of employmentStatusBreakdown) console.log(`  - ${label}: ${n}`);

  await section("IT CODE — TRÙNG LẶP GIỮA NHIỀU WORKER ĐANG ACTIVE (BLOCKER)");
  const itMultiActive = await client.query(`
    SELECT wp.fingerprint_code AS code, count(DISTINCT wp.id)::int AS active_workers
    FROM worker_profiles wp
    JOIN employment_sessions es ON es.worker_id = wp.id AND es.status = 'APPROVED' AND es.end_date IS NULL
    WHERE wp.fingerprint_code IS NOT NULL AND trim(wp.fingerprint_code) <> '' AND wp.deleted_at IS NULL
    GROUP BY wp.fingerprint_code
    HAVING count(DISTINCT wp.id) > 1
  `);
  console.log(`BLOCKER — IT Code có NHIỀU HƠN 1 worker đang ACTIVE cùng lúc: ${itMultiActive.rows.length}`);
  for (const r of itMultiActive.rows) console.log(`  - "${r.code}": ${r.active_workers} worker active`);

  /* ============================================================
     MISSION E CANONICAL POOL — hiện trạng (đã trống, xác nhận trước bootstrap)
     ============================================================ */
  await section("MISSION E CANONICAL POOL — hiện trạng (kỳ vọng: trống trước khi adopt)");
  const dwCodesCount = await client.query(`SELECT count(*)::int AS n FROM dw_codes`);
  const dwAssignmentsCount = await client.query(`SELECT count(*)::int AS n FROM dw_code_assignments`);
  const itAssignmentsCount = await client.query(`SELECT count(*)::int AS n FROM it_code_assignments`);
  console.log(`dw_codes (pool rows): ${dwCodesCount.rows[0].n}`);
  console.log(`dw_code_assignments (history rows): ${dwAssignmentsCount.rows[0].n}`);
  console.log(`it_code_assignments (history rows): ${itAssignmentsCount.rows[0].n}`);
  if (dwAssignmentsCount.rows[0].n > 0 || itAssignmentsCount.rows[0].n > 0) {
    console.log("ℹ️  Đã có lịch sử gán trong bảng canonical — điều này BÌNH THƯỜNG nếu đã có transfer/same-day-report chạy qua production kể từ khi Mission E deploy; script adoption phải xử lý các worker ĐÃ có active assignment như một trường hợp riêng (không gán đè).");
  }

  console.log("\n=== KẾT LUẬN ===");
  console.log("Đây là báo cáo CHỈ ĐỌC — không có thay đổi nào được thực hiện. Xem prepareOperationalCodeActivation() (src/lib/operational-code-activation.ts) để có kế hoạch dry-run adoption đầy đủ, có checksum, dựa trên đúng dữ liệu này.");
}

main()
  .catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end();
  });
