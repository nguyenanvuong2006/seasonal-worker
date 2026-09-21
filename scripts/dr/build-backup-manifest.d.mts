export const MANIFEST_FORMAT_VERSION: number;
export const BACKUP_TYPE: string;
export const EXPECTED_ENVIRONMENT: string;

export interface BackupManifestVerification {
  pgRestoreListPassed: boolean;
  totalTocEntries: number;
  tableEntriesCount: number;
  tableDataEntriesCount: number;
  sequenceEntriesCount: number;
}

export interface BackupManifest {
  formatVersion: number;
  backupType: string;
  environment: string;
  repository: string;
  sourceCommitSha: string;
  createdAt: string;
  postgresClientVersion: string;
  backupFilename: string;
  backupSizeBytes: number;
  sha256: string;
  databaseHostname: string;
  verification: BackupManifestVerification;
}

export interface BuildBackupManifestOptions {
  sourceCommitSha: string;
  backupFilePath: string;
  databaseHostname: string;
  repository: string;
  postgresClientVersion?: string;
  tocContent?: string;
  createdAt?: string;
}

export function calculateFileSha256(filePath: string): string;
export function parseRestoreListToc(tocContent: string): BackupManifestVerification;
export function assertNoSecrets(manifest: Record<string, unknown>): void;
export function buildBackupManifest(options: BuildBackupManifestOptions): BackupManifest;
export function formatSha256Sidecar(hash: string, filename: string): string;
