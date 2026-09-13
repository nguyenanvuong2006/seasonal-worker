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

/** Mirrors operational-code-activation.ts's parseDwCodeFormat regex exactly, kept as a small
 * local stub so this test doesn't have to pull in that whole module's own "@/db"/node:crypto
 * dependency chain just to exercise createDwCodeLocation's fail-closed guard. */
const LEGACY_PARSER_STUB = {
  parseDwCodeFormat: (code: string) => {
    const m = /^([A-Z]{1,8})(\d{1,10})([-_]?)([A-Z0-9]{0,8})$/.exec(code.trim().toUpperCase());
    return m ? { prefix: m[1], sequence: Number(m[2]), separator: m[3], suffix: m[4] } : null;
  },
};

async function loadMod(opts?: { legacyCodes?: string[]; insertedRows?: Record<string, unknown>[] }) {
  const legacyCodes = opts?.legacyCodes ?? [];
  const inserted: unknown[] = [];
  const fakeDb = {
    execute: async () => ({ rows: legacyCodes.map((code) => ({ code })) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: async () => [{ id: "loc-new", ...v }] };
      },
    }),
    select: () => ({
      from: () => ({
        leftJoin: () => Promise.resolve([]),
        where: () => ({ limit: async () => [] }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  };
  const mod = loadModule(new URL("./dw-code-locations-admin.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db: fakeDb },
      "@/db/schema": schemaStub,
      "@/lib/dw-code-pool": { previewDwCode: (c: { prefix: string; sequenceDigits: number; separator: string; suffix: string }, n: number) => `${c.prefix}${String(n).padStart(c.sequenceDigits, "0")}${c.separator}${c.suffix}` },
      "@/lib/operational-code-activation": LEGACY_PARSER_STUB,
    },
  });
  return {
    mod: mod as unknown as {
      validateDwCodeLocationInput: (input: { name: string; prefix: string; sequenceDigits: number; separator: string; suffix: string; startNumber: number }) => { field: string; message: string } | null;
      createDwCodeLocation: (input: { organizationUnitId: string; name: string; prefix: string; sequenceDigits: number; separator: string; suffix: string; startNumber: number; createdBy: string }) => Promise<unknown>;
    },
    inserted,
  };
}

const VALID = { name: "Đông Rồng", prefix: "DR", sequenceDigits: 5, separator: "-", suffix: "D", startNumber: 1 };

test("accepts a well-formed configuration", async () => {
  const { mod } = await loadMod();
  assert.equal(mod.validateDwCodeLocationInput(VALID), null);
});

test("rejects an empty name", async () => {
  const { mod } = await loadMod();
  const err = mod.validateDwCodeLocationInput({ ...VALID, name: "  " });
  assert.equal(err?.field, "name");
});

test("rejects a prefix containing anything but letters/digits (no script/expression input)", async () => {
  const { mod } = await loadMod();
  for (const prefix of ["DR-1", "${x}", "DR ", ""]) {
    const err = mod.validateDwCodeLocationInput({ ...VALID, prefix });
    assert.equal(err?.field, "prefix", `expected prefix "${prefix}" to be rejected`);
  }
});

test("rejects out-of-range sequenceDigits and negative startNumber", async () => {
  const { mod } = await loadMod();
  assert.equal(mod.validateDwCodeLocationInput({ ...VALID, sequenceDigits: 0 })?.field, "sequenceDigits");
  assert.equal(mod.validateDwCodeLocationInput({ ...VALID, sequenceDigits: 11 })?.field, "sequenceDigits");
  assert.equal(mod.validateDwCodeLocationInput({ ...VALID, startNumber: -1 })?.field, "startNumber");
});

/**
 * MISSION F section 41 — fail-closed guard: createDwCodeLocation() must refuse to create a
 * location whose startNumber would collide with a legacy dw_data.code already in use under
 * that prefix, WITHOUT needing a separate diagnostic/report step to catch it first.
 */
const CREATE_INPUT = { organizationUnitId: "org-1", name: "Đạ Ròn", prefix: "DR", sequenceDigits: 5, separator: "-", suffix: "D", startNumber: 1, createdBy: "admin1" };

test("createDwCodeLocation REFUSES an unsafe startNumber when legacy dw_data.code already uses higher sequence numbers under this prefix", async () => {
  const { mod, inserted } = await loadMod({ legacyCodes: ["DR00001-D", "DR01482-D"] });
  await assert.rejects(() => mod.createDwCodeLocation({ ...CREATE_INPUT, startNumber: 1 }), /SEQUENCE_UNSAFE_STARTNUMBER/);
  assert.equal(inserted.length, 0, "must not insert when the guard rejects");
});

test("createDwCodeLocation ACCEPTS a startNumber strictly above the legacy observed maximum", async () => {
  const { mod, inserted } = await loadMod({ legacyCodes: ["DR00001-D", "DR01482-D"] });
  await mod.createDwCodeLocation({ ...CREATE_INPUT, startNumber: 1483 });
  assert.equal(inserted.length, 1);
});

test("createDwCodeLocation ACCEPTS any startNumber when no legacy code exists under this prefix (clean bootstrap)", async () => {
  const { mod, inserted } = await loadMod({ legacyCodes: [] });
  await mod.createDwCodeLocation({ ...CREATE_INPUT, startNumber: 1 });
  assert.equal(inserted.length, 1);
});

test("createDwCodeLocation ignores legacy codes under a DIFFERENT prefix", async () => {
  const { mod, inserted } = await loadMod({ legacyCodes: ["SG00999-D"] }); // different prefix, must not block DR
  await mod.createDwCodeLocation({ ...CREATE_INPUT, startNumber: 1 });
  assert.equal(inserted.length, 1);
});
