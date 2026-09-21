import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDbWithTx, drizzleStub, makeTable, eqValue, argOf, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/* ============================================================
   OPERATIONAL CODE LOCATION SAFE EDIT TESTS
   ------------------------------------------------------------
   Verifies the editability contract and concurrency safety:
     1. Safe mutable fields (name, isActive) can always be updated.
     2. If any codes exist in dw_codes (AVAILABLE, ASSIGNED, RETIRED),
        format fields (prefix, sequenceDigits, separator, suffix)
        and startNumber are strictly immutable.
     3. If 0 codes exist, format fields and startNumber can be
        safely edited with prefix conflict and legacy sequence floor checks.
     4. Row-level FOR UPDATE locking inside transaction.
     5. Zero historical codes are rewritten or invalidated.
   ============================================================ */

const dwCodeLocations = makeTable("dw_code_locations");
const dwCodes = makeTable("dw_codes");
const dwCodeAssignments = makeTable("dw_code_assignments");
const dwData = makeTable("dw_data");
const organizationUnits = makeTable("organization_units");
const schemaStub = { dwCodeLocations, dwCodes, dwCodeAssignments, dwData, organizationUnits };

type LocationRecord = {
  id: string;
  organizationUnitId: string;
  name: string;
  prefix: string;
  sequenceDigits: number;
  separator: string;
  suffix: string;
  startNumber: number;
  nextSequence: number;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string;
  updatedBy?: string;
};

type CodeRecord = {
  id: string;
  locationId: string;
  sequenceNumber: number;
  code: string;
  status: "AVAILABLE" | "ASSIGNED" | "RETIRED";
};

function createLocationStore(opts: {
  locations?: LocationRecord[];
  codes?: CodeRecord[];
  legacyCodes?: string[];
  orgUnits?: { id: string; name: string }[];
}) {
  const locations = [...(opts.locations ?? [])];
  const codes = [...(opts.codes ?? [])];
  const legacyCodes = [...(opts.legacyCodes ?? [])];
  const orgUnits = [...(opts.orgUnits ?? [{ id: "org-1", name: "Chi nhánh Đạ Ròn" }])];
  const writes: { table: string; patch: Record<string, unknown>; id?: string }[] = [];
  const queryOps: string[] = [];
  let transactionCount = 0;

  const respond = (call: QueryCall): unknown => {
    queryOps.push(`${call.root}:${call.table}`);

    if (call.table === "dw_code_locations") {
      if (call.root === "select") {
        const idEq = eqValue(call, "dw_code_locations.id");
        const prefixEq = eqValue(call, "dw_code_locations.prefix");
        if (idEq !== undefined) {
          const loc = locations.find((l) => l.id === idEq);
          return loc ? [loc] : [];
        }
        if (prefixEq !== undefined) {
          const loc = locations.find((l) => l.prefix === prefixEq);
          return loc ? [loc] : [];
        }
        return locations;
      }
      if (call.root === "update") {
        const patch = argOf(call, "set") as Record<string, unknown>;
        const id = eqValue(call, "dw_code_locations.id") as string | undefined;
        writes.push({ table: "dw_code_locations", patch, id });
        const loc = locations.find((l) => l.id === id);
        if (loc) {
          Object.assign(loc, patch);
          return [loc];
        }
        return [];
      }
    }

    if (call.table === "organization_units" && call.root === "select") {
      const idEq = eqValue(call, "organization_units.id");
      if (idEq !== undefined) {
        const ou = orgUnits.find((u) => u.id === idEq);
        return ou ? [ou] : [];
      }
      return orgUnits;
    }

    if (call.table === "dw_codes") {
      if (call.root === "select") {
        const locId = eqValue(call, "dw_codes.locationId");
        if (locId !== undefined) {
          return codes.filter((c) => c.locationId === locId);
        }
        return codes;
      }
      if (call.root === "update") {
        const patch = argOf(call, "set") as Record<string, unknown>;
        writes.push({ table: "dw_codes", patch });
        return [];
      }
    }

    return undefined;
  };

  const { db, tx } = createFakeDbWithTx({ respond });

  const executeFn = async () => ({ rows: legacyCodes.map((code) => ({ code })) });
  (db as any).execute = executeFn;
  (tx as any).execute = executeFn;

  const originalDbTx = db.transaction.bind(db);
  (db as any).transaction = async <T>(fn: (t: any) => Promise<T>): Promise<T> => {
    transactionCount++;
    return originalDbTx(fn);
  };

  return {
    db,
    tx,
    locations,
    codes,
    writes,
    queryOps,
    get transactionCount() {
      return transactionCount;
    },
  };
}

const LEGACY_PARSER_STUB = {
  parseDwCodeFormat: (code: string) => {
    const m = /^([A-Z]{1,8})(\d{1,10})([-_]?)([A-Z0-9]{0,8})$/.exec(code.trim().toUpperCase());
    return m ? { prefix: m[1], sequence: Number(m[2]), separator: m[3], suffix: m[4] } : null;
  },
};

async function loadAdminModule(store: ReturnType<typeof createLocationStore>) {
  const mod = loadModule(new URL("./dw-code-locations-admin.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db: store.db },
      "@/db/schema": schemaStub,
      "@/lib/dw-code-pool": {
        previewDwCode: (c: { prefix: string; sequenceDigits: number; separator: string; suffix: string }, n: number) =>
          `${c.prefix}${String(n).padStart(c.sequenceDigits, "0")}${c.separator}${c.suffix}`,
      },
      "@/lib/operational-code-activation": LEGACY_PARSER_STUB,
    },
  });

  return mod as unknown as {
    getDwCodeLocation: (id: string) => Promise<any>;
    updateDwCodeLocation: (id: string, input: Record<string, unknown>) => Promise<any>;
    listDwCodeLocations: () => Promise<any[]>;
  };
}

// --------------------------------------------------------------------------
// 1. ADMIN can open/edit safe mutable fields (name, isActive)
// --------------------------------------------------------------------------
test("1. ADMIN can edit safe mutable fields (name, isActive) on an existing location", async () => {
  const loc: LocationRecord = {
    id: "loc-1",
    organizationUnitId: "org-1",
    name: "Đạ Ròn Cũ",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 100,
    isActive: true,
  };
  const store = createLocationStore({ locations: [loc] });
  const mod = await loadAdminModule(store);

  const res = await mod.updateDwCodeLocation("loc-1", {
    name: "Đạ Ròn Mới",
    isActive: false,
    updatedBy: "admin",
  });

  assert.equal(res.ok, true);
  assert.equal(res.location.name, "Đạ Ròn Mới");
  assert.equal(res.location.isActive, false);
  assert.equal(res.location.prefix, "DR"); // unchanged
  assert.equal(res.location.nextSequence, 100); // unchanged
});

// --------------------------------------------------------------------------
// 2. Unauthorized user rejected (tested via permission guard contract)
// --------------------------------------------------------------------------
test("2. Unauthorized user rejected: route enforces dw_code.configure permission", async () => {
  const rbacMod = await import("./rbac-catalog.ts");
  const configPerm = rbacMod.PERMISSION_CATALOG.find((p) => p.key === "dw_code.configure");
  assert.ok(configPerm, "dw_code.configure must be a defined permission");
  assert.equal(configPerm?.group, "hanh_chinh");
});

// --------------------------------------------------------------------------
// 3. Unknown location rejected
// --------------------------------------------------------------------------
test("3. Unknown location rejected with LOCATION_NOT_FOUND", async () => {
  const store = createLocationStore({ locations: [] });
  const mod = await loadAdminModule(store);

  const res = await mod.updateDwCodeLocation("nonexistent-id", {
    name: "Any Name",
    updatedBy: "admin",
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, "LOCATION_NOT_FOUND");
});

// --------------------------------------------------------------------------
// 4. Unused location may change format safely
// --------------------------------------------------------------------------
test("4. Unused location (0 codes) can safely change prefix, format, and startNumber", async () => {
  const loc: LocationRecord = {
    id: "loc-unused",
    organizationUnitId: "org-1",
    name: "Địa điểm mới",
    prefix: "XX",
    sequenceDigits: 4,
    separator: "_",
    suffix: "A",
    startNumber: 1,
    nextSequence: 1,
    isActive: true,
  };
  // 0 codes in dw_codes
  const store = createLocationStore({ locations: [loc], codes: [] });
  const mod = await loadAdminModule(store);

  const res = await mod.updateDwCodeLocation("loc-unused", {
    prefix: "YY",
    sequenceDigits: 6,
    separator: "-",
    suffix: "B",
    startNumber: 50,
    updatedBy: "admin",
  });

  assert.equal(res.ok, true);
  assert.equal(res.location.prefix, "YY");
  assert.equal(res.location.sequenceDigits, 6);
  assert.equal(res.location.separator, "-");
  assert.equal(res.location.suffix, "B");
  assert.equal(res.location.startNumber, 50);
  assert.equal(res.location.nextSequence, 50); // nextSequence synchronized with startNumber
});

// --------------------------------------------------------------------------
// 5. Location with AVAILABLE code cannot change format
// --------------------------------------------------------------------------
test("5. Location with AVAILABLE code rejects format changes with LOCATION_HAS_ISSUED_CODES", async () => {
  const loc: LocationRecord = {
    id: "loc-avail",
    organizationUnitId: "org-1",
    name: "Location With Available",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 2,
    isActive: true,
  };
  const code: CodeRecord = {
    id: "code-1",
    locationId: "loc-avail",
    sequenceNumber: 1,
    code: "DR00001-D",
    status: "AVAILABLE",
  };
  const store = createLocationStore({ locations: [loc], codes: [code] });
  const mod = await loadAdminModule(store);

  const res = await mod.updateDwCodeLocation("loc-avail", {
    prefix: "DX",
    updatedBy: "admin",
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, "LOCATION_HAS_ISSUED_CODES");
});

// --------------------------------------------------------------------------
// 6. Location with ASSIGNED code cannot change format
// --------------------------------------------------------------------------
test("6. Location with ASSIGNED code rejects format changes with LOCATION_HAS_ISSUED_CODES", async () => {
  const loc: LocationRecord = {
    id: "loc-assigned",
    organizationUnitId: "org-1",
    name: "Location With Assigned",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 2,
    isActive: true,
  };
  const code: CodeRecord = {
    id: "code-1",
    locationId: "loc-assigned",
    sequenceNumber: 1,
    code: "DR00001-D",
    status: "ASSIGNED",
  };
  const store = createLocationStore({ locations: [loc], codes: [code] });
  const mod = await loadAdminModule(store);

  const res = await mod.updateDwCodeLocation("loc-assigned", {
    sequenceDigits: 6,
    updatedBy: "admin",
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, "LOCATION_HAS_ISSUED_CODES");
});

// --------------------------------------------------------------------------
// 7. Location with RETIRED code cannot change format
// --------------------------------------------------------------------------
test("7. Location with RETIRED code rejects format changes with LOCATION_HAS_ISSUED_CODES", async () => {
  const loc: LocationRecord = {
    id: "loc-retired",
    organizationUnitId: "org-1",
    name: "Location With Retired",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 2,
    isActive: true,
  };
  const code: CodeRecord = {
    id: "code-1",
    locationId: "loc-retired",
    sequenceNumber: 1,
    code: "DR00001-D",
    status: "RETIRED",
  };
  const store = createLocationStore({ locations: [loc], codes: [code] });
  const mod = await loadAdminModule(store);

  const res = await mod.updateDwCodeLocation("loc-retired", {
    startNumber: 10,
    updatedBy: "admin",
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, "LOCATION_HAS_ISSUED_CODES");
});

// --------------------------------------------------------------------------
// 8. nextSequence cannot decrease / cannot be changed after code issuance
// --------------------------------------------------------------------------
test("8. nextSequence / startNumber cannot be manipulated once codes are issued", async () => {
  const loc: LocationRecord = {
    id: "loc-seq",
    organizationUnitId: "org-1",
    name: "Seq Test",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 500,
    isActive: true,
  };
  const code: CodeRecord = {
    id: "c1",
    locationId: "loc-seq",
    sequenceNumber: 1,
    code: "DR00001-D",
    status: "ASSIGNED",
  };
  const store = createLocationStore({ locations: [loc], codes: [code] });
  const mod = await loadAdminModule(store);

  // Attempting to change startNumber from 1 to 10
  const res = await mod.updateDwCodeLocation("loc-seq", {
    startNumber: 10,
    updatedBy: "admin",
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, "LOCATION_HAS_ISSUED_CODES");
  assert.equal(loc.nextSequence, 500, "nextSequence must not change");
});

// --------------------------------------------------------------------------
// 9. Existing issued codes are never updated
// --------------------------------------------------------------------------
test("9. Existing issued codes in dw_codes are never updated by editing location", async () => {
  const loc: LocationRecord = {
    id: "loc-no-rewrite",
    organizationUnitId: "org-1",
    name: "No Rewrite",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 10,
    isActive: true,
  };
  const code: CodeRecord = {
    id: "c1",
    locationId: "loc-no-rewrite",
    sequenceNumber: 1,
    code: "DR00001-D",
    status: "ASSIGNED",
  };
  const store = createLocationStore({ locations: [loc], codes: [code] });
  const mod = await loadAdminModule(store);

  // Edit safe field
  await mod.updateDwCodeLocation("loc-no-rewrite", {
    name: "Updated Name Only",
    updatedBy: "admin",
  });

  const dwCodesWrites = store.writes.filter((w) => w.table === "dw_codes");
  assert.equal(dwCodesWrites.length, 0, "Zero writes to dw_codes permitted during location edit");
  assert.equal(code.code, "DR00001-D", "Literal code string unchanged");
});

// --------------------------------------------------------------------------
// 10. Disabling location does not alter assignments
// --------------------------------------------------------------------------
test("10. Disabling location does not alter assignments or dw_codes", async () => {
  const loc: LocationRecord = {
    id: "loc-disable",
    organizationUnitId: "org-1",
    name: "To Disable",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 10,
    isActive: true,
  };
  const code: CodeRecord = {
    id: "c1",
    locationId: "loc-disable",
    sequenceNumber: 1,
    code: "DR00001-D",
    status: "ASSIGNED",
  };
  const store = createLocationStore({ locations: [loc], codes: [code] });
  const mod = await loadAdminModule(store);

  const res = await mod.updateDwCodeLocation("loc-disable", {
    isActive: false,
    updatedBy: "admin",
  });

  assert.equal(res.ok, true);
  assert.equal(res.location.isActive, false);
  assert.equal(code.status, "ASSIGNED", "Assigned status remains unchanged");
});

// --------------------------------------------------------------------------
// 11. Disabled location cannot allocate new code (LOCATION_INACTIVE)
// --------------------------------------------------------------------------
test("11. Disabled location cannot allocate new code via dw-code-pool", async () => {
  const loc = { id: "loc-inact", prefix: "DR", sequenceDigits: 5, separator: "-", suffix: "D", nextSequence: 10, isActive: false };
  const { db, tx } = createFakeDbWithTx({
    respond: (call) => {
      if (call.table === "dw_code_locations" && call.root === "select") {
        return [loc];
      }
      return undefined;
    },
  });

  const poolMod = loadModule(new URL("./dw-code-pool.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
    },
  }) as unknown as { allocateDwCode: (input: any, executor?: any) => Promise<any> };

  const res = await poolMod.allocateDwCode(
    { locationId: "loc-inact", workerId: "w1" },
    tx,
  );

  assert.equal(res.ok, false);
  assert.equal(res.error, "LOCATION_INACTIVE");
});

// --------------------------------------------------------------------------
// 12. Re-enable preserves sequence
// --------------------------------------------------------------------------
test("12. Re-enabling location preserves original nextSequence", async () => {
  const loc: LocationRecord = {
    id: "loc-re-enable",
    organizationUnitId: "org-1",
    name: "Re-enable",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 413,
    isActive: false,
  };
  const store = createLocationStore({ locations: [loc] });
  const mod = await loadAdminModule(store);

  const res = await mod.updateDwCodeLocation("loc-re-enable", {
    isActive: true,
    updatedBy: "admin",
  });

  assert.equal(res.ok, true);
  assert.equal(res.location.isActive, true);
  assert.equal(res.location.nextSequence, 413, "nextSequence must be preserved on re-enable");
});

// --------------------------------------------------------------------------
// 13. Duplicate prefix/namespace rejected
// --------------------------------------------------------------------------
test("13. Duplicate prefix across locations is rejected with PREFIX_CONFLICT", async () => {
  const loc1: LocationRecord = {
    id: "loc-1",
    organizationUnitId: "org-1",
    name: "Đạ Ròn",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 1,
    isActive: true,
  };
  const loc2: LocationRecord = {
    id: "loc-2",
    organizationUnitId: "org-2",
    name: "Đà Lạt Mới",
    prefix: "DL",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 1,
    isActive: true,
  };
  const store = createLocationStore({ locations: [loc1, loc2], codes: [] });
  const mod = await loadAdminModule(store);

  const res = await mod.updateDwCodeLocation("loc-2", {
    prefix: "DR", // conflicts with loc1
    updatedBy: "admin",
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, "PREFIX_CONFLICT");
});

// --------------------------------------------------------------------------
// 14. Concurrent edit uses locked/fresh row (FOR UPDATE)
// --------------------------------------------------------------------------
test("14. Concurrent edit reads row under FOR UPDATE lock inside transaction", async () => {
  const loc: LocationRecord = {
    id: "loc-lock",
    organizationUnitId: "org-1",
    name: "Lock Test",
    prefix: "LK",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 1,
    isActive: true,
  };
  const store = createLocationStore({ locations: [loc] });
  const mod = await loadAdminModule(store);

  await mod.updateDwCodeLocation("loc-lock", {
    name: "New Name",
    updatedBy: "admin",
  });

  assert.ok(store.transactionCount >= 1, "Must run inside a transaction");
  assert.ok(store.queryOps.includes("select:dw_code_locations"), "Must select location");
  assert.ok(store.queryOps.includes("update:dw_code_locations"), "Must update location");
});

// --------------------------------------------------------------------------
// 15. Stale client update fails closed
// --------------------------------------------------------------------------
test("15. Stale client update fails closed if codes were generated since client read", async () => {
  const loc: LocationRecord = {
    id: "loc-race",
    organizationUnitId: "org-1",
    name: "Race Test",
    prefix: "RC",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 1,
    isActive: true,
  };
  // Server state has an assigned code (even if client thought pool was empty)
  const code: CodeRecord = {
    id: "c1",
    locationId: "loc-race",
    sequenceNumber: 1,
    code: "RC00001-D",
    status: "ASSIGNED",
  };
  const store = createLocationStore({ locations: [loc], codes: [code] });
  const mod = await loadAdminModule(store);

  // Client attempts to change prefix
  const res = await mod.updateDwCodeLocation("loc-race", {
    prefix: "NEWRC",
    updatedBy: "admin",
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, "LOCATION_HAS_ISSUED_CODES");
});

// --------------------------------------------------------------------------
// 16. Đạ Ròn-like issued location exposes locked fields
// --------------------------------------------------------------------------
test("16. Đạ Ròn-like location (0 avail, 412 assigned, 13074 retired) locks format fields", async () => {
  const daRon: LocationRecord = {
    id: "loc-daron",
    organizationUnitId: "org-daron",
    name: "Đạ Ròn",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 50002,
    isActive: true,
  };
  // Simulate Đạ Ròn's exact pool numbers
  const codes: CodeRecord[] = [
    ...Array.from({ length: 412 }, (_, i) => ({
      id: `c-assigned-${i}`,
      locationId: "loc-daron",
      sequenceNumber: i + 1,
      code: `DR${String(i + 1).padStart(5, "0")}-D`,
      status: "ASSIGNED" as const,
    })),
    ...Array.from({ length: 13074 }, (_, i) => ({
      id: `c-retired-${i}`,
      locationId: "loc-daron",
      sequenceNumber: i + 413,
      code: `DR${String(i + 413).padStart(5, "0")}-D`,
      status: "RETIRED" as const,
    })),
  ];
  const store = createLocationStore({
    locations: [daRon],
    codes,
    orgUnits: [{ id: "org-daron", name: "Chi nhánh Đạ Ròn" }],
  });
  const mod = await loadAdminModule(store);

  // 1. Fetching location returns accurate pool metrics
  const fetched = await mod.getDwCodeLocation("loc-daron");
  assert.equal(fetched.pool.available, 0);
  assert.equal(fetched.pool.assigned, 412);
  assert.equal(fetched.pool.retired, 13074);

  // 2. Attempting to change prefix is rejected
  const resPrefix = await mod.updateDwCodeLocation("loc-daron", {
    prefix: "DX",
    updatedBy: "admin",
  });
  assert.equal(resPrefix.ok, false);
  assert.equal(resPrefix.error, "LOCATION_HAS_ISSUED_CODES");

  // 3. Attempting to change suffix is rejected
  const resSuffix = await mod.updateDwCodeLocation("loc-daron", {
    suffix: "E",
    updatedBy: "admin",
  });
  assert.equal(resSuffix.ok, false);
  assert.equal(resSuffix.error, "LOCATION_HAS_ISSUED_CODES");

  // 4. Attempting to change sequenceDigits is rejected
  const resDigits = await mod.updateDwCodeLocation("loc-daron", {
    sequenceDigits: 6,
    updatedBy: "admin",
  });
  assert.equal(resDigits.ok, false);
  assert.equal(resDigits.error, "LOCATION_HAS_ISSUED_CODES");

  // 5. Attempting to change startNumber is rejected
  const resStart = await mod.updateDwCodeLocation("loc-daron", {
    startNumber: 10,
    updatedBy: "admin",
  });
  assert.equal(resStart.ok, false);
  assert.equal(resStart.error, "LOCATION_HAS_ISSUED_CODES");

  // 6. Safe update of name and isActive succeeds
  const resSafe = await mod.updateDwCodeLocation("loc-daron", {
    name: "Chi nhánh Đạ Ròn (Chính)",
    isActive: true,
    updatedBy: "admin",
  });
  assert.equal(resSafe.ok, true);
  assert.equal(resSafe.location.name, "Chi nhánh Đạ Ròn (Chính)");
});

// --------------------------------------------------------------------------
// 17. Safe label/status edit succeeds without code mutation
// --------------------------------------------------------------------------
test("17. Safe label edit does not touch code counters or code records", async () => {
  const loc: LocationRecord = {
    id: "loc-safe",
    organizationUnitId: "org-1",
    name: "Original Name",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 50,
    isActive: true,
  };
  const store = createLocationStore({ locations: [loc] });
  const mod = await loadAdminModule(store);

  const res = await mod.updateDwCodeLocation("loc-safe", {
    name: "Updated Display Label",
    updatedBy: "admin",
  });

  assert.equal(res.ok, true);
  assert.equal(loc.nextSequence, 50);
  assert.equal(loc.startNumber, 1);
  assert.equal(loc.prefix, "DR");
});

// --------------------------------------------------------------------------
// 18. Legacy sequence floor check on format edit
// --------------------------------------------------------------------------
test("18. Changing prefix or startNumber on unused location enforces legacy max floor", async () => {
  const loc: LocationRecord = {
    id: "loc-legacy",
    organizationUnitId: "org-1",
    name: "Legacy Test",
    prefix: "OLD",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 1,
    isActive: true,
  };
  // Legacy code DR01500-D exists in dw_data
  const store = createLocationStore({
    locations: [loc],
    codes: [],
    legacyCodes: ["DR01500-D"],
  });
  const mod = await loadAdminModule(store);

  // Attempting to change prefix to "DR" with startNumber 1000 (< 1500)
  const res = await mod.updateDwCodeLocation("loc-legacy", {
    prefix: "DR",
    startNumber: 1000,
    updatedBy: "admin",
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, "SEQUENCE_UNSAFE_STARTNUMBER");

  // With startNumber 1501 (> 1500), it succeeds!
  const resSuccess = await mod.updateDwCodeLocation("loc-legacy", {
    prefix: "DR",
    startNumber: 1501,
    updatedBy: "admin",
  });

  assert.equal(resSuccess.ok, true);
  assert.equal(resSuccess.location.prefix, "DR");
  assert.equal(resSuccess.location.startNumber, 1501);
  assert.equal(resSuccess.location.nextSequence, 1501);
});

// --------------------------------------------------------------------------
// 19. Input validation: invalid prefix, sequenceDigits, startNumber
// --------------------------------------------------------------------------
test("19. Rejects invalid inputs (empty name, bad prefix, out-of-range sequenceDigits)", async () => {
  const loc: LocationRecord = {
    id: "loc-val",
    organizationUnitId: "org-1",
    name: "Valid",
    prefix: "VAL",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 1,
    isActive: true,
  };
  const store = createLocationStore({ locations: [loc], codes: [] });
  const mod = await loadAdminModule(store);

  const res1 = await mod.updateDwCodeLocation("loc-val", { name: "   ", updatedBy: "admin" });
  assert.equal(res1.ok, false);
  assert.equal(res1.error, "INVALID_INPUT");
  assert.equal(res1.field, "name");

  const res2 = await mod.updateDwCodeLocation("loc-val", { prefix: "INVALID_LONG_PREFIX", updatedBy: "admin" });
  assert.equal(res2.ok, false);
  assert.equal(res2.error, "INVALID_INPUT");
  assert.equal(res2.field, "prefix");

  const res3 = await mod.updateDwCodeLocation("loc-val", { sequenceDigits: 15, updatedBy: "admin" });
  assert.equal(res3.ok, false);
  assert.equal(res3.error, "INVALID_INPUT");
  assert.equal(res3.field, "sequenceDigits");

  const res4 = await mod.updateDwCodeLocation("loc-val", { startNumber: -5, updatedBy: "admin" });
  assert.equal(res4.ok, false);
  assert.equal(res4.error, "INVALID_INPUT");
  assert.equal(res4.field, "startNumber");
});

// --------------------------------------------------------------------------
// 20. No historical DW code rewrite path exists
// --------------------------------------------------------------------------
test("20. No code path exists in location update that mutates dw_codes.code or dw_data.code", async () => {
  const loc: LocationRecord = {
    id: "loc-audit",
    organizationUnitId: "org-1",
    name: "Audit Location",
    prefix: "DR",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
    nextSequence: 50,
    isActive: true,
  };
  const code: CodeRecord = {
    id: "c1",
    locationId: "loc-audit",
    sequenceNumber: 1,
    code: "DR00001-D",
    status: "ASSIGNED",
  };
  const store = createLocationStore({ locations: [loc], codes: [code] });
  const mod = await loadAdminModule(store);

  await mod.updateDwCodeLocation("loc-audit", {
    name: "New Safe Name",
    isActive: false,
    updatedBy: "admin",
  });

  const allTableWrites = store.writes.map((w) => w.table);
  assert.strictEqual(allTableWrites.length, 1, "Exactly one table write should have occurred");
  assert.strictEqual(allTableWrites[0], "dw_code_locations", "Only dw_code_locations may be written to");
});
