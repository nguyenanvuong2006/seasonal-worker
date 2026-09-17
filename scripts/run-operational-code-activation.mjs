#!/usr/bin/env node
/**
 * OPERATIONAL CODE PRODUCTION ACTIVATION CLI WRAPPER
 * --------------------------------------------------
 * Standalone server-side runner for Production operational-code activation.
 * Calls the canonical writer `applyOperationalCodeActivation(checksum)`
 * implemented in src/lib/operational-code-activation.ts.
 *
 * SAFETY INVARIANTS:
 * - Does NOT duplicate any INSERT/UPDATE activation SQL logic.
 * - Validates checksum format (/^[a-f0-9]{64}$/) BEFORE calling writer.
 * - Writer acquires advisory locks and recomputes the plan inside an
 *   atomic transaction (zero-TOCTOU).
 * - Never prints PII (CCCD, phone, full name, raw worker IDs).
 * - Exits non-zero on any error (stale, not-ready, locked, conflict, tx failure).
 * - Does NOT catch-and-ignore errors.
 */
import { config } from "dotenv";
import { execSync } from "node:child_process";

config({ path: ".env.local" });
config();

const CHECKSUM_REGEX = /^[a-f0-9]{64}$/;

/**
 * Validates that the provided checksum is a valid 64-character lowercase hex string.
 * Throws immediately if invalid.
 */
export function validateChecksum(checksum) {
  if (!checksum || typeof checksum !== "string" || !CHECKSUM_REGEX.test(checksum.trim())) {
    throw new Error(
      `INVALID_ACTIVATION_CONTENT_CHECKSUM: Checksum must be exactly 64 lowercase hexadecimal characters. Received: "${checksum || ""}".`
    );
  }
  return checksum.trim();
}

/**
 * Retrieves the current commit SHA from APP_COMMIT_SHA or git rev-parse HEAD.
 */
export function getCommitSha() {
  if (process.env.APP_COMMIT_SHA) {
    return process.env.APP_COMMIT_SHA.trim();
  }
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "(unknown-commit)";
  }
}

/**
 * Loads the canonical applyOperationalCodeActivation function.
 * Tries direct dynamic import first; falls back to sandbox loadModule if
 * blocked by server-only or module resolution outside Next.js.
 */
export async function loadActivationWriter() {
  try {
    const mod = await import("../src/lib/operational-code-activation.ts");
    if (typeof mod.applyOperationalCodeActivation === "function") {
      return mod.applyOperationalCodeActivation;
    }
  } catch {
    // Fall through to loadModule adapter
  }

  const { loadModule, serverOnlyStub } = await import("../src/lib/test-support/load-module.ts");
  const mod = loadModule(new URL("../src/lib/operational-code-activation.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": await import("drizzle-orm"),
      "node:crypto": await import("node:crypto"),
      "@/db": await import("../src/db/index.ts"),
      "@/lib/operational-code-activation-plan": await import("../src/lib/operational-code-activation-plan.ts"),
      "@/lib/data-management/reset-service": {
        DATA_MANAGEMENT_ADVISORY_LOCK_KEY: 847_291_003,
      },
    },
  });

  if (typeof mod.applyOperationalCodeActivation !== "function") {
    throw new Error("Failed to load canonical applyOperationalCodeActivation from src/lib/operational-code-activation.ts");
  }
  return mod.applyOperationalCodeActivation;
}

/**
 * Main activation runner.
 */
export async function runActivation(options = {}) {
  const rawChecksum = options.checksum ?? process.env.ACTIVATION_CONTENT_CHECKSUM;
  const checksum = validateChecksum(rawChecksum);
  const commitSha = options.commitSha ?? getCommitSha();

  console.log("============================================================");
  console.log(" OPERATIONAL CODE ACTIVATION — PRODUCTION EXECUTION");
  console.log("============================================================");
  console.log(`Commit SHA:                ${commitSha}`);
  console.log(`Target Content Checksum:   ${checksum}`);
  console.log("PII Policy:                STRICT — Zero PII displayed in logs");
  console.log("Concurrency / Locking:     pg_try_advisory_xact_lock in transaction");
  console.log("Freshness Validation:      Recomputed inside locked transaction");
  console.log("============================================================\n");

  const writer = options.writer ?? (await loadActivationWriter());
  const executor = options.executor; // optional override for testing

  // Invoke writer — fails closed on any mismatch or lock contention
  const result = await writer(checksum, executor);

  console.log("\n============================================================");
  console.log(" ✅ ACTIVATION COMPLETED SUCCESSFULLY (AGGREGATE SUMMARY)");
  console.log("============================================================");
  console.log(`Result:                    OK`);
  console.log(`Content Checksum:          ${result.activationContentChecksum}`);
  console.log(`Full Plan Checksum:        ${result.checksum}`);
  console.log(`Protected Legacy DW Codes: ${result.protectedDwCount}`);
  console.log(`Adopted DW Codes:          ${result.adoptedDwCount}`);
  console.log(`Adopted IT Codes:          ${result.adoptedItCount}`);
  console.log(`Skipped DW Codes:          ${result.skippedDwCount}`);
  console.log(`Skipped IT Codes:          ${result.skippedItCount}`);
  console.log("============================================================\n");

  return result;
}

// Execute when invoked directly via node CLI
const isDirectRun = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith("run-operational-code-activation.mjs") ||
   process.argv[1].endsWith("run-operational-code-activation"))
);

if (isDirectRun) {
  runActivation()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\n❌ ACTIVATION FAILED: ${err?.message || err}`);
      process.exit(1);
    });
}
