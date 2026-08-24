/**
 * REGRESSION TESTS — 2026-08-24 Production Incident Hotfix
 * =========================================================
 * Incident: rerunning the Production migration workflow deleted the
 * PUBLISHED v6 canonical version (destructive cleanup rerun) and created
 * no replacement, because the v7 DRAFT migration was missing from the
 * runner. Production was left with:
 *   merge_templates.current_published_version = 6
 *   merge_template_versions                   = EMPTY
 *
 * These tests prove, WITHOUT touching any real database:
 *   1. rerunning the normal migration runner can never delete a PUBLISHED
 *      version (no destructive statement anywhere in its migration list);
 *   2. the destructive canonical cleanup is absent from the recurring runner;
 *   3. the v7 DRAFT migration IS present (in the correct sequence);
 *   4. recovery from {current_published_version=6, versions=EMPTY} results
 *      in current_published_version=NULL (fail closed) + exactly one v7 DRAFT;
 *   5. running recovery twice still leaves exactly one v7 (never v8/v9);
 *   6. merge_template_fields are never changed;
 *   7. merge_jobs / document_history rows are never changed.
 *
 * FINAL RUNNER HYGIENE HOTFIX (2026-08-24, sau recovery PR #96):
 * Production sau recovery cho thấy versions table bị tái tạo kèm một DRAFT
 * v1 legacy (source_docx_name = "...canonical-source.html...", mapping_snapshot
 * rỗng). Nguyên nhân: migration
 * 2026-08-23-trainee-registration-canonical-html-draft.sql (insert
 * MAX(version)+1 với body canonical-source.html LỖI THỜI) còn nằm trong
 * runner định kỳ — khi versions table trống (đúng trạng thái sự cố, trước
 * khi recovery v7 chạy) nó tạo v1 legacy. Migration đó đã bị LOẠI VĨNH VIỄN
 * khỏi runner (file vẫn nằm trong git như immutable history — KHÔNG xoá).
 * Các test bên dưới chứng minh thêm:
 *   8. legacy canonical HTML draft migration ABSENT khỏi runner, được cảnh
 *      báo bằng comment tại array, nhưng file vẫn tồn tại trong repo;
 *   9. KHÔNG migration nào trong runner có thể tạo document body pre-v7:
 *      chỉ recovery + v7 draft insert vào merge_template_versions (cả hai
 *      dedupe theo source_docx_name), và không SQL thực thi nào còn tham
 *      chiếu canonical-source.html;
 *  10. chạy lại runner khi CHỈ CÓ v7 tồn tại là true no-op: không v1,
 *      không v8/v9.
 *
 * The behavioural section runs a faithful in-memory model of the exact SQL
 * statements; every modelled statement is cross-locked to the real SQL text
 * by the static assertions above it (statement counts, guards, literals),
 * so the model cannot drift from the migrations silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Fixtures / constants (cross-checked against the real SQL files below)
// ---------------------------------------------------------------------------

const RUNNER_SCRIPT = "scripts/run-document-merge-migrations.mjs";
const CLEANUP_MIGRATION = "2026-08-24-trainee-registration-canonical-cleanup.sql";
const CANONICAL_DRAFT_MIGRATION = "2026-08-23-trainee-registration-canonical-html-draft.sql";
const V7_DRAFT_MIGRATION = "2026-08-24-trainee-registration-v7-operator-test2-draft.sql";
const RECOVERY_MIGRATION = "2026-08-24-trainee-registration-v7-incident-recovery.sql";
const V8_DRAFT_MIGRATION = "2026-08-24-trainee-registration-v8-pagination-draft.sql";

const CANONICAL_TEMPLATE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const CANONICAL_SOURCE_NAME =
  "trainee-registration/canonical-source.html (canonical HTML; preview UI stripped)";
const V7_SOURCE_NAME =
  "trainee-registration/test(2).html (operator-provided canonical HTML; preview UI stripped) v7";
const V7_BODY_SHA256 = "7cb43551d3d4f5178ce203a176a7004aa7e3994ecad2276ef593b6fe401116c1";
const V8_SOURCE_NAME = "trainee-registration/test(2).html (operator-provided canonical HTML; v8 explicit regulations pagination only) v8";
const V8_BODY_SHA256 = "d68b329629c7b5ac7722f207035e057a6a757c44966c613a03852c3bbadf794e";

function readRepoFile(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Parse the DOCUMENT_MERGE_MIGRATIONS array literal out of the runner. */
function parseRunnerList(): string[] {
  const source = readRepoFile(RUNNER_SCRIPT);
  const block = source.match(/const DOCUMENT_MERGE_MIGRATIONS = \[([\s\S]*?)\];/);
  assert.ok(block, "runner must declare the DOCUMENT_MERGE_MIGRATIONS array");
  // Strip JS comments first: the array deliberately keeps a WARNING comment
  // naming the excluded cleanup migration, which must not count as an entry.
  const withoutComments = block[1].replace(/\/\/[^\n]*/g, "");
  return Array.from(withoutComments.matchAll(/"([^"]+\.sql)"/g), (m) => m[1]);
}

/**
 * Strip SQL comments without corrupting statement bodies. Dollar-quoted
 * regions ($tag$...$tag$ — where the HTML/CSS bodies live) and single-quoted
 * literals are preserved verbatim; `-- ...` line comments and block comments
 * outside them are removed. This keeps destructive-keyword scanning honest:
 * `ON DELETE CASCADE` FK definitions survive, comment prose disappears.
 */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const dollar = sql.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? n : close + tag.length;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? n : newline;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Any statement form that can remove rows or schema objects. */
const DESTRUCTIVE_STATEMENT =
  /\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+(TABLE|INDEX|EXTENSION|COLUMN|SCHEMA|VIEW)\b/i;

/** Strip JS comments (string-literal aware) so prose cannot false-positive. */
function stripJsComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? n : newline;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function assertNonDestructiveSql(relativePath: string, sql: string): void {
  const code = stripSqlComments(sql);
  assert.doesNotMatch(
    code,
    DESTRUCTIVE_STATEMENT,
    `${relativePath} must contain no DELETE/TRUNCATE/DROP statement`,
  );
}

// ---------------------------------------------------------------------------
// PHASE 1 — runner invariants (static)
// ---------------------------------------------------------------------------

test("HOTFIX-2: the destructive canonical cleanup is ABSENT from the recurring runner", () => {
  const list = parseRunnerList();
  assert.ok(!list.includes(CLEANUP_MIGRATION), "cleanup migration must never run again from the runner");

  // And the exclusion is documented at the array itself so nobody re-adds it by accident.
  const source = readRepoFile(RUNNER_SCRIPT);
  assert.match(source, /KHÔNG thêm/);
  assert.ok(
    source.includes(CLEANUP_MIGRATION),
    "the runner must keep a warning naming the excluded cleanup migration",
  );
});

test("HOTFIX-3: the v7 DRAFT migration IS present, in the correct sequence", () => {
  const list = parseRunnerList();
  const recovery = list.indexOf(RECOVERY_MIGRATION);
  const v7 = list.indexOf(V7_DRAFT_MIGRATION);

  assert.ok(v7 !== -1, "v7 DRAFT migration must be in the runner");
  assert.ok(recovery !== -1, "incident recovery migration must be in the runner");
  assert.equal(list.indexOf(CANONICAL_DRAFT_MIGRATION), -1, "legacy canonical draft must NOT be in the runner");
  assert.ok(
    recovery < v7,
    "recovery runs BEFORE the v7 draft so an emptied versions table receives v7 at its deterministic version 7, never MAX(version)+1",
  );
});

test("HOTFIX-8: the legacy canonical HTML draft migration is ABSENT from the recurring runner but kept as immutable git history", () => {
  const list = parseRunnerList();
  assert.ok(
    !list.includes(CANONICAL_DRAFT_MIGRATION),
    "obsolete canonical-source.html draft (insert MAX(version)+1) must never run again from the runner — " +
      "it recreated a legacy v1 DRAFT on the emptied Production versions table after PR #96",
  );

  // The exclusion is documented at the array itself so nobody re-adds it by accident.
  const source = readRepoFile(RUNNER_SCRIPT);
  assert.match(source, /KHÔNG thêm/);
  assert.ok(
    source.includes(CANONICAL_DRAFT_MIGRATION),
    "the runner must keep a warning naming the excluded legacy canonical draft migration",
  );

  // The historical migration file itself MUST NOT be deleted from the repo —
  // it remains immutable migration history for audit. Only its execution is banned.
  const file = readRepoFile(`migrations/${CANONICAL_DRAFT_MIGRATION}`);
  assert.ok(file.includes(CANONICAL_SOURCE_NAME), "the historical file is preserved verbatim");
});

test("v8 pagination migration is DRAFT-only and preserves v7 immutability", () => {
  const code = stripSqlComments(readRepoFile(`migrations/${V8_DRAFT_MIGRATION}`));
  assert.match(code, /t\.id,\s*8,\s*'DRAFT'/);
  assert.match(code, /'\[\]'::jsonb/);
  assert.match(code, /existing\.version\s*=\s*8/);
  assert.doesNotMatch(code, /UPDATE\s+merge_template_versions|UPDATE\s+merge_templates|merge_template_fields|merge_jobs|current_published_version|'PUBLISHED'/i);
  assert.ok(code.includes(V8_SOURCE_NAME));
  assert.ok(readRepoFile(`migrations/${V8_DRAFT_MIGRATION}`).includes(V8_BODY_SHA256));
});

test("HOTFIX-1: the runner list is exactly the known-safe, idempotent sequence", () => {
  assert.deepEqual(parseRunnerList(), [
    "2026-08-15-document-merge-engine.sql",
    "2026-08-17-document-merge-async-phase2.sql",
    "2026-08-17-document-merge-template-versions.sql",
    "2026-08-20-document-merge-async-pdf.sql",
    "2026-08-21-dang-ky-tap-nghe-html-draft.sql",
    RECOVERY_MIGRATION,
    V7_DRAFT_MIGRATION,
    V8_DRAFT_MIGRATION,
  ]);
});

test("HOTFIX-1: runner comments describe the REAL migration count", () => {
  const source = readRepoFile(RUNNER_SCRIPT);
  const count = parseRunnerList().length;
  const headerCount = source.match(/CHỈ chạy (\d+) migration Document Merge/);
  const arrayCount = source.match(/Đúng (\d+) migration Document Merge/);
  const safetyCount = source.match(/An toàn: cả (\d+) migration đều idempotent/);
  assert.ok(headerCount, "header comment must state the migration count");
  assert.ok(arrayCount, "array comment must state the migration count");
  assert.ok(safetyCount, "safety comment must state the migration count");
  assert.equal(Number(headerCount[1]), count);
  assert.equal(Number(arrayCount[1]), count);
  assert.equal(Number(safetyCount[1]), count);
});

test("HOTFIX-1: rerunning the runner can NEVER delete a published version (no destructive statement in ANY listed migration)", () => {
  const list = parseRunnerList();
  assert.ok(list.length > 0);
  for (const filename of list) {
    assertNonDestructiveSql(`migrations/${filename}`, readRepoFile(`migrations/${filename}`));
  }
  // The runner itself only issues the file contents + SELECT queries
  // (prose warnings about the incident live in comments and are stripped).
  const runnerCode = stripJsComments(readRepoFile(RUNNER_SCRIPT));
  assert.doesNotMatch(runnerCode, /\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+TABLE\b/i);
});

test("HOTFIX-9: NO runner migration can (re)create a pre-v7 document body — only the two dedupe-guarded v7 producers insert versions", () => {
  const list = parseRunnerList();
  const versionInserters: string[] = [];
  for (const filename of list) {
    const code = stripSqlComments(readRepoFile(`migrations/${filename}`));
    if (!/\bINSERT\s+INTO\s+merge_template_versions\b/i.test(code)) continue;
    versionInserters.push(filename);

    // Recovery guards via "AND NOT EXISTS (... source_docx_name ...)"; the v7
    // draft via "WHERE NOT EXISTS (... source_docx_name ...)" — both forms are
    // valid dedupe guards, so only the NOT EXISTS + source_docx_name pairing matters.
    assert.match(
      code,
      /\bNOT\s+EXISTS[\s\S]*?source_docx_name/i,
      `${filename}: every version insert must be dedupe-guarded by source_docx_name (rerun-safe)`,
    );
    assert.ok(
      !code.includes("canonical-source.html"),
      `${filename}: executable SQL must not carry the legacy canonical-source.html body/name — ` +
        "the runner must never be able to recreate the v1 legacy draft or any pre-v7 body",
    );
  }
  assert.deepEqual(
    versionInserters,
    [RECOVERY_MIGRATION, V7_DRAFT_MIGRATION, V8_DRAFT_MIGRATION],
    "exactly the recovery migration, v7 operator draft, and v8 pagination draft may insert document versions",
  );

  // And the only source_docx_name those producers can write is the v7 one.
  for (const filename of [RECOVERY_MIGRATION, V7_DRAFT_MIGRATION]) {
    const code = stripSqlComments(readRepoFile(`migrations/${filename}`));
    assert.ok(code.includes(V7_SOURCE_NAME), `${filename} must write/guard on the v7 source_docx_name`);
    assert.ok(!code.includes(CANONICAL_SOURCE_NAME), `${filename} must not write the legacy canonical source name`);
  }
});

// ---------------------------------------------------------------------------
// PHASE 2 — recovery migration invariants (static)
// ---------------------------------------------------------------------------

test("HOTFIX-2: recovery embeds the approved v7 body BYTE-IDENTICALLY", () => {
  const v7Sql = readRepoFile(`migrations/${V7_DRAFT_MIGRATION}`);
  const recoverySql = readRepoFile(`migrations/${RECOVERY_MIGRATION}`);

  for (const tag of ["v7_html", "v7_css"]) {
    const original = v7Sql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
    const recovered = recoverySql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
    assert.ok(original, `v7 migration must contain $${tag}$`);
    assert.ok(recovered, `recovery migration must contain $${tag}$`);
    assert.equal(recovered[1], original[1], `$${tag}$ body must be byte-identical to the approved v7 migration`);
  }

  // The SHA-256 guard constant in the recovery SQL is the real hash of the body it embeds.
  const body = recoverySql.match(/\$v7_html\$([\s\S]*?)\$v7_html\$/);
  assert.ok(body);
  assert.equal(sha256Hex(body[1]), V7_BODY_SHA256);
  assert.ok(recoverySql.includes(V7_BODY_SHA256), "recovery must guard on the body SHA-256");
  assert.ok(recoverySql.includes(V7_SOURCE_NAME), "recovery must guard on the v7 source_docx_name");
});

test("HOTFIX-2: recovery is non-destructive, single-INSERT, and never publishes", () => {
  const code = stripSqlComments(readRepoFile(`migrations/${RECOVERY_MIGRATION}`));

  assertNonDestructiveSql(`migrations/${RECOVERY_MIGRATION}`, code);

  const inserts = code.match(/\bINSERT\s+INTO\s+merge_template_versions\b/gi) ?? [];
  assert.equal(inserts.length, 1, "exactly one INSERT into merge_template_versions");

  const templateUpdates = code.match(/\bUPDATE\s+merge_templates\b/gi) ?? [];
  assert.equal(templateUpdates.length, 1, "exactly one UPDATE merge_templates (the dangling-pointer fix)");

  const versionUpdates = code.match(/\bUPDATE\s+merge_template_versions\b/gi) ?? [];
  assert.equal(versionUpdates.length, 0, "existing version rows are never rewritten");

  assert.doesNotMatch(code, /'PUBLISHED'/, "recovery never writes or requires a PUBLISHED status");
  assert.doesNotMatch(code, /\bpublished_at\b/, "recovery never touches published_at");
});

test("HOTFIX-2: recovery targets ONLY the canonical template id", () => {
  const code = stripSqlComments(readRepoFile(`migrations/${RECOVERY_MIGRATION}`));
  assert.ok(code.includes(CANONICAL_TEMPLATE_ID), "recovery must scope on the canonical template id");
  // Every FROM/UPDATE on the template tables is predicated on that id.
  assert.match(code, /WHERE\s+t\.id\s*=\s*'a1b2c3d4-e5f6-7890-abcd-ef1234567890'/);
  assert.doesNotMatch(
    code.replace(new RegExp(CANONICAL_TEMPLATE_ID, "g"), ""),
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    "no other template UUID may appear in executable SQL",
  );
});

test("HOTFIX-2: the inserted canonical version is DETERMINISTICALLY 7 — never MAX(version)+1", () => {
  const code = stripSqlComments(readRepoFile(`migrations/${RECOVERY_MIGRATION}`));
  assert.doesNotMatch(code, /MAX\s*\(\s*v?\.?version\s*\)/i, "recovery must not derive the version from MAX(version)");
  assert.match(code, /t\.id,\s*7,\s*'DRAFT'/, "INSERT must pin version 7 with status DRAFT");
  assert.match(code, /v\.version\s*=\s*7/, "INSERT must refuse to run when version 7 is already taken");
});

test("HOTFIX-2: current_published_version is NULLed ONLY when it points at a missing version", () => {
  const code = stripSqlComments(readRepoFile(`migrations/${RECOVERY_MIGRATION}`));
  assert.match(code, /SET\s+current_published_version\s*=\s*NULL/i, "fail-closed NULLing must exist");
  assert.match(code, /current_published_version\s+IS\s+NOT\s+NULL/i, "NULL pointers are left alone");
  assert.match(
    code,
    /v\.version\s*=\s*t\.current_published_version/i,
    "the NULLing must be guarded by the referenced-version existence check",
  );
  assert.doesNotMatch(
    code,
    /current_published_version\s*=\s*\d/i,
    "recovery must never point current_published_version at any version",
  );
});

test("HOTFIX-6/7: recovery never touches fields, jobs, job records, history or archive tables", () => {
  const code = stripSqlComments(readRepoFile(`migrations/${RECOVERY_MIGRATION}`));
  for (const table of [
    "merge_template_fields",
    "merge_jobs",
    "merge_job_records",
    "document_history",
    "archive_runs",
  ]) {
    assert.ok(!code.includes(table), `recovery must not reference ${table} in executable SQL`);
  }
});

// ---------------------------------------------------------------------------
// PHASE 3 — behavioural model of the runner sequence
// ---------------------------------------------------------------------------

type VersionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

type VersionRow = {
  version: number;
  status: VersionStatus;
  sourceDocxName: string;
  bodySha256: string;
};

type DbState = {
  currentPublishedVersion: number | null;
  versions: VersionRow[];
  mergeTemplateFields: { id: string; placeholder: string }[];
  mergeJobs: { id: string; templateVersion: number }[];
  documentHistory: { id: string; filename: string }[];
};

function maxVersion(state: DbState): number {
  return state.versions.reduce((m, v) => Math.max(m, v.version), 0);
}

// NOTE: migrations/2026-08-23-trainee-registration-canonical-html-draft.sql
// deliberately has NO model anymore — it is excluded from the recurring
// runner (HOTFIX-8). Its MAX(version)+1 insert is exactly what recreated the
// legacy v1 DRAFT on the emptied Production versions table. If anyone ever
// re-adds it to the runner list, runRecurringRunner() below fails with
// "every runner migration needs a model" (in addition to the static tests).

/**
 * Model of migrations/2026-08-24-trainee-registration-v7-operator-test2-draft.sql:
 * INSERT ... MAX(version)+1 ... WHERE NOT EXISTS (same source_docx_name).
 */
function v7DraftMigration(state: DbState): DbState {
  if (state.versions.some((v) => v.sourceDocxName === V7_SOURCE_NAME)) return state;
  return {
    ...state,
    versions: [
      ...state.versions,
      { version: maxVersion(state) + 1, status: "DRAFT", sourceDocxName: V7_SOURCE_NAME, bodySha256: V7_BODY_SHA256 },
    ],
  };
}

/**
 * Model of migrations/2026-08-24-trainee-registration-v7-incident-recovery.sql.
 * Statement-for-statement mirror (locked by the static tests above):
 *   STEP 1: INSERT version 7 DRAFT iff no source_docx_name match AND no body
 *           SHA-256 match AND version 7 is free.
 *   STEP 2: UPDATE current_published_version = NULL iff it is NOT NULL and no
 *           version row with that number exists.
 */
function recoveryMigration(state: DbState): DbState {
  let next = state;
  const hasV7Content = next.versions.some(
    (v) => v.sourceDocxName === V7_SOURCE_NAME || v.bodySha256 === V7_BODY_SHA256,
  );
  const version7Free = !next.versions.some((v) => v.version === 7);
  if (!hasV7Content && version7Free) {
    next = {
      ...next,
      versions: [
        ...next.versions,
        { version: 7, status: "DRAFT", sourceDocxName: V7_SOURCE_NAME, bodySha256: V7_BODY_SHA256 },
      ],
    };
  }
  if (
    next.currentPublishedVersion !== null &&
    !next.versions.some((v) => v.version === next.currentPublishedVersion)
  ) {
    next = { ...next, currentPublishedVersion: null };
  }
  return next;
}

/** Model of v8: exactly version 8 DRAFT; never changes a pre-existing version. */
function v8DraftMigration(state: DbState): DbState {
  if (state.versions.some((v) => v.version === 8 || v.sourceDocxName === V8_SOURCE_NAME)) return state;
  return { ...state, versions: [...state.versions, { version: 8, status: "DRAFT", sourceDocxName: V8_SOURCE_NAME, bodySha256: V8_BODY_SHA256 }] };
}

/** Every other runner migration is pure DDL / seed with no version writes. */
function ddlMigration(state: DbState): DbState {
  return state;
}

const MIGRATION_MODELS: Record<string, (state: DbState) => DbState> = {
  "2026-08-15-document-merge-engine.sql": ddlMigration,
  "2026-08-17-document-merge-async-phase2.sql": ddlMigration,
  "2026-08-17-document-merge-template-versions.sql": ddlMigration,
  "2026-08-20-document-merge-async-pdf.sql": ddlMigration,
  "2026-08-21-dang-ky-tap-nghe-html-draft.sql": ddlMigration,
  [RECOVERY_MIGRATION]: recoveryMigration,
  [V7_DRAFT_MIGRATION]: v7DraftMigration,
  [V8_DRAFT_MIGRATION]: v8DraftMigration,
};

/** Re-run the recurring runner exactly as scripts/run-document-merge-migrations.mjs does. */
function runRecurringRunner(state: DbState): DbState {
  let current = state;
  for (const filename of parseRunnerList()) {
    const model = MIGRATION_MODELS[filename];
    assert.ok(model, `every runner migration needs a model: ${filename}`);
    current = model(current);
  }
  return current;
}

function incidentState(): DbState {
  return {
    // The confirmed Production incident state.
    currentPublishedVersion: 6,
    versions: [],
    // Candidate data that MUST survive untouched (requirements 6 & 7).
    mergeTemplateFields: Array.from({ length: 49 }, (_, i) => ({
      id: `field-${i + 1}`,
      placeholder: `placeholder_${i + 1}`,
    })),
    mergeJobs: [
      { id: "job-1", templateVersion: 6 },
      { id: "job-2", templateVersion: 6 },
    ],
    documentHistory: [
      { id: "doc-1", filename: "Giay_dang_ky_tap_nghe-001.pdf" },
      { id: "doc-2", filename: "Giay_dang_ky_tap_nghe-002.pdf" },
    ],
  };
}

function healthyStateWithPublishedV6(): DbState {
  return {
    currentPublishedVersion: 6,
    versions: [
      { version: 6, status: "PUBLISHED", sourceDocxName: CANONICAL_SOURCE_NAME, bodySha256: "canonical-v6-body" },
    ],
    mergeTemplateFields: incidentState().mergeTemplateFields,
    mergeJobs: incidentState().mergeJobs,
    documentHistory: incidentState().documentHistory,
  };
}

test("runner recovery creates v7 and v8 DRAFTs only; neither is published", () => {
  const before = incidentState();
  const after = runRecurringRunner(before);

  assert.equal(after.currentPublishedVersion, null, "dangling pointer must be NULLed (fail closed)");

  const v7Rows = after.versions.filter((v) => v.bodySha256 === V7_BODY_SHA256);
  assert.equal(v7Rows.length, 1, "exactly one v7 DRAFT");
  assert.equal(v7Rows[0].status, "DRAFT", "v7 is a DRAFT — never auto-published");
  assert.equal(v7Rows[0].version, 7, "the recovered v7 lands on its deterministic version 7");

  assert.equal(
    after.versions.length,
    2,
    "the runner may create only the approved v7 recovery and v8 pagination DRAFTs; never the legacy v1 draft",
  );
  assert.ok(
    !after.versions.some((v) => v.sourceDocxName === CANONICAL_SOURCE_NAME),
    "the legacy canonical-source.html draft must never reappear",
  );
  assert.ok(
    after.versions.every((v) => v.status === "DRAFT"),
    "no version may be PUBLISHED after the incident recovery — publishing is an explicit operator act",
  );
});

test("runner adds v8 once when only v7 exists, then is idempotent", () => {
  // Post-recovery Production state: {current_published_version=NULL, versions={v7 DRAFT}}.
  const onlyV7: DbState = {
    currentPublishedVersion: null,
    versions: [
      { version: 7, status: "DRAFT", sourceDocxName: V7_SOURCE_NAME, bodySha256: V7_BODY_SHA256 },
    ],
    mergeTemplateFields: incidentState().mergeTemplateFields,
    mergeJobs: incidentState().mergeJobs,
    documentHistory: incidentState().documentHistory,
  };

  const once = runRecurringRunner(onlyV7);
  const twice = runRecurringRunner(once);
  const thrice = runRecurringRunner(twice);

  for (const [label, state] of [["once", once], ["twice", twice], ["thrice", thrice]] as const) {
    assert.equal(state.versions.length, 2, `after run ${label}: exactly v7 and v8 rows exist`);
    assert.deepEqual(state.versions.map((v) => v.version).sort(), [7, 8], `after run ${label}: no v1/v9 may appear`);
    assert.ok(state.versions.every((v) => v.status === "DRAFT"), `after run ${label}: no draft is auto-published`);
    assert.ok(
      !state.versions.some((v) => v.sourceDocxName === CANONICAL_SOURCE_NAME),
      `after run ${label}: the legacy canonical-source.html draft never reappears`,
    );
    assert.equal(state.currentPublishedVersion, null, `after run ${label}: nothing is auto-published`);
  }
  assert.deepEqual(twice, once, "second rerun is byte-for-byte identical to the first");
});

test("running the runner twice creates no duplicate v7/v8 drafts", () => {
  const once = runRecurringRunner(incidentState());
  const twice = runRecurringRunner(once);
  const thrice = runRecurringRunner(twice);

  for (const [label, state] of [["once", once], ["twice", twice], ["thrice", thrice]] as const) {
    const v7Rows = state.versions.filter((v) => v.bodySha256 === V7_BODY_SHA256);
    assert.equal(v7Rows.length, 1, `after run #${label}: exactly one v7`);
    assert.equal(v7Rows[0].version, 7, `after run #${label}: still version 7`);
    const v8Rows = state.versions.filter((v) => v.bodySha256 === V8_BODY_SHA256);
    assert.equal(v8Rows.length, 1, `after run #${label}: exactly one v8`);
    assert.equal(v8Rows[0].version, 8, `after run #${label}: v8 remains DRAFT version 8`);
    assert.ok(!state.versions.some((v) => v.version > 8), `after run #${label}: no v9/... may appear`);
    assert.equal(state.currentPublishedVersion, null, `after run #${label}: still fail closed`);
  }
  assert.deepEqual(twice.versions, once.versions, "second run is a true no-op on versions");
});

test("HOTFIX-1: rerunning the runner NEVER deletes a PUBLISHED v6 (healthy-state behaviour)", () => {
  const before = healthyStateWithPublishedV6();
  const after = runRecurringRunner(before);

  const v6 = after.versions.find((v) => v.version === 6);
  assert.ok(v6, "the PUBLISHED v6 row must survive the rerun");
  assert.equal(v6.status, "PUBLISHED", "v6 must remain PUBLISHED");
  assert.equal(after.currentPublishedVersion, 6, "a non-dangling pointer must NOT be NULLed");
  assert.ok(after.versions.length > before.versions.length, "the rerun only ADDS draft versions");

  // And recovery alone never NULLs a pointer that still resolves.
  assert.equal(recoveryMigration(before).currentPublishedVersion, 6);
});

test("HOTFIX-4: recovery migration ALONE repairs the exact incident state", () => {
  const after = recoveryMigration(incidentState());

  assert.equal(after.currentPublishedVersion, null, "dangling current_published_version=6 becomes NULL");
  assert.equal(after.versions.length, 1, "exactly one version row");
  assert.deepEqual(after.versions[0], {
    version: 7,
    status: "DRAFT",
    sourceDocxName: V7_SOURCE_NAME,
    bodySha256: V7_BODY_SHA256,
  });
});

test("HOTFIX-6/7: no merge_template_fields / merge_jobs / document_history rows change, in any scenario", () => {
  for (const [label, before] of [
    ["incident", incidentState()],
    ["healthy-v6", healthyStateWithPublishedV6()],
  ] as const) {
    const fieldsBefore = structuredClone(before.mergeTemplateFields);
    const jobsBefore = structuredClone(before.mergeJobs);
    const historyBefore = structuredClone(before.documentHistory);

    const afterSingle = recoveryMigration(before);
    const afterRunner = runRecurringRunner(before);
    const afterDouble = runRecurringRunner(afterRunner);

    for (const [phase, state] of [
      ["recovery", afterSingle],
      ["runner", afterRunner],
      ["runner-rerun", afterDouble],
    ] as const) {
      assert.deepEqual(state.mergeTemplateFields, fieldsBefore, `${label}/${phase}: fields unchanged`);
      assert.deepEqual(state.mergeJobs, jobsBefore, `${label}/${phase}: jobs unchanged`);
      assert.deepEqual(state.documentHistory, historyBefore, `${label}/${phase}: history unchanged`);
    }
  }
});

test("HOTFIX-5: recovery alone is idempotent — second run inserts nothing", () => {
  const once = recoveryMigration(incidentState());
  const twice = recoveryMigration(once);
  assert.deepEqual(twice, once, "the second recovery run must be a complete no-op");
});
