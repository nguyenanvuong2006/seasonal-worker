/**
 * REGRESSION TESTS — scripts/provision-merge-worker-watchdog.sh CLI
 * compatibility fix (2026-09-03).
 *
 * The script previously used `--headers-from-file` for
 * `gcloud scheduler jobs create/update http`, which does not exist for that
 * command (verified against the live gcloud CLI reference, not assumed) —
 * every real production run failed with "unrecognized arguments:
 * --headers-from-file". These tests read the ACTUAL script source (never a
 * copy) and assert the fix's required properties, matching this repo's
 * established structural-test pattern (see routes-wiring.test.ts,
 * v7-incident-recovery.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/provision-merge-worker-watchdog.sh";

function readScript(): string {
  return readFileSync(join(ROOT, SCRIPT_PATH), "utf8");
}

/** Strip shell comments (# ...) so assertions can't accidentally match prose. */
function stripShellComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("#");
      // Crude but sufficient here: this script has no '#' inside a quoted
      // string on any line that matters to these tests.
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

test("1. unsupported --headers-from-file is gone from executable code (a comment explaining WHY it's unsupported may still name it)", () => {
  assert.doesNotMatch(stripShellComments(readScript()), /--headers-from-file/);
});

test("2. create http uses the supported inline --headers=KEY=VALUE mechanism", () => {
  const code = stripShellComments(readScript());
  const createStart = code.indexOf("gcloud scheduler jobs create http");
  const createEnd = code.indexOf("echo \"✅", createStart);
  const createBlock = code.slice(createStart, createEnd);
  assert.match(createBlock, /--headers\s+"?\$\{AUTH_HEADER\}"?/);
});

test("2b. update http uses the supported --update-headers mechanism (not --headers, which would replace the whole set)", () => {
  const code = stripShellComments(readScript());
  const updateBlock = code.slice(code.indexOf("gcloud scheduler jobs update http"), code.indexOf("gcloud scheduler jobs create http"));
  assert.match(updateBlock, /--update-headers\s+"?\$\{AUTH_HEADER\}"?/);
  assert.doesNotMatch(updateBlock, /\s--headers\s/, "update path must use --update-headers, not --headers");
});

test("3. the Authorization: Bearer <secret> header is still configured, alongside Content-Type", () => {
  const code = readScript();
  assert.match(code, /AUTH_HEADER="Authorization=Bearer \$\{SECRET_VALUE\},Content-Type=application\/json"/);
});

test("4. the secret value is never echoed/printed by the script, and xtrace is never enabled", () => {
  const code = stripShellComments(readScript());
  // No bare `echo "${SECRET_VALUE}"` (or similar) anywhere.
  assert.doesNotMatch(code, /echo\s+"?\$\{?SECRET_VALUE\}?"?\s*$/m);
  // set -x / set -o xtrace would dump every command (including the one
  // embedding AUTH_HEADER) to stdout — must never be enabled.
  assert.doesNotMatch(code, /set\s+-.*x/);
  assert.doesNotMatch(code, /set\s+-o\s+xtrace/);
});

test("4b. the fetched secret is registered for GitHub Actions log masking, guarded to CI only", () => {
  const code = readScript();
  assert.match(code, /if \[\[ "\$\{GITHUB_ACTIONS:-\}" == "true" \]\]; then/);
  assert.match(code, /echo "::add-mask::\$\{SECRET_VALUE\}"/);
});

test("5. OIDC service account (RUNTIME_SA) remains configured on both create and update paths", () => {
  const code = stripShellComments(readScript());
  const matches = code.match(/--oidc-service-account-email\s+"\$\{RUNTIME_SA\}"/g) ?? [];
  assert.equal(matches.length, 2, "expected --oidc-service-account-email on both the create and update gcloud invocations");
});

test("6. OIDC token audience remains WORKER_URL on both create and update paths", () => {
  const code = stripShellComments(readScript());
  const matches = code.match(/--oidc-token-audience\s+"\$\{WORKER_URL\}"/g) ?? [];
  assert.equal(matches.length, 2, "expected --oidc-token-audience on both the create and update gcloud invocations");
});

test("7. default schedule remains */5 * * * *", () => {
  assert.match(readScript(), /SCHEDULE="\$\{SCHEDULE:-\*\/5 \* \* \* \*\}"/);
});

test("8. default job name remains merge-worker-watchdog", () => {
  assert.match(readScript(), /JOB_NAME="\$\{JOB_NAME:-merge-worker-watchdog\}"/);
});

test("9. create-or-update idempotency structure is preserved (describe, then branch create vs update)", () => {
  const code = readScript();
  const describeIdx = code.indexOf("gcloud scheduler jobs describe");
  const updateIdx = code.indexOf("gcloud scheduler jobs update http");
  const createIdx = code.indexOf("gcloud scheduler jobs create http");
  assert.ok(describeIdx >= 0 && updateIdx > describeIdx, "describe must run before the update branch");
  assert.ok(createIdx > updateIdx, "create branch must be the else-arm, after the update branch");
});

test("10. staging/production boundary guardrail is intact (Guardrail 4)", () => {
  const code = readScript();
  assert.match(code, /Guardrail 4/);
  assert.match(code, /LOWER_URL[\s\S]*\*staging\*[\s\S]*LOWER_SA[\s\S]*\*staging\*/);
});

test("script still requires explicit --yes confirmation (Guardrail 1) and required params (Guardrail 2)", () => {
  const code = readScript();
  assert.match(code, /Guardrail 1/);
  assert.match(code, /"\$\{1:-\}" != "--yes"/);
  assert.match(code, /Guardrail 2/);
  assert.match(code, /-z "\$\{PROJECT_ID\}" \|\| -z "\$\{WORKER_URL\}" \|\| -z "\$\{RUNTIME_SA\}"/);
});

test("secret is read from Secret Manager directly, never accepted as a plain env var or CLI arg", () => {
  const code = readScript();
  assert.match(code, /gcloud secrets versions access latest/);
  assert.match(code, /--secret="\$\{SECRET_NAME\}"/);
  // SECRET_VALUE must never be settable from an env var the way
  // PROJECT_ID/WORKER_URL/RUNTIME_SA/SECRET_NAME are (`"${X:-...}"` pattern).
  assert.doesNotMatch(code, /SECRET_VALUE="\$\{SECRET_VALUE/);
});
