#!/usr/bin/env node
/**
 * PR1 — ORGANIZATION CANONICALIZATION & COVERAGE AUDIT (report-only, READ ONLY).
 *
 * Đo lường coverage thật của cầu nối departments.id <-> organization_units
 * (legacy_department_id) trước khi công bố `organization_units` là canonical
 * organization master cho tích hợp xuyên hệ thống. KHÔNG sửa bất kỳ dữ liệu nào
 * — toàn bộ truy vấn chạy trong `BEGIN READ ONLY` (mục XXV đề bài PR1).
 *
 * Cách chạy:  DATABASE_URL=postgres://... node scripts/audit-organization-mapping.mjs
 *
 * Output: console (người đọc) + artifacts/organization-mapping-audit.json (máy đọc,
 * gitignored — xem docs/ORGANIZATION_MAPPING_AUDIT.md).
 *
 * Exit code: 0 = sạch (đủ điều kiện canonical-ready theo mục XXVIII), 2 = phát
 * hiện vấn đề cần đối soát thủ công (KHÔNG tự sửa), 1 = script thất bại.
 */
import { config } from "dotenv";
import pg from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: ".env.local" });
config();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Thiếu DATABASE_URL (đặt trong .env.local hoặc biến môi trường).");
  process.exit(1);
}

// Khớp CHÍNH XÁC ORG_UNIT_CODE_PATTERN ở src/lib/organization-tree.ts — 2 nguồn
// PHẢI đồng bộ thủ công (không có cách chia sẻ regex giữa Postgres SQL và
// TypeScript trong 1 file .mjs độc lập không qua bundler).
const CODE_PATTERN_SQL = "^[a-z0-9]+(-[a-z0-9]+)*$";
const CODE_MAX_LENGTH = 64;

const client = new pg.Client({ connectionString: url });

/** In tối đa N dòng ra console, phần còn lại chỉ đếm — JSON output vẫn giữ đầy đủ. */
function printRows(label, rows, max = 20) {
  console.log(`\n[${rows.length === 0 ? "OK " : "!! "}] ${label}: ${rows.length} dòng`);
  for (const row of rows.slice(0, max)) console.log("    ", JSON.stringify(row));
  if (rows.length > max) console.log(`     ... và ${rows.length - max} dòng nữa (đầy đủ trong JSON output)`);
}

/**
 * Gợi ý ứng viên cho department chưa mapped, DỰA THUẦN TRÊN TÊN — SUGGESTION
 * ONLY (mục VIII/IX đề bài): KHÔNG BAO GIỜ ghi DB, KHÔNG BAO GIỜ tự chọn khi có
 * nhiều ứng viên (report AMBIGUOUS thay vì đoán). Chỉ so khớp case-insensitive
 * theo dept_name/group_name — không dùng similarity/trigram (không giả định
 * pg_trgm extension đã cài) để tránh false-confidence.
 */
function suggestCandidates(dept, unmappedCapableUnits) {
  const deptLabel = normalizeForCompare(`${dept.dept_name} ${dept.group_name ?? ""}`);
  const hits = unmappedCapableUnits.filter((u) => {
    const unitLabel = normalizeForCompare(u.name);
    return unitLabel.length > 0 && (deptLabel.includes(unitLabel) || unitLabel.includes(normalizeForCompare(dept.dept_name)));
  });
  return hits.map((u) => ({ organization_unit_id: u.id, code: u.code, name: u.name }));
}

function normalizeForCompare(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .trim();
}

async function main() {
  await client.connect();
  await client.query("BEGIN READ ONLY"); // toàn bộ script chạy trong 1 transaction chỉ-đọc — không có write path nào khả thi kể cả do lỗi lập trình.

  console.log("=".repeat(72));
  console.log("ORGANIZATION MAPPING COVERAGE AUDIT — report-only, READ ONLY, không sửa dữ liệu");
  console.log("Thời điểm:", new Date().toISOString());
  console.log("=".repeat(72));

  const generatedAt = new Date().toISOString();

  // ------------------------------------------------------------
  // 0. DB CONSTRAINTS THẬT ĐANG CHẠY — không assume Drizzle declaration = production
  //    constraint (mục XXIV đề bài): introspect trực tiếp catalog.
  // ------------------------------------------------------------
  const { rows: indexRows } = await client.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'organization_units'
       AND indexname IN ('org_units_code_uq', 'org_units_legacy_dept_uq')
     ORDER BY indexname`,
  );
  const { rows: fkRows } = await client.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'organization_units'::regclass AND contype = 'f'
     ORDER BY conname`,
  );
  const { rows: triggerRows } = await client.query(
    `SELECT tgname FROM pg_trigger
     WHERE tgrelid = 'organization_units'::regclass AND NOT tgisinternal
     ORDER BY tgname`,
  );

  const dbConstraints = {
    org_units_code_uq_present: indexRows.some((r) => r.indexname === "org_units_code_uq"),
    org_units_legacy_dept_uq_present: indexRows.some((r) => r.indexname === "org_units_legacy_dept_uq"),
    legacy_department_id_fk_present: fkRows.some((r) => r.def.includes("departments")),
    circular_parent_trigger_present: triggerRows.some((r) => r.tgname === "organization_units_no_cycle"),
    raw_indexes: indexRows,
    raw_foreign_keys: fkRows,
    raw_triggers: triggerRows.map((r) => r.tgname),
  };

  console.log("\n--- 0. DB CONSTRAINTS (verify migration SQL thật đang chạy trên DB này) ---");
  for (const [key, val] of Object.entries(dbConstraints)) {
    if (key.startsWith("raw_")) continue;
    console.log(`  ${val ? "OK " : "!! MISSING"}  ${key}`);
  }

  // ------------------------------------------------------------
  // 1-3. TOTALS
  // ------------------------------------------------------------
  const { rows: totalDeptRows } = await client.query("SELECT count(*)::int AS c FROM departments");
  const { rows: totalActiveDeptRows } = await client.query(
    "SELECT count(*)::int AS c FROM departments WHERE is_active AND deleted_at IS NULL",
  );
  const { rows: totalUnitRows } = await client.query("SELECT count(*)::int AS c FROM organization_units");
  const TOTAL_DEPARTMENTS = totalDeptRows[0].c;
  const TOTAL_ACTIVE_DEPARTMENTS = totalActiveDeptRows[0].c;
  const TOTAL_ORGANIZATION_UNITS = totalUnitRows[0].c;

  // ------------------------------------------------------------
  // 4-5. MAPPED / UNMAPPED DEPARTMENTS
  //    "mapped" theo ĐÚNG định nghĩa mục VII đề bài: đúng 1 organization_unit có
  //    legacy_department_id = departments.id — KHÔNG dùng name/location/division/
  //    section/group_name để tự khẳng định mapping.
  // ------------------------------------------------------------
  const { rows: unmappedDepartments } = await client.query(`
    SELECT d.id AS department_id, d.dept_name, d.group_name, d.location, d.division, d.section,
           d.is_active, d.deleted_at, d.created_at
    FROM departments d
    WHERE NOT EXISTS (SELECT 1 FROM organization_units ou WHERE ou.legacy_department_id = d.id)
    ORDER BY d.created_at DESC
  `);
  const MAPPED_DEPARTMENTS = TOTAL_DEPARTMENTS - unmappedDepartments.length;
  const unmappedActive = unmappedDepartments.filter((d) => d.is_active && !d.deleted_at);

  // ------------------------------------------------------------
  // 6. ORPHAN ORGANIZATION UNITS — node không có legacy bridge, KHÔNG PHẢI root.
  //    KHÔNG tự động coi đây là lỗi (unit tạo mới thuần trên cây là hợp lệ) —
  //    chỉ report để con người xem xét (mục VI đề bài).
  // ------------------------------------------------------------
  const { rows: orphanUnits } = await client.query(`
    SELECT id, code, name, unit_type, parent_id, path::text AS path, is_active, created_at
    FROM organization_units
    WHERE legacy_department_id IS NULL AND parent_id IS NOT NULL
    ORDER BY created_at DESC
  `);

  // ------------------------------------------------------------
  // 7. DUPLICATE LEGACY MAPPINGS — nên luôn = 0 nếu org_units_legacy_dept_uq
  //    đang hoạt động đúng; audit vẫn tự kiểm tra bằng dữ liệu thật, không suy
  //    diễn từ việc thấy index tồn tại (mục X đề bài).
  // ------------------------------------------------------------
  const { rows: duplicateLegacyMappings } = await client.query(`
    SELECT legacy_department_id, count(*)::int AS unit_count,
           array_agg(id ORDER BY created_at) AS unit_ids, array_agg(code ORDER BY created_at) AS codes
    FROM organization_units
    WHERE legacy_department_id IS NOT NULL
    GROUP BY legacy_department_id
    HAVING count(*) > 1
  `);

  // ------------------------------------------------------------
  // 8-9. STATUS DRIFT — active/inactive mismatch giữa 2 phía cầu nối (mục XXI).
  //    Migration set is_active nhất quán TẠI THỜI ĐIỂM backfill; sau đó 2 phía
  //    có thể bị đổi độc lập (deactivateOrganizationUnit/departments PATCH).
  // ------------------------------------------------------------
  const { rows: inactiveDepartmentMappings } = await client.query(`
    SELECT d.id AS department_id, d.dept_name, d.is_active AS department_is_active, d.deleted_at,
           ou.id AS organization_unit_id, ou.code, ou.is_active AS unit_is_active
    FROM departments d
    JOIN organization_units ou ON ou.legacy_department_id = d.id
    WHERE (d.is_active = false OR d.deleted_at IS NOT NULL) AND ou.is_active = true
  `);
  const { rows: inactiveOrgUnitMappings } = await client.query(`
    SELECT d.id AS department_id, d.dept_name, d.is_active AS department_is_active,
           ou.id AS organization_unit_id, ou.code, ou.is_active AS unit_is_active
    FROM departments d
    JOIN organization_units ou ON ou.legacy_department_id = d.id
    WHERE d.is_active = true AND d.deleted_at IS NULL AND ou.is_active = false
  `);

  // ------------------------------------------------------------
  // 10-11. CODE FORMAT + DUPLICATE CODES (kể cả giữa các dòng inactive — trước
  //    PR1, createOrganizationUnit() chỉ chặn trùng với dòng ACTIVE, xem
  //    src/lib/organization-units.ts — dữ liệu lịch sử có thể đã vi phạm).
  // ------------------------------------------------------------
  const { rows: invalidCodes } = await client.query(
    `SELECT id, code, name, is_active FROM organization_units
     WHERE code !~ $1 OR length(code) > $2
     ORDER BY created_at`,
    [CODE_PATTERN_SQL, CODE_MAX_LENGTH],
  );
  const { rows: duplicateCodes } = await client.query(`
    SELECT code, count(*)::int AS unit_count,
           array_agg(id ORDER BY created_at) AS unit_ids, array_agg(is_active ORDER BY created_at) AS active_flags
    FROM organization_units
    GROUP BY code
    HAVING count(*) > 1
  `);

  // ------------------------------------------------------------
  // HISTORICAL_MAPPING — department đã soft-delete nhưng vẫn mapped: ĐÚNG hành
  // vi mong muốn (mục XXII đề bài) — report riêng, KHÔNG coi là lỗi.
  // ------------------------------------------------------------
  const { rows: historicalMappings } = await client.query(`
    SELECT d.id AS department_id, d.dept_name, d.deleted_at, ou.id AS organization_unit_id, ou.code
    FROM departments d
    JOIN organization_units ou ON ou.legacy_department_id = d.id
    WHERE d.deleted_at IS NOT NULL
  `);

  // ------------------------------------------------------------
  // SUGGESTION ONLY — ứng viên theo tên cho department unmapped (mục VIII/IX).
  // Chỉ xét org_units CHƯA có legacy bridge (đã bridge rồi thì không phải ứng viên).
  // ------------------------------------------------------------
  const { rows: unboundUnits } = await client.query(`
    SELECT id, code, name FROM organization_units WHERE legacy_department_id IS NULL AND parent_id IS NOT NULL
  `);
  const unmappedWithSuggestions = unmappedDepartments.map((d) => {
    const candidates = suggestCandidates(d, unboundUnits);
    return {
      ...d,
      suggestion_only: true,
      candidates,
      ambiguous: candidates.length > 1,
    };
  });
  const ambiguousUnmapped = unmappedWithSuggestions.filter((d) => d.ambiguous);

  // ------------------------------------------------------------
  // REPORT
  // ------------------------------------------------------------
  console.log("\n--- 1-3. TOTALS ---");
  console.log(`  TOTAL_DEPARTMENTS               = ${TOTAL_DEPARTMENTS}`);
  console.log(`  TOTAL_ACTIVE_DEPARTMENTS         = ${TOTAL_ACTIVE_DEPARTMENTS}`);
  console.log(`  TOTAL_ORGANIZATION_UNITS         = ${TOTAL_ORGANIZATION_UNITS}`);
  console.log(`  MAPPED_DEPARTMENTS               = ${MAPPED_DEPARTMENTS} (${TOTAL_DEPARTMENTS ? ((MAPPED_DEPARTMENTS / TOTAL_DEPARTMENTS) * 100).toFixed(1) : "0.0"}%)`);

  console.log("\n--- 4-5. COVERAGE ---");
  printRows("UNMAPPED_DEPARTMENTS (tất cả — kèm suggestion, KHÔNG phải mapping tự động)", unmappedWithSuggestions);
  console.log(`      trong đó UNMAPPED nhưng ĐANG ACTIVE (ưu tiên xử lý): ${unmappedActive.length}`);
  printRows("  -> AMBIGUOUS (nhiều ứng viên theo tên — KHÔNG tự chọn)", ambiguousUnmapped);

  console.log("\n--- 6. ORPHAN_ORGANIZATION_UNITS (không có legacy bridge, không phải root) ---");
  printRows("ORPHAN_ORGANIZATION_UNITS", orphanUnits);

  console.log("\n--- 7. DUPLICATE_LEGACY_MAPPINGS (phải luôn = 0 nếu org_units_legacy_dept_uq hoạt động đúng) ---");
  printRows("DUPLICATE_LEGACY_MAPPINGS", duplicateLegacyMappings);

  console.log("\n--- 8-9. STATUS DRIFT ---");
  printRows("INACTIVE_DEPARTMENT_MAPPINGS (department inactive nhưng unit vẫn active)", inactiveDepartmentMappings);
  printRows("INACTIVE_ORG_UNIT_MAPPINGS (department active nhưng unit đã bị deactivate)", inactiveOrgUnitMappings);

  console.log("\n--- 10-11. CODE GOVERNANCE ---");
  printRows("INVALID_CODES (không khớp format hiện hành hoặc vượt 64 ký tự)", invalidCodes);
  printRows("DUPLICATE_CODES (kể cả giữa các dòng inactive)", duplicateCodes);

  console.log("\n--- HISTORICAL_MAPPING (department đã soft-delete nhưng vẫn resolve được — ĐÚNG hành vi mong muốn) ---");
  printRows("HISTORICAL_MAPPING", historicalMappings);

  const summary = {
    departments: TOTAL_DEPARTMENTS,
    active_departments: TOTAL_ACTIVE_DEPARTMENTS,
    organization_units: TOTAL_ORGANIZATION_UNITS,
    mapped: MAPPED_DEPARTMENTS,
    mapped_coverage_pct: TOTAL_DEPARTMENTS ? Number(((MAPPED_DEPARTMENTS / TOTAL_DEPARTMENTS) * 100).toFixed(2)) : null,
    unmapped: unmappedDepartments.length,
    unmapped_active: unmappedActive.length,
    orphans: orphanUnits.length,
    duplicate_legacy_mappings: duplicateLegacyMappings.length,
    invalid_codes: invalidCodes.length,
    duplicate_codes: duplicateCodes.length,
    status_mismatches: inactiveDepartmentMappings.length + inactiveOrgUnitMappings.length,
    ambiguous_unmapped: ambiguousUnmapped.length,
    historical_mappings: historicalMappings.length,
  };

  // Blocker thật (mục XXVIII: coverage KHÔNG phải chỉ số duy nhất) — những mục
  // này không thể là 0 "gần đúng", vi phạm dù chỉ 1 dòng cũng phải dừng lại.
  const hardBlockers =
    duplicateLegacyMappings.length > 0 ||
    duplicateCodes.length > 0 ||
    !dbConstraints.org_units_code_uq_present ||
    !dbConstraints.org_units_legacy_dept_uq_present;

  const totalIssues =
    unmappedDepartments.length +
    duplicateLegacyMappings.length +
    duplicateCodes.length +
    invalidCodes.length +
    inactiveDepartmentMappings.length +
    inactiveOrgUnitMappings.length;

  const report = {
    generated_at: generatedAt,
    db_constraints: dbConstraints,
    summary,
    unmapped_departments: unmappedWithSuggestions,
    orphan_units: orphanUnits,
    duplicate_mappings: duplicateLegacyMappings,
    invalid_codes: invalidCodes,
    duplicate_codes: duplicateCodes,
    status_mismatches: { inactive_department_mappings: inactiveDepartmentMappings, inactive_org_unit_mappings: inactiveOrgUnitMappings },
    historical_mappings: historicalMappings,
    hard_blockers_present: hardBlockers,
  };

  const outPath = fileURLToPath(new URL("../artifacts/organization-mapping-audit.json", import.meta.url));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("\n" + "=".repeat(72));
  console.log(`JSON report: ${outPath}`);
  if (hardBlockers) {
    console.log("KẾT LUẬN: BLOCKER — vi phạm bất biến DB (duplicate mapping/code, hoặc thiếu constraint). KHÔNG canonical-ready. KHÔNG tự sửa.");
  } else if (totalIssues === 0) {
    console.log("KẾT LUẬN: 100% department có đúng 1 organization_unit tương ứng, không phát hiện vấn đề nào.");
  } else {
    console.log(`KẾT LUẬN: phát hiện ${totalIssues} dòng cần đối soát (không phải hard blocker). KHÔNG tự sửa — đối soát thủ công theo docs/ORGANIZATION_MAPPING_AUDIT.md.`);
  }

  await client.query("ROLLBACK"); // luôn rollback transaction READ ONLY — không có gì để commit.
  await client.end();
  process.exit(hardBlockers || totalIssues > 0 ? 2 : 0);
}

main().catch(async (e) => {
  console.error("Audit thất bại:", e.message);
  try {
    await client.query("ROLLBACK");
    await client.end();
  } catch {
    /* đã mất kết nối — bỏ qua */
  }
  process.exit(1);
});
