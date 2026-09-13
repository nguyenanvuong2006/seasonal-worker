import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";
import { drizzleStub, makeTable } from "./test-support/fake-drizzle.ts";

/**
 * MISSION E section 5 — no arbitrary script/expression input for prefix/
 * separator/suffix (plain fixed strings only), and sane bounds on
 * sequenceDigits/startNumber.
 */

const schemaStub = { dwCodeLocations: makeTable("dw_code_locations"), dwCodes: makeTable("dw_codes"), organizationUnits: makeTable("organization_units") };

async function loadMod() {
  const mod = loadModule(new URL("./dw-code-locations-admin.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db: {} },
      "@/db/schema": schemaStub,
      "@/lib/dw-code-pool": { previewDwCode: (c: { prefix: string; sequenceDigits: number; separator: string; suffix: string }, n: number) => `${c.prefix}${String(n).padStart(c.sequenceDigits, "0")}${c.separator}${c.suffix}` },
    },
  });
  return mod as unknown as {
    validateDwCodeLocationInput: (input: { name: string; prefix: string; sequenceDigits: number; separator: string; suffix: string; startNumber: number }) => { field: string; message: string } | null;
  };
}

const VALID = { name: "Đông Rồng", prefix: "DR", sequenceDigits: 5, separator: "-", suffix: "D", startNumber: 1 };

test("accepts a well-formed configuration", async () => {
  const mod = await loadMod();
  assert.equal(mod.validateDwCodeLocationInput(VALID), null);
});

test("rejects an empty name", async () => {
  const mod = await loadMod();
  const err = mod.validateDwCodeLocationInput({ ...VALID, name: "  " });
  assert.equal(err?.field, "name");
});

test("rejects a prefix containing anything but letters/digits (no script/expression input)", async () => {
  const mod = await loadMod();
  for (const prefix of ["DR-1", "${x}", "DR ", ""]) {
    const err = mod.validateDwCodeLocationInput({ ...VALID, prefix });
    assert.equal(err?.field, "prefix", `expected prefix "${prefix}" to be rejected`);
  }
});

test("rejects out-of-range sequenceDigits and negative startNumber", async () => {
  const mod = await loadMod();
  assert.equal(mod.validateDwCodeLocationInput({ ...VALID, sequenceDigits: 0 })?.field, "sequenceDigits");
  assert.equal(mod.validateDwCodeLocationInput({ ...VALID, sequenceDigits: 11 })?.field, "sequenceDigits");
  assert.equal(mod.validateDwCodeLocationInput({ ...VALID, startNumber: -1 })?.field, "startNumber");
});
