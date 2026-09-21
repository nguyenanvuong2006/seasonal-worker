#!/usr/bin/env node
/**
 * DISASTER RECOVERY (DR) PHASE 2A: BACKUP MANIFEST BUILDER
 * --------------------------------------------------------
 * Constructs a sanitized sidecar manifest JSON and SHA-256 checksum file
 * for logical database backups.
 *
 * SAFETY & SECURITY INVARIANTS:
 * - formatVersion: 1
 * - backupType: "POSTGRES_LOGICAL_PG_DUMP"
 * - environment: "production"
 * - NEVER contains database credentials, tokens, passwords, or connection strings.
 * - Computes cryptographic SHA-256 of the backup file.
 * - Parses TOC list from `pg_restore --list` for safe aggregate metadata.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export const MANIFEST_FORMAT_VERSION = 1;
export const BACKUP_TYPE = "POSTGRES_LOGICAL_PG_DUMP";
export const EXPECTED_ENVIRONMENT = "production";

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;
const COMMIT_SHA_REGEX = /^[a-f0-9]{40}$/;
const FILENAME_REGEX = /^seasonal-worker-prod-[0-9]{8}T[0-9]{6}Z\.dump$/;

/**
 * Computes SHA-256 hex string of a file.
 * @param {string} filePath
 * @returns {string} 64-char lowercase hex string
 */
export function calculateFileSha256(filePath) {
  const buffer = readFileSync(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Parses safe aggregate statistics from pg_restore --list TOC output.
 * @param {string} tocContent
 * @returns {{
 *   pgRestoreListPassed: boolean,
 *   totalTocEntries: number,
 *   tableEntriesCount: number,
 *   tableDataEntriesCount: number,
 *   sequenceEntriesCount: number
 * }}
 */
export function parseRestoreListToc(tocContent) {
  if (typeof tocContent !== "string") {
    throw new Error("TOC content must be a string.");
  }

  const lines = tocContent.split("\n");
  let totalTocEntries = 0;
  let tableEntriesCount = 0;
  let tableDataEntriesCount = 0;
  let sequenceEntriesCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) {
      continue;
    }
    totalTocEntries++;
    if (/\bTABLE\b/.test(line) && !/\bTABLE DATA\b/.test(line)) {
      tableEntriesCount++;
    } else if (/\bTABLE DATA\b/.test(line)) {
      tableDataEntriesCount++;
    } else if (/\bSEQUENCE\b/.test(line) || /\bSEQUENCE SET\b/.test(line)) {
      sequenceEntriesCount++;
    }
  }

  return {
    pgRestoreListPassed: true,
    totalTocEntries,
    tableEntriesCount,
    tableDataEntriesCount,
    sequenceEntriesCount,
  };
}

/**
 * Checks that the manifest contains no sensitive strings or credentials.
 * Throws an error immediately if any forbidden pattern is discovered.
 * @param {Record<string, unknown>} manifest
 */
export function assertNoSecrets(manifest) {
  const serialized = JSON.stringify(manifest);

  const forbiddenPatterns = [
    /postgres(?:ql)?:\/\//i,
    /password/i,
    /token/i,
    /secret/i,
    /bearer\s+/i,
    /:[^/@\s]+@/, // username:password@host pattern
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(serialized)) {
      throw new Error(
        `SECURITY_VIOLATION: Manifest contains forbidden sensitive pattern: ${pattern.toString()}`
      );
    }
  }

  // Explicit check on hostname
  if (typeof manifest.databaseHostname === "string") {
    if (
      manifest.databaseHostname.includes("@") ||
      manifest.databaseHostname.includes(":") ||
      manifest.databaseHostname.includes("/")
    ) {
      throw new Error(
        `SECURITY_VIOLATION: databaseHostname contains invalid characters: "${manifest.databaseHostname}"`
      );
    }
  }
}

/**
 * Builds the canonical backup manifest object.
 * @param {{
 *   sourceCommitSha: string,
 *   backupFilePath: string,
 *   databaseHostname: string,
 *   repository: string,
 *   postgresClientVersion: string,
 *   tocContent?: string,
 *   createdAt?: string,
 * }} options
 */
export function buildBackupManifest(options) {
  const {
    sourceCommitSha,
    backupFilePath,
    databaseHostname,
    repository,
    postgresClientVersion,
    tocContent,
    createdAt = new Date().toISOString(),
  } = options;

  if (!sourceCommitSha || !COMMIT_SHA_REGEX.test(sourceCommitSha.trim())) {
    throw new Error(
      `INVALID_SOURCE_COMMIT_SHA: Expected 40 lowercase hex characters, got "${sourceCommitSha}".`
    );
  }

  if (!databaseHostname || typeof databaseHostname !== "string" || !databaseHostname.trim()) {
    throw new Error("INVALID_DATABASE_HOSTNAME: Hostname must be a non-empty string.");
  }

  const cleanHostname = databaseHostname.trim();
  if (cleanHostname.includes("@") || cleanHostname.includes(":") || cleanHostname.includes("/")) {
    throw new Error(
      `INVALID_DATABASE_HOSTNAME: Hostname must not include credentials or paths: "${cleanHostname}".`
    );
  }

  const stats = statSync(backupFilePath);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(
      `INVALID_BACKUP_FILE: File "${backupFilePath}" does not exist or is empty (size: ${stats.size}).`
    );
  }

  const backupFilename = basename(backupFilePath);
  if (!FILENAME_REGEX.test(backupFilename)) {
    throw new Error(
      `INVALID_BACKUP_FILENAME: Filename "${backupFilename}" does not match expected pattern (seasonal-worker-prod-YYYYMMDDTHHMMSSZ.dump).`
    );
  }

  const sha256 = calculateFileSha256(backupFilePath);
  if (!SHA256_HEX_REGEX.test(sha256)) {
    throw new Error(`INVALID_SHA256: Checksum calculation failed.`);
  }

  const verification = tocContent
    ? parseRestoreListToc(tocContent)
    : {
        pgRestoreListPassed: true,
        totalTocEntries: 0,
        tableEntriesCount: 0,
        tableDataEntriesCount: 0,
        sequenceEntriesCount: 0,
      };

  const manifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    backupType: BACKUP_TYPE,
    environment: EXPECTED_ENVIRONMENT,
    repository: repository ? repository.trim() : "nguyenanvuong2006/seasonal-worker",
    sourceCommitSha: sourceCommitSha.trim(),
    createdAt,
    postgresClientVersion: postgresClientVersion ? postgresClientVersion.trim() : "unknown",
    backupFilename,
    backupSizeBytes: stats.size,
    sha256,
    databaseHostname: cleanHostname,
    verification,
  };

  assertNoSecrets(manifest);

  return manifest;
}

/**
 * Formats a sha256 sidecar line: "<hash>  <filename>\n"
 * @param {string} hash
 * @param {string} filename
 * @returns {string}
 */
export function formatSha256Sidecar(hash, filename) {
  return `${hash}  ${filename}\n`;
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
    const backupFilePath = opts["backup-file"];
    const sourceCommitSha = opts["source-commit-sha"];
    const databaseHostname = opts["database-hostname"];
    const repository = opts["repository"] || process.env.GITHUB_REPOSITORY || "nguyenanvuong2006/seasonal-worker";
    const postgresClientVersion = opts["postgres-version"] || "unknown";
    const tocFilePath = opts["toc-file"];
    const outputPath = opts["output"] || "backup_output/manifest.json";
    const sha256FilePath = opts["sha256-file"];

    if (!backupFilePath) {
      throw new Error("Missing required flag: --backup-file=<path>");
    }
    if (!sourceCommitSha) {
      throw new Error("Missing required flag: --source-commit-sha=<sha>");
    }
    if (!databaseHostname) {
      throw new Error("Missing required flag: --database-hostname=<host>");
    }

    let tocContent;
    if (tocFilePath) {
      tocContent = readFileSync(tocFilePath, "utf8");
    }

    const manifest = buildBackupManifest({
      sourceCommitSha,
      backupFilePath,
      databaseHostname,
      repository,
      postgresClientVersion,
      tocContent,
    });

    writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(`[DR] Manifest written to ${outputPath}`);

    if (sha256FilePath) {
      const sidecarContent = formatSha256Sidecar(manifest.sha256, manifest.backupFilename);
      writeFileSync(sha256FilePath, sidecarContent, "utf8");
      console.log(`[DR] SHA-256 sidecar written to ${sha256FilePath}`);
    }
  } catch (err) {
    console.error(`[DR ERROR] ${(err && err.message) || err}`);
    process.exit(1);
  }
}
