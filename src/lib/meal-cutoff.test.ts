import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";
import { createFakeDb, drizzleStub, makeTable, argOf, type QueryCall } from "./test-support/fake-drizzle.ts";

/**
 * MISSION E — Meal cutoff (sections 15-18). `isPastCutoff` is pure string
 * comparison; `excludeFromMeal` decides CANCELLED_BEFORE_CUTOFF vs
 * REPORTED_AFTER_MEAL_CUTOFF and must NEVER insert an exclusion row after
 * the cutoff (never falsely claim a meal was cancelled).
 */

const mealCutoffSettings = makeTable("meal_cutoff_settings");
const mealExclusions = makeTable("meal_exclusions");
const schemaStub = { mealCutoffSettings, mealExclusions };

function makeStore(cutoffTime: string) {
  const inserted: unknown[] = [];
  const respond = (call: QueryCall): unknown => {
    if (call.table === "meal_cutoff_settings" && call.root === "select") {
      return [{ id: "default", cutoffTime, updatedAt: null, updatedBy: null }];
    }
    if (call.table === "meal_exclusions" && call.root === "insert") {
      inserted.push(argOf(call, "values"));
      return [{}];
    }
    return undefined;
  };
  const db = createFakeDb({ respond });
  return { db, inserted };
}

async function loadWith(store: ReturnType<typeof makeStore>) {
  const mod = loadModule(new URL("./meal-cutoff.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db: store.db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": { toVNTimeStr: (d: Date) => (globalThis as unknown as { __vnTime: string }).__vnTime ?? d.toISOString().slice(11, 16) },
    },
  });
  return mod as unknown as {
    isPastCutoff: (cutoffTime: string, now?: Date) => boolean;
    excludeFromMeal: (input: Record<string, unknown>) => Promise<{ outcome: string }>;
  };
}

test("isPastCutoff compares zero-padded HH:MM strings correctly", async () => {
  const store = makeStore("10:00");
  const mod = await loadWith(store);
  (globalThis as unknown as { __vnTime: string }).__vnTime = "09:59";
  assert.equal(mod.isPastCutoff("10:00", new Date()), false);
  (globalThis as unknown as { __vnTime: string }).__vnTime = "10:00";
  assert.equal(mod.isPastCutoff("10:00", new Date()), true);
  (globalThis as unknown as { __vnTime: string }).__vnTime = "10:01";
  assert.equal(mod.isPastCutoff("10:00", new Date()), true);
});

test("excludeFromMeal inserts an exclusion row before cutoff", async () => {
  const store = makeStore("10:00");
  const mod = await loadWith(store);
  (globalThis as unknown as { __vnTime: string }).__vnTime = "08:00";
  const result = await mod.excludeFromMeal({ dailyApplicationId: "app1", excludeDate: "2026-09-13", reason: "NO_SHOW", excludedBy: "manager1" });
  assert.equal(result.outcome, "CANCELLED_BEFORE_CUTOFF");
  assert.equal(store.inserted.length, 1);
});

test("excludeFromMeal NEVER inserts an exclusion row after cutoff (never claim a cancelled meal)", async () => {
  const store = makeStore("10:00");
  const mod = await loadWith(store);
  (globalThis as unknown as { __vnTime: string }).__vnTime = "11:00";
  const result = await mod.excludeFromMeal({ dailyApplicationId: "app1", excludeDate: "2026-09-13", reason: "STARTED_THEN_LEFT", excludedBy: "manager1" });
  assert.equal(result.outcome, "REPORTED_AFTER_MEAL_CUTOFF");
  assert.equal(store.inserted.length, 0, "must never write a false CANCELLED claim after cutoff");
});
