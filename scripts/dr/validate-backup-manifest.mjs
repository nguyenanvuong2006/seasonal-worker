#!/usr/bin/env node
/**
 * DISASTER RECOVERY (DR) PHASE 2A: BACKUP MANIFEST VALIDATOR
 * -----------------------------------------------------------
 * Validates the schema, integrity, checksums, and credential absence
 * of a backup manifest and its accompanying artifact files.
 *
 * SAFETY INVARIANTS:
 * - formatVersion must be 1.
 * - backupType must be POSTGRES_LOGICAL_PG_DUMP.
 * - environment must be production.
 * - sha256 in manifest must match actual file sha256.
 * - backupSizeBytes must match actual file size.
 * - sidecar .sha256 must match exactly.
 * - Rejects any credentials, tokens, or connection strings.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  assertNoSecrets,
  calculateFileSha256,
  MANIFEST_FORMAT_VERSION,
  BACKUP_TYPE,
  EXPECTED_ENVIRONMENT,
} from "./build-backup-manifest.mjs";

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;
const COMMIT_SHA_REGEX = /^[a-f0-9]{40}$/;
const FILENAME_REGEX = /^seasonal-worker-prod-[0-9]{8}T[0-9]{6}Z\.dump$/;

/**
 * Validates a sha256 sidecar file content.
 * @param {string} sidecarContent
 * @param {string} expectedSha256
 * @param {string} expectedFilename
 */
export function validateSha256Sidecar(sidecarContent, expectedSha256, expectedFilename) {
  if (typeof sidecarContent !== "string") {
    throw new Error("Sidecar content must be a string.");
  }
  const trimmed = sidecarContent.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`INVALID_SIDECAR_FORMAT: Expected "<hash>  <filename>", got "${trimmed}".`);
  }
  const [hash, file] = parts;
  if (hash.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(
      `SIDECAR_HASH_MISMATCH: Sidecar hash "${hash}" does not match expected "${expectedSha256}".`
    );
  }
  if (file !== expectedFilename) {
    throw new Error(
      `SIDECAR_FILENAME_MISMATCH: Sidecar filename "${file}" does not match expected "${expectedFilename}".`
    );
  }
  return true;
}

/**
 * Validates a backup manifest object against integrity rules and local files.
 * @param {Record<string, any>} manifest
 * @param {{ backupFilePath?: string, sha256FilePath?: string }} [options]
 */
export function validateBackupManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("INVALID_MANIFEST: Manifest must be a non-null object.");
  }

  // 1. Format version
  if (manifest.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new Error(
      `UNSUPPORTED_FORMAT_VERSION: Expected ${MANIFEST_FORMAT_VERSION}, got ${manifest.formatVersion}.`
    );
  }

  // 2. Backup type
  if (manifest.backupType !== BACKUP_TYPE) {
    throw new Error(
      `INVALID_BACKUP_TYPE: Expected "${BACKUP_TYPE}", got "${manifest.backupType}".`
    );
  }

  // 3. Environment
  if (manifest.environment !== EXPECTED_ENVIRONMENT) {
    throw new Error(
      `INVALID_ENVIRONMENT: Expected "${EXPECTED_ENVIRONMENT}", got "${manifest.environment}".`
    );
  }

  // 4. Repository
  if (!manifest.repository || typeof manifest.repository !== "string" || !manifest.repository.trim()) {
    throw new Error("INVALID_REPOSITORY: repository must be a non-empty string.");
  }

  // 5. Source commit SHA
  if (!manifest.sourceCommitSha || !COMMIT_SHA_REGEX.test(manifest.sourceCommitSha.trim())) {
    throw new Error(
      `INVALID_SOURCE_COMMIT_SHA: sourceCommitSha must be 40 lowercase hex characters, got "${manifest.sourceCommitSha}".`
    );
  }

  // 6. Created at
  if (!manifest.createdAt || typeof manifest.createdAt !== "string" || isNaN(Date.parse(manifest.createdAt))) {
    throw new Error(`INVALID_CREATED_AT: createdAt must be a valid ISO 8601 date string.`);
  }

  // 7. Postgres client version
  if (!manifest.postgresClientVersion || typeof manifest.postgresClientVersion !== "string") {
    throw new Error("INVALID_POSTGRES_VERSION: postgresClientVersion must be a non-empty string.");
  }

  // 8. Backup filename
  if (!manifest.backupFilename || !FILENAME_REGEX.test(manifest.backupFilename)) {
    throw new Error(
      `INVALID_BACKUP_FILENAME: "${manifest.backupFilename}" does not match seasonal-worker-prod-YYYYMMDDTHHMMSSZ.dump.`
    );
  }

  // 9. Backup size bytes
  if (
    typeof manifest.backupSizeBytes !== "number" ||
    !Number.isInteger(manifest.backupSizeBytes) ||
    manifest.backupSizeBytes <= 0
  ) {
    throw new Error(
      `INVALID_BACKUP_SIZE: backupSizeBytes must be a positive integer, got ${manifest.backupSizeBytes}.`
    );
  }

  // 10. SHA-256
  if (!manifest.sha256 || !SHA256_HEX_REGEX.test(manifest.sha256.trim())) {
    throw new Error(
      `INVALID_SHA256: sha256 must be 64 lowercase hex characters, got "${manifest.sha256}".`
    );
  }

  // 11. Database hostname
  if (!manifest.databaseHostname || typeof manifest.databaseHostname !== "string") {
    throw new Error("INVALID_DATABASE_HOSTNAME: databaseHostname must be a non-empty string.");
  }

  // 12. Verification block
  if (!manifest.verification || typeof manifest.verification !== "object") {
    throw new Error("INVALID_VERIFICATION: verification object is required.");
  }
  if (manifest.verification.pgRestoreListPassed !== true) {
    throw new Error("VERIFICATION_FAILED: verification.pgRestoreListPassed must be true.");
  }

  // 13. Secret & credential absence
  assertNoSecrets(manifest);

  // 14. File-level verification if backupFilePath is provided
  if (options.backupFilePath) {
    const stats = statSync(options.backupFilePath);
    if (stats.size !== manifest.backupSizeBytes) {
      throw new Error(
        `SIZE_MISMATCH: Actual file size (${stats.size} bytes) does not match manifest (${manifest.backupSizeBytes} bytes).`
      );
    }
    const actualFilename = basename(options.backupFilePath);
    if (actualFilename !== manifest.backupFilename) {
      throw new Error(
        `FILENAME_MISMATCH: Actual file name ("${actualFilename}") does not match manifest ("${manifest.backupFilename}").`
      );
    }
    const actualSha256 = calculateFileSha256(options.backupFilePath);
    if (actualSha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
      throw new Error(
        `CHECKSUM_MISMATCH: Actual file SHA-256 ("${actualSha256}") does not match manifest ("${manifest.sha256}").`
      );
    }
  }

  // 15. Sidecar file verification if sha256FilePath is provided
  if (options.sha256FilePath) {
    const sidecarContent = readFileSync(options.sha256FilePath, "utf8");
    validateSha256Sidecar(sidecarContent, manifest.sha256, manifest.backupFilename);
  }

  return true;
}

/**
 * CLI Entrypoint
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, ...vals] = arg.slice(2).split("=");
      options[key] = vals.join("=");
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  try {
    const opts = parseArgs();
    const manifestPath = opts["manifest"] || "backup_output/manifest.json";
    const backupFilePath = opts["backup-file"];
    const sha256FilePath = opts["sha256-file"];

    const manifestContent = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(manifestContent);

    validateBackupManifest(manifest, {
      backupFilePath,
      sha256FilePath,
    });

    console.log(`[DR] Manifest ${manifestPath} successfully validated!`);
    console.log(`[DR] Backup file: ${manifest.backupFilename} (${manifest.backupSizeBytes} bytes)`);
    console.log(`[DR] SHA-256: ${manifest.sha256}`);
    console.log(`[DR] pgRestoreListPassed: ${manifest.verification.pgRestoreListPassed}`);
  } catch (err) {
    console.error(`[DR ERROR] ${(err && err.message) || err}`);
    process.exit(1);
  }
}
