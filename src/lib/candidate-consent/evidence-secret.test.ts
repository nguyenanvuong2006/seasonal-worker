/**
 * Runs on the REAL production source via the repo's vm-sandbox loader
 * (imports "server-only", so a plain `node --test` import can't load it
 * directly — same pattern as template-version-edit.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

type EvidenceSecretModule = {
  resolveDocumentEvidenceSecret: () => string;
  isDocumentEvidenceSecretConfigured: () => boolean;
  DocumentEvidenceSecretMissingError: new () => Error;
};

/**
 * Sets env, loads the module AND runs `run` against it (both functions read
 * process.env at CALL time, not at module-load time — so env must still be
 * set while `run` executes), then always restores the original env
 * afterward. (Parameter deliberately not named `use` — eslint-plugin-
 * react-hooks treats any function named/called `use*` as a React Hook call
 * and flags it outside a component/hook, which this plain helper is not.)
 */
function withEnv<T>(env: Record<string, string | undefined>, run: (mod: EvidenceSecretModule) => T): T {
  const originalEnv = { ...process.env };
  // process.env coerces values to strings — assigning `undefined` directly
  // would set the literal string "undefined" instead of unsetting the key.
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const mod = loadModule(new URL("./evidence-secret.ts", import.meta.url), {
      stubs: { "server-only": serverOnlyStub },
    }) as unknown as EvidenceSecretModule;
    return run(mod);
  } finally {
    for (const key of Object.keys(env)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
}

test("resolveDocumentEvidenceSecret: returns the configured DOCUMENT_EVIDENCE_SECRET when set", () => {
  withEnv({ DOCUMENT_EVIDENCE_SECRET: "real-secret-value", NODE_ENV: "production" }, (mod) => {
    assert.equal(mod.resolveDocumentEvidenceSecret(), "real-secret-value");
  });
});

test("resolveDocumentEvidenceSecret: FAILS CLOSED in production when the secret is missing — throws, never falls back", () => {
  withEnv({ DOCUMENT_EVIDENCE_SECRET: undefined, NODE_ENV: "production" }, (mod) => {
    assert.throws(() => mod.resolveDocumentEvidenceSecret(), mod.DocumentEvidenceSecretMissingError);
  });
});

test("resolveDocumentEvidenceSecret: FAILS CLOSED in production when the secret is an empty/whitespace string", () => {
  withEnv({ DOCUMENT_EVIDENCE_SECRET: "   ", NODE_ENV: "production" }, (mod) => {
    assert.throws(() => mod.resolveDocumentEvidenceSecret(), mod.DocumentEvidenceSecretMissingError);
  });
});

test("resolveDocumentEvidenceSecret: outside production, missing secret falls back to a fixed dev/test secret (never throws, never blocks the test suite)", () => {
  withEnv({ DOCUMENT_EVIDENCE_SECRET: undefined, NODE_ENV: "test" }, (mod) => {
    assert.doesNotThrow(() => mod.resolveDocumentEvidenceSecret());
  });
});

test("isDocumentEvidenceSecretConfigured: false in production without the env var — the exact condition PRODUCTION_MISSING_SECRET_FAILS_CLOSED depends on", () => {
  withEnv({ DOCUMENT_EVIDENCE_SECRET: undefined, NODE_ENV: "production" }, (mod) => {
    assert.equal(mod.isDocumentEvidenceSecretConfigured(), false);
  });
});

test("isDocumentEvidenceSecretConfigured: true in production with the env var set", () => {
  withEnv({ DOCUMENT_EVIDENCE_SECRET: "x", NODE_ENV: "production" }, (mod) => {
    assert.equal(mod.isDocumentEvidenceSecretConfigured(), true);
  });
});
