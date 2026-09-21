import type { BackupManifest } from "./build-backup-manifest.d.mts";

export interface ValidateBackupManifestOptions {
  backupFilePath?: string;
  sha256FilePath?: string;
}

export function validateSha256Sidecar(
  sidecarContent: string,
  expectedSha256: string,
  expectedFilename: string
): boolean;

export function validateBackupManifest(
  manifest: Record<string, unknown> | BackupManifest,
  options?: ValidateBackupManifestOptions
): boolean;
