/**
 * TESTS FOR PRODUCTION OPERATIONAL-CODE ACTIVATION WORKFLOW & CLI WRAPPERS
 * ------------------------------------------------------------------------
 * Verifies all governance, safety, and security guardrails specified in
 * Section 9 (A through N):
 *
 * A. Workflow is workflow_dispatch only.
 * B. Workflow requires activation_content_checksum and confirmation.
 * C. Exact confirmation string (ACTIVATE_OPERATIONAL_CODES_PRODUCTION) is enforced.
 * D. Ref refs/heads/main is enforced.
 * E. Checksum format (64 lowercase hex chars) is validated.
 * F. Environment is production.
 * G. Concurrency group has cancel-in-progress=false.
 * H. No push/pull_request/schedule triggers exist.
 * I. Activation script calls canonical writer and does NOT duplicate INSERT/UPDATE SQL.
 * J. Script rejects invalid checksum before writer invocation.
 * K. Workflow runs dry-run before activation.
 * L. Workflow runs read-only verification after activation.
 * M. Workflow does not contain automatic retry/loop logic.
 * N. No PII logging patterns are introduced.
 *
 * PLUS: Unit tests for the CLI runner (runActivation) with stubbed writer,
 * and post-activation verification (verifyOperationalCodeActivation) with mock client.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateChecksum,
  runActivation,
} from "./run-operational-code-activation.mjs";
import {
  verifyOperationalCodeActivation,
} from "./verify-operational-code-activation.mjs";

const ROOT = process.cwd();
const WORKFLOW_PATH = ".github/workflows/activate-operational-codes-production.yml";
const RUNNER_SCRIPT_PATH = "scripts/run-operational-code-activation.mjs";
const VERIFY_SCRIPT_PATH = "scripts/verify-operational-code-activation.mjs";

function readWorkflow(): string {
  return readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
}

function readRunnerScript(): string {
  return readFileSync(join(ROOT, RUNNER_SCRIPT_PATH), "utf8");
}

function readVerifyScript(): string {
  return readFileSync(join(ROOT, VERIFY_SCRIPT_PATH), "utf8");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*#.*$/gm, "");
}

/* ============================================================
   WORKFLOW GOVERNANCE TESTS (A - H, K - N)
   ============================================================ */

test("A & H — workflow is workflow_dispatch ONLY (no push, pull_request, schedule)", () => {
  const yaml = readWorkflow();
  // Must have workflow_dispatch
  assert.match(yaml, /\bon:\s*\n\s*workflow_dispatch:/);
  // Must NOT have push, pull_request, or schedule triggers
  assert.doesNotMatch(yaml, /\bpush:\s*/);
  assert.doesNotMatch(yaml, /\bpull_request:\s*/);
  assert.doesNotMatch(yaml, /\bschedule:\s*/);
});

test("B — workflow requires activation_content_checksum and confirmation inputs", () => {
  const yaml = readWorkflow();
  assert.match(yaml, /activation_content_checksum:\s*\n[\s\S]*?required:\s*true/);
  assert.match(yaml, /confirmation:\s*\n[\s\S]*?required:\s*true/);
});

test("C — exact confirmation string 'ACTIVATE_OPERATIONAL_CODES_PRODUCTION' is enforced", () => {
  const yaml = readWorkflow();
  assert.match(yaml, /ACTIVATE_OPERATIONAL_CODES_PRODUCTION/);
  assert.match(
    yaml,
    /if\s*\[\s*"\$\{\{\s*github\.event\.inputs\.confirmation\s*\}\}"\s*!=\s*"ACTIVATE_OPERATIONAL_CODES_PRODUCTION"\s*\]/
  );
});

test("D — ref refs/heads/main is enforced", () => {
  const yaml = readWorkflow();
  assert.match(
    yaml,
    /if\s*\[\s*"\$\{\{\s*github\.ref\s*\}\}"\s*!=\s*"refs\/heads\/main"\s*\]/
  );
});

test("E — checksum format (/^[a-f0-9]{64}$/) is validated in workflow", () => {
  const yaml = readWorkflow();
  assert.match(yaml, /\^\[a-f0-9\]\{64\}\$/);
});

test("F — environment is production", () => {
  const yaml = readWorkflow();
  assert.match(yaml, /environment:\s*production/);
});

test("G — concurrency group has cancel-in-progress=false", () => {
  const yaml = readWorkflow();
  assert.match(yaml, /concurrency:\s*\n\s*group:\s*operational-code-production-activation\s*\n\s*cancel-in-progress:\s*false/);
});

test("K — workflow runs dry-run before activation", () => {
  const yaml = readWorkflow();
  const dryRunIndex = yaml.indexOf("scripts/run-operational-code-activation-dryrun.mjs");
  const activationIndex = yaml.indexOf("scripts/run-operational-code-activation.mjs");
  assert.ok(dryRunIndex > 0, "must reference dry-run script");
  assert.ok(activationIndex > 0, "must reference activation script");
  assert.ok(dryRunIndex < activationIndex, "dry-run MUST be invoked before activation");
});

test("L — workflow runs read-only verification after activation", () => {
  const yaml = readWorkflow();
  const activationIndex = yaml.indexOf("scripts/run-operational-code-activation.mjs");
  const verifyIndex = yaml.indexOf("scripts/verify-operational-code-activation.mjs");
  assert.ok(activationIndex > 0, "must reference activation script");
  assert.ok(verifyIndex > 0, "must reference verify script");
  assert.ok(activationIndex < verifyIndex, "verification MUST be invoked after activation");
});

test("M — workflow does not contain automatic retry or loop logic", () => {
  const code = stripComments(readWorkflow());
  assert.doesNotMatch(code, /\bretry\b/i);
  assert.doesNotMatch(code, /\bwhile\s+true\b/i);
  assert.doesNotMatch(code, /\buntil\b/i);
});

test("N — no PII logging patterns exist in workflow or scripts", () => {
  const yaml = readWorkflow();
  const runner = readRunnerScript();
  const verify = readVerifyScript();

  for (const source of [yaml, runner, verify]) {
    assert.doesNotMatch(source, /\braw_cccd\b/);
    assert.doesNotMatch(source, /\bphone_number\b/);
    assert.doesNotMatch(source, /\bfull_name\b/);
  }
});

/* ============================================================
   CLI WRAPPER TESTS (I, J & UNIT BEHAVIOR)
   ============================================================ */

test("I — activation script calls canonical writer and does NOT duplicate INSERT/UPDATE SQL", () => {
  const code = stripComments(readRunnerScript());
  // Calls canonical writer
  assert.match(code, /applyOperationalCodeActivation/);
  // Zero mutating SQL statements in runner script
  assert.doesNotMatch(code, /INSERT\s+INTO/i);
  assert.doesNotMatch(code, /UPDATE\s+[a-z_]+/i);
  assert.doesNotMatch(code, /DELETE\s+FROM/i);
});

test("J — validateChecksum rejects invalid checksum format before writer invocation", () => {
  // Null or empty
  assert.throws(() => validateChecksum(""), /INVALID_ACTIVATION_CONTENT_CHECKSUM/);
  assert.throws(() => validateChecksum(null as unknown as string), /INVALID_ACTIVATION_CONTENT_CHECKSUM/);
  // Uppercase hex
  assert.throws(
    () => validateChecksum("9C7EC44C57EC755144FC01D1396999DC939722493EA10E6D511BADFE61003F1E"),
    /INVALID_ACTIVATION_CONTENT_CHECKSUM/
  );
  // Short length (63 characters)
  assert.throws(
    () => validateChecksum("9c7ec44c57ec755144fc01d1396999dc939722493ea10e6d511badfe61003f1"),
    /INVALID_ACTIVATION_CONTENT_CHECKSUM/
  );
  // Non-hex characters
  assert.throws(
    () => validateChecksum("9c7ec44c57ec755144fc01d1396999dc939722493ea10e6d511badfe61003f1z"),
    /INVALID_ACTIVATION_CONTENT_CHECKSUM/
  );
  // Valid checksum returns trimmed value
  const valid = "9c7ec44c57ec755144fc01d1396999dc939722493ea10e6d511badfe61003f1e";
  assert.equal(validateChecksum(`  ${valid}  `), valid);
});

test("CLI runner: invokes writer with valid checksum and outputs aggregate results", async () => {
  let writerCalledWith: string | null = null;
  const validChecksum = "9c7ec44c57ec755144fc01d1396999dc939722493ea10e6d511badfe61003f1e";

  const fakeWriter = async (checksum: string) => {
    writerCalledWith = checksum;
    return {
      ok: true as const,
      activationContentChecksum: checksum,
      checksum: "plan-checksum-12345",
      protectedDwCount: 13075,
      adoptedDwCount: 412,
      adoptedItCount: 1,
      skippedDwCount: 0,
      skippedItCount: 0,
    };
  };

  const result = await runActivation({
    checksum: validChecksum,
    commitSha: "a956ba1350b71aefd6eee19ff8a617f87cbcc0c5",
    writer: fakeWriter,
  });

  assert.equal(writerCalledWith, validChecksum);
  assert.equal(result.ok, true);
  assert.equal(result.protectedDwCount, 13075);
  assert.equal(result.adoptedDwCount, 412);
  assert.equal(result.adoptedItCount, 1);
});

test("CLI runner: propagates writer errors without catching or silencing them", async () => {
  const validChecksum = "9c7ec44c57ec755144fc01d1396999dc939722493ea10e6d511badfe61003f1e";

  const staleWriter = async () => {
    throw new Error("ACTIVATION_PLAN_STALE: supplied checksum does not match fresh plan");
  };

  await assert.rejects(
    () =>
      runActivation({
        checksum: validChecksum,
        commitSha: "a956ba1",
        writer: staleWriter,
      }),
    /ACTIVATION_PLAN_STALE/
  );
});

/* ============================================================
   POST-ACTIVATION VERIFICATION TESTS (Section 6)
   ============================================================ */

test("verifyOperationalCodeActivation: passes when all 7 invariants hold", async () => {
  const mockClient = {
    query: async (sql: string) => {
      const q = sql.toLowerCase();
      if (q.includes("dw_code_locations")) {
        return {
          rows: [
            { location_id: "loc-1", prefix: "DR", name: "Đạ Ròn", is_active: true, next_sequence: 50002 },
          ],
        };
      }
      if (q.includes("dw_data")) {
        return { rows: [] };
      }
      if (q.includes("worker_profiles")) {
        return { rows: [] };
      }
      if (q.includes("select count(*)::int as count from dw_codes where status = 'available'")) {
        return { rows: [{ count: 0 }] };
      }
      if (q.includes("select count(*)::int as count from dw_codes")) {
        return { rows: [{ count: 13487 }] };
      }
      if (q.includes("select count(*)::int as count from dw_code_assignments where released_at is null")) {
        return { rows: [{ count: 412 }] };
      }
      if (q.includes("group by code_id")) {
        return { rows: [] };
      }
      if (q.includes("group by it_code")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const verification = await verifyOperationalCodeActivation({ client: mockClient });
  assert.equal(verification.conflictsZero, true);
  assert.equal(verification.poolPopulated, true);
  assert.equal(verification.dwActiveAssignmentsExist, true);
  assert.equal(verification.protectedCodesNotAvailable, true);
  assert.equal(verification.noDuplicateDwActive, true);
  assert.equal(verification.noDuplicateItActive, true);
  assert.equal(verification.drNextSequenceSafe, true);
});

test("verifyOperationalCodeActivation: fails if dw_codes pool is empty", async () => {
  const mockClient = {
    query: async (sql: string) => {
      const q = sql.toLowerCase();
      if (q.includes("dw_code_locations")) {
        return { rows: [{ location_id: "loc-1", prefix: "DR", name: "Đạ Ròn", is_active: true, next_sequence: 50002 }] };
      }
      if (q.includes("select count(*)::int as count from dw_codes")) {
        return { rows: [{ count: 0 }] }; // pool empty!
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyOperationalCodeActivation({ client: mockClient }),
    /VERIFICATION_FAILED: dw_codes table is empty/
  );
});

test("verifyOperationalCodeActivation: fails if DR nextSequence is below 50002", async () => {
  const mockClient = {
    query: async (sql: string) => {
      const q = sql.toLowerCase();
      if (q.includes("dw_code_locations")) {
        return { rows: [{ location_id: "loc-1", prefix: "DR", name: "Đạ Ròn", is_active: true, next_sequence: 1 }] };
      }
      if (q.includes("select count(*)::int as count from dw_codes")) {
        return { rows: [{ count: 100 }] };
      }
      if (q.includes("select count(*)::int as count from dw_code_assignments where released_at is null")) {
        return { rows: [{ count: 50 }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => verifyOperationalCodeActivation({ client: mockClient }),
    /VERIFICATION_FAILED: Location 'DR' next_sequence is 1\. Expected >= 50002\./
  );
});
