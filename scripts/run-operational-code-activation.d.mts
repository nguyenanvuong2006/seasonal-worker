import type { ApplyActivationResult } from "../src/lib/operational-code-activation";

export function validateChecksum(checksum: string | null | undefined): string;
export function getCommitSha(): string;
export function loadActivationWriter(): Promise<(checksum: string, executor?: unknown) => Promise<ApplyActivationResult>>;
export function runActivation(options?: {
  checksum?: string;
  commitSha?: string;
  writer?: (checksum: string, executor?: unknown) => Promise<ApplyActivationResult>;
  executor?: unknown;
}): Promise<ApplyActivationResult>;
