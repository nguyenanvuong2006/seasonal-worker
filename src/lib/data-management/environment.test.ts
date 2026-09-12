import test from "node:test";
import assert from "node:assert/strict";
import { checkDataResetAllowed, resolveDataManagementEnvironment } from "./environment.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("R12 — Production disabled by default: VERCEL_ENV=production with no ALLOW_PRODUCTION_DATA_RESET blocks reset", () => {
  withEnv({ VERCEL_ENV: "production", ALLOW_PRODUCTION_DATA_RESET: undefined, DATA_RESET_MODE: undefined }, () => {
    const result = checkDataResetAllowed();
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.environment, "production");
  });
});

test("Production stays blocked even if ALLOW_PRODUCTION_DATA_RESET is truthy-but-not-exact-'true' (e.g. '1', 'yes')", () => {
  withEnv({ VERCEL_ENV: "production", ALLOW_PRODUCTION_DATA_RESET: "1", DATA_RESET_MODE: undefined }, () => {
    const result = checkDataResetAllowed();
    assert.equal(result.allowed, false);
  });
});

test("Production only unlocks with the exact opt-in flag set to 'true' (never set by this mission, but the mechanism is correct)", () => {
  withEnv({ VERCEL_ENV: "production", ALLOW_PRODUCTION_DATA_RESET: "true", DATA_RESET_MODE: undefined }, () => {
    const result = checkDataResetAllowed();
    assert.equal(result.allowed, true);
  });
});

test("Preview deployments (VERCEL_ENV=preview) are NOT treated as Production — NODE_ENV=production alone must not misclassify a Vercel preview build", () => {
  withEnv({ VERCEL_ENV: "preview", NODE_ENV: "production" as never, ALLOW_PRODUCTION_DATA_RESET: undefined, DATA_RESET_MODE: undefined }, () => {
    const result = checkDataResetAllowed();
    assert.equal(result.environment, "preview");
    assert.equal(result.allowed, true);
  });
});

test("Local dev (no VERCEL_ENV, NODE_ENV unset/development) is allowed by the environment guard", () => {
  withEnv({ VERCEL_ENV: undefined, NODE_ENV: "development" as never, ALLOW_PRODUCTION_DATA_RESET: undefined, DATA_RESET_MODE: undefined }, () => {
    const result = checkDataResetAllowed();
    assert.equal(resolveDataManagementEnvironment(), "development");
    assert.equal(result.allowed, true);
  });
});

test("Go-live lock (DATA_RESET_MODE=DISABLED) blocks reset in EVERY environment, including local dev — not bypassable by role or environment", () => {
  withEnv({ VERCEL_ENV: undefined, NODE_ENV: "development" as never, DATA_RESET_MODE: "DISABLED", ALLOW_PRODUCTION_DATA_RESET: undefined }, () => {
    const result = checkDataResetAllowed();
    assert.equal(result.allowed, false);
  });
  withEnv({ VERCEL_ENV: "production", DATA_RESET_MODE: "DISABLED", ALLOW_PRODUCTION_DATA_RESET: "true" }, () => {
    const result = checkDataResetAllowed();
    assert.equal(result.allowed, false, "DATA_RESET_MODE=DISABLED overrides even an explicit Production opt-in");
  });
});
