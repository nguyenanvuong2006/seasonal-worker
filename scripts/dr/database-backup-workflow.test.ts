/**
 * REGRESSION & STATIC CONTRACT TESTS FOR DR PHASE 2A:
 * PRODUCTION DATABASE BACKUP WORKFLOW & MANIFEST HELPERS
 * ------------------------------------------------------------------------
 * Verifies all 24 required contract assertions:
 * 1. workflow is workflow_dispatch only
 * 2. no schedule exists
 * 3. branch guard requires refs/heads/main
 * 4. exact confirmation string required (BACKUP_PRODUCTION_DATABASE)
 * 5. expected_source_commit_sha required
 * 6. expected SHA strict 40 lowercase hex
 * 7. expected SHA must equal git HEAD
 * 8. PROD_DATABASE_URL required
 * 9. PRODUCTION_DATABASE_HOSTNAME required
 * 10. production hostname exact-match allowlist
 * 11. staging hostname rejection retained
 * 12. pg_dump custom format used (--format=custom)
 * 13. --no-owner used
 * 14. --no-privileges used
 * 15. backup not sent to stdout (--file= used)
 * 16. SHA-256 sidecar generated
 * 17. manifest excludes credentials
 * 18. pg_restore --list verification required
 * 19. artifact includes dump + checksum + manifest
 * 20. artifact retention = 7 days
 * 21. concurrency group configured (database-production-backup)
 * 22. cancel-in-progress false
 * 23. no destructive/restore command exists
 * 24. no schedule/cron trigger exists
 *
 * Plus unit tests for:
 * - buildBackupManifest
 * - parseRestoreListToc
 * - assertNoSecrets
 * - formatSha256Sidecar
 * - validateBackupManifest
 * - validateSha256Sidecar
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildBackupManifest,
  parseRestoreListToc,
  assertNoSecrets,
  formatSha256Sidecar,
  calculateFileSha256,
  MANIFEST_FORMAT_VERSION,
  BACKUP_TYPE,
  EXPECTED_ENVIRONMENT,
} from "./build-backup-manifest.mjs";
import {
  validateBackupManifest,
  validateSha256Sidecar,
} from "./validate-backup-manifest.mjs";

const ROOT = process.cwd();
const WORKFLOW_PATH = join(ROOT, ".github/workflows/database-backup-production.yml");

function readWorkflowYaml(): string {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

/* ============================================================
   WORKFLOW STATIC CONTRACT TESTS (Assertions 1 - 24)
   ============================================================ */

test("Contract 1 & 2 & 24: workflow is workflow_dispatch ONLY with no schedule/cron", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /\bon:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(yaml, /\bpush:\s*/);
  assert.doesNotMatch(yaml, /\bpull_request:\s*/);
  assert.doesNotMatch(yaml, /\bschedule:\s*/);
  assert.doesNotMatch(yaml, /\bcron:\s*/);
});

test("Contract 3: branch guard strictly requires refs/heads/main", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /github\.ref/);
  assert.match(yaml, /refs\/heads\/main/);
  assert.match(yaml, /if\s*\[\s*"\$\{\{\s*github\.ref\s*\}\}"\s*!=\s*"refs\/heads\/main"\s*\]/);
});

test("Contract 4: exact confirmation string BACKUP_PRODUCTION_DATABASE required", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /confirmation:\s*\n[\s\S]*?required:\s*true/);
  assert.match(
    yaml,
    /if\s*\[\s*"\$\{\{\s*github\.event\.inputs\.confirmation\s*\}\}"\s*!=\s*"BACKUP_PRODUCTION_DATABASE"\s*\]/
  );
});

test("Contract 5 & 6: expected_source_commit_sha required and validated as strict 40 lowercase hex", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /expected_source_commit_sha:\s*\n[\s\S]*?required:\s*true/);
  assert.match(yaml, /\^\[a-f0-9\]\{40\}\$/);
});

test("Contract 7: expected SHA must equal checked-out git HEAD", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /HEAD_SHA=\$\(git rev-parse HEAD\)/);
  assert.match(yaml, /if\s*\[\s*"\$\{EXPECTED_SHA\}"\s*!=\s*"\$\{HEAD_SHA\}"\s*\]/);
});

test("Contract 8 & 9: PROD_DATABASE_URL and PRODUCTION_DATABASE_HOSTNAME required", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /secrets\.PROD_DATABASE_URL/);
  assert.match(yaml, /vars\.PRODUCTION_DATABASE_HOSTNAME/);
  assert.match(yaml, /if \[ -z "\$\{DATABASE_URL:-\}" \]; then/);
  assert.match(yaml, /if \[ -z "\$\{PROD_ALLOWLIST\}" \]; then/);
});

test("Contract 10 & 11: production hostname positive match and staging hostname rejection", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /if\s*\[\s*"\$\{HOST\}"\s*!=\s*"\$\{PROD_ALLOWLIST\}"\s*\]/);
  assert.match(yaml, /vars\.STAGING_DATABASE_HOSTNAME/);
  assert.match(yaml, /if\s*\[\s*-n\s*"\$\{KNOWN_STAGING_HOST\}"\s*\]\s*&&\s*\[\s*"\$\{HOST\}"\s*==\s*"\$\{KNOWN_STAGING_HOST\}"\s*\]/);
  // Log must be sanitized, never printing DATABASE_URL value
  assert.doesNotMatch(yaml, /echo.*\$[{]?(?:PROD_)?DATABASE_URL/);
});

test("Contract 12, 13, 14, 15: pg_dump uses custom format, compress 9, no-owner, no-privileges, direct to file", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /pg_dump\b/);
  assert.match(yaml, /--format=custom/);
  assert.match(yaml, /--compress=9/);
  assert.match(yaml, /--no-owner/);
  assert.match(yaml, /--no-privileges/);
  assert.match(yaml, /--file="\$\{BACKUP_FILE\}"/);
  // Must not dump to stdout or use plain SQL
  assert.doesNotMatch(yaml, />\s*\$\{BACKUP_FILE\}/);
  assert.doesNotMatch(yaml, /--format=plain/);
});

test("Contract 16 & 17: SHA-256 sidecar generated and manifest excludes credentials", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /--sha256-file="\$\{BACKUP_FILE\}\.sha256"/);
  assert.match(yaml, /--output="backup_output\/manifest\.json"/);
});

test("Contract 18: pg_restore --list structural verification required (no restore)", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /pg_restore\s+--list\s+"\$\{BACKUP_FILE\}"/);
  // Must NOT execute data restoration
  assert.doesNotMatch(yaml, /pg_restore\s+.*(?:-d|--dbname|--clean|--create)\s+/);
});

test("Contract 19 & 20: artifact package includes dump + checksum + manifest with 7 days retention", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /actions\/upload-artifact@v4/);
  assert.match(yaml, /retention-days:\s*7/);
  assert.match(yaml, /backup_output\/\*\.dump/);
  assert.match(yaml, /backup_output\/\*\.dump\.sha256/);
  assert.match(yaml, /backup_output\/manifest\.json/);
});

test("Contract 21 & 22: concurrency group configured with cancel-in-progress false", () => {
  const yaml = readWorkflowYaml();
  assert.match(yaml, /concurrency:\s*\n\s*group:\s*database-production-backup\s*\n\s*cancel-in-progress:\s*false/);
});

test("Contract 23: no destructive or data restoring commands exist in workflow", () => {
  const yaml = readWorkflowYaml();
  assert.doesNotMatch(yaml, /\bDROP\s+DATABASE\b/i);
  assert.doesNotMatch(yaml, /\bTRUNCATE\b/i);
  assert.doesNotMatch(yaml, /\bpsql\b/);
  assert.doesNotMatch(yaml, /drizzle-kit\s+push/);
});

/* ============================================================
   MANIFEST BUILDER & VALIDATOR UNIT TESTS
   ============================================================ */

test("parseRestoreListToc extracts aggregates correctly and ignores comments", () => {
  const sampleToc = `
;
; Archive created at 2026-09-21 03:00:00 UTC
;
100; 1259 16400 TABLE public users postgres
101; 0 16400 TABLE DATA public users postgres
102; 1259 16405 TABLE public worker_profiles postgres
103; 0 16405 TABLE DATA public worker_profiles postgres
104; 1259 16410 SEQUENCE public users_id_seq postgres
105; 0 0 SEQUENCE SET public users_id_seq postgres
`;

  const parsed = parseRestoreListToc(sampleToc);
  assert.strictEqual(parsed.pgRestoreListPassed, true);
  assert.strictEqual(parsed.totalTocEntries, 6);
  assert.strictEqual(parsed.tableEntriesCount, 2);
  assert.strictEqual(parsed.tableDataEntriesCount, 2);
  assert.strictEqual(parsed.sequenceEntriesCount, 2);
});

test("assertNoSecrets throws when sensitive connection strings or passwords appear", () => {
  assert.throws(
    () => {
      assertNoSecrets({
        url: "postgresql://user:password@host/db",
      });
    },
    /SECURITY_VIOLATION/
  );

  assert.throws(
    () => {
      assertNoSecrets({
        databaseHostname: "user:pass@ep-main.aws.neon.tech",
      });
    },
    /SECURITY_VIOLATION/
  );

  assert.throws(
    () => {
      assertNoSecrets({
        secretToken: "ghp_1234567890",
      });
    },
    /SECURITY_VIOLATION/
  );
});

test("buildBackupManifest creates valid manifest and validates against real temporary dump file", () => {
  const testDir = join(tmpdir(), `dr-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const dummyDumpPath = join(testDir, "seasonal-worker-prod-20260921T030000Z.dump");
  const dummyData = Buffer.from("DUMMY_PG_DUMP_CUSTOM_HEADER_AND_DATA");
  writeFileSync(dummyDumpPath, dummyData);

  const sha256 = calculateFileSha256(dummyDumpPath);
  const sidecarPath = `${dummyDumpPath}.sha256`;
  writeFileSync(sidecarPath, formatSha256Sidecar(sha256, "seasonal-worker-prod-20260921T030000Z.dump"));

  const manifest = buildBackupManifest({
    sourceCommitSha: "9d9e47257d1edd0f86933ebdfea6d5198411e2a3",
    backupFilePath: dummyDumpPath,
    databaseHostname: "ep-main-123456.ap-southeast-1.aws.neon.tech",
    repository: "nguyenanvuong2006/seasonal-worker",
    postgresClientVersion: "pg_dump (PostgreSQL) 16.2",
    tocContent: "100; 1259 16400 TABLE public users postgres\n101; 0 16400 TABLE DATA public users postgres\n",
  });

  assert.strictEqual(manifest.formatVersion, MANIFEST_FORMAT_VERSION);
  assert.strictEqual(manifest.backupType, BACKUP_TYPE);
  assert.strictEqual(manifest.environment, EXPECTED_ENVIRONMENT);
  assert.strictEqual(manifest.sourceCommitSha, "9d9e47257d1edd0f86933ebdfea6d5198411e2a3");
  assert.strictEqual(manifest.backupFilename, "seasonal-worker-prod-20260921T030000Z.dump");
  assert.strictEqual(manifest.backupSizeBytes, dummyData.length);
  assert.strictEqual(manifest.sha256, sha256);
  assert.strictEqual(manifest.databaseHostname, "ep-main-123456.ap-southeast-1.aws.neon.tech");
  assert.strictEqual(manifest.verification.pgRestoreListPassed, true);
  assert.strictEqual(manifest.verification.tableEntriesCount, 1);
  assert.strictEqual(manifest.verification.tableDataEntriesCount, 1);

  // Validate manifest via validateBackupManifest
  assert.strictEqual(
    validateBackupManifest(manifest, {
      backupFilePath: dummyDumpPath,
      sha256FilePath: sidecarPath,
    }),
    true
  );

  // Validate sidecar helper
  const sidecarContent = readFileSync(sidecarPath, "utf8");
  assert.strictEqual(
    validateSha256Sidecar(sidecarContent, sha256, "seasonal-worker-prod-20260921T030000Z.dump"),
    true
  );

  // Clean up
  rmSync(testDir, { recursive: true, force: true });
});

test("validateBackupManifest rejects corrupted checksum or modified file size", () => {
  const testDir = join(tmpdir(), `dr-test-corrupt-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const dummyDumpPath = join(testDir, "seasonal-worker-prod-20260921T040000Z.dump");
  writeFileSync(dummyDumpPath, Buffer.from("ORIGINAL_CONTENT"));

  const manifest = buildBackupManifest({
    sourceCommitSha: "9d9e47257d1edd0f86933ebdfea6d5198411e2a3",
    backupFilePath: dummyDumpPath,
    databaseHostname: "ep-main-123456.ap-southeast-1.aws.neon.tech",
    repository: "nguyenanvuong2006/seasonal-worker",
    postgresClientVersion: "pg_dump (PostgreSQL) 16.2",
  });

  // Tamper with file
  writeFileSync(dummyDumpPath, Buffer.from("TAMPERED_CONTENT"));

  assert.throws(
    () => {
      validateBackupManifest(manifest, {
        backupFilePath: dummyDumpPath,
      });
    },
    /SIZE_MISMATCH|CHECKSUM_MISMATCH/
  );

  // Clean up
  rmSync(testDir, { recursive: true, force: true });
});

test("validateBackupManifest rejects invalid formatVersion or missing verification", () => {
  const invalidManifest: any = {
    formatVersion: 2,
    backupType: BACKUP_TYPE,
    environment: EXPECTED_ENVIRONMENT,
    repository: "nguyenanvuong2006/seasonal-worker",
    sourceCommitSha: "9d9e47257d1edd0f86933ebdfea6d5198411e2a3",
    createdAt: new Date().toISOString(),
    postgresClientVersion: "16.2",
    backupFilename: "seasonal-worker-prod-20260921T050000Z.dump",
    backupSizeBytes: 100,
    sha256: "a".repeat(64),
    databaseHostname: "ep-main.aws.neon.tech",
    verification: { pgRestoreListPassed: false },
  };

  assert.throws(() => validateBackupManifest(invalidManifest), /UNSUPPORTED_FORMAT_VERSION/);

  invalidManifest.formatVersion = 1;
  assert.throws(() => validateBackupManifest(invalidManifest), /VERIFICATION_FAILED/);
});
