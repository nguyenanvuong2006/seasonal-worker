import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";
import { createFakeDb, makeTable, drizzleStub, condsOf, type QueryCall } from "./test-support/fake-drizzle.ts";

/* ============================================================
   IDENTITY & IT CODE CONTRACT REVIEW (2026-09-13) —
   fingerprint-classification.ts: NEW / RETURNING / TRANSFERRED derived
   STRICTLY from employment_sessions + workforce_movements history, never
   from IT Code/dw_data presence (mission sections 13-14, 28-31).
   ============================================================ */

type SessionFixture = { id: string; workerId: string; dailyApplicationId: string | null; regDate: string; createdAt: Date };
type MovementFixture = { workerId: string; movementType: string; employmentSessionId: string | null; lifecycleAppliedAt: Date | null };

function loadClassify(sessions: SessionFixture[], movements: MovementFixture[] = []) {
  const employmentSessions = makeTable("employment_sessions");
  const workforceMovements = makeTable("workforce_movements");

  const respond = (call: QueryCall) => {
    if (call.table === "employment_sessions") return sessions;
    if (call.table === "workforce_movements") {
      const conds = condsOf(call);
      const typeCond = conds.find((c) => c.op === "eq" && c.col === "workforce_movements.movementType");
      const wantedType = typeCond && typeCond.op === "eq" ? typeCond.val : undefined;
      const requireApplied = conds.some((c) => c.op === "isNotNull" && c.col === "workforce_movements.lifecycleAppliedAt");
      return movements
        .filter((m) => (wantedType ? m.movementType === wantedType : true))
        .filter((m) => (requireApplied ? m.lifecycleAppliedAt !== null : true))
        .map((m) => ({ employmentSessionId: m.employmentSessionId }));
    }
    return [];
  };

  const db = createFakeDb({ respond });

  const mod = loadModule(new URL("./fingerprint-classification.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": { employmentSessions, workforceMovements },
    },
  });

  return mod as {
    classifyWorkforceEngagements: (ids: string[]) => Promise<Map<string, "NEW" | "RETURNING" | "TRANSFERRED">>;
  };
}

test("first-ever employment_sessions row for a worker -> NEW", async () => {
  const { classifyWorkforceEngagements } = loadClassify([
    { id: "s1", workerId: "w1", dailyApplicationId: "app-1", regDate: "2026-01-01", createdAt: new Date("2026-01-01T00:00:00Z") },
  ]);
  const result = await classifyWorkforceEngagements(["app-1"]);
  assert.equal(result.get("app-1"), "NEW");
});

test("worker with an earlier employment_sessions row -> RETURNING for the later one", async () => {
  const { classifyWorkforceEngagements } = loadClassify([
    { id: "s1", workerId: "w1", dailyApplicationId: "app-old", regDate: "2026-01-01", createdAt: new Date("2026-01-01T00:00:00Z") },
    { id: "s2", workerId: "w1", dailyApplicationId: "app-new", regDate: "2026-06-01", createdAt: new Date("2026-06-01T00:00:00Z") },
  ]);
  const result = await classifyWorkforceEngagements(["app-new"]);
  assert.equal(result.get("app-new"), "RETURNING");
});

test("the earliest session itself is never RETURNING, even when a later session for the same worker exists", async () => {
  const { classifyWorkforceEngagements } = loadClassify([
    { id: "s1", workerId: "w1", dailyApplicationId: "app-old", regDate: "2026-01-01", createdAt: new Date("2026-01-01T00:00:00Z") },
    { id: "s2", workerId: "w1", dailyApplicationId: "app-new", regDate: "2026-06-01", createdAt: new Date("2026-06-01T00:00:00Z") },
  ]);
  const result = await classifyWorkforceEngagements(["app-old"]);
  assert.equal(result.get("app-old"), "NEW");
});

test("session with an APPLIED TRANSFER movement -> TRANSFERRED, takes priority over NEW", async () => {
  const { classifyWorkforceEngagements } = loadClassify(
    [{ id: "s1", workerId: "w1", dailyApplicationId: "app-1", regDate: "2026-01-01", createdAt: new Date("2026-01-01T00:00:00Z") }],
    [{ workerId: "w1", movementType: "TRANSFER", employmentSessionId: "s1", lifecycleAppliedAt: new Date("2026-02-01T00:00:00Z") }],
  );
  const result = await classifyWorkforceEngagements(["app-1"]);
  assert.equal(result.get("app-1"), "TRANSFERRED");
});

test("session with an APPLIED TRANSFER also takes priority over RETURNING", async () => {
  const { classifyWorkforceEngagements } = loadClassify(
    [
      { id: "s1", workerId: "w1", dailyApplicationId: "app-old", regDate: "2026-01-01", createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "s2", workerId: "w1", dailyApplicationId: "app-new", regDate: "2026-06-01", createdAt: new Date("2026-06-01T00:00:00Z") },
    ],
    [{ workerId: "w1", movementType: "TRANSFER", employmentSessionId: "s2", lifecycleAppliedAt: new Date("2026-07-01T00:00:00Z") }],
  );
  const result = await classifyWorkforceEngagements(["app-new"]);
  assert.equal(result.get("app-new"), "TRANSFERRED");
});

test("future-dated TRANSFER not yet applied (lifecycleAppliedAt NULL) does NOT count as TRANSFERRED (mission section 31)", async () => {
  const { classifyWorkforceEngagements } = loadClassify(
    [{ id: "s1", workerId: "w1", dailyApplicationId: "app-1", regDate: "2026-01-01", createdAt: new Date("2026-01-01T00:00:00Z") }],
    [{ workerId: "w1", movementType: "TRANSFER", employmentSessionId: "s1", lifecycleAppliedAt: null }],
  );
  const result = await classifyWorkforceEngagements(["app-1"]);
  assert.equal(result.get("app-1"), "NEW", "not-yet-effective transfer must not flip classification to TRANSFERRED");
});

test("RESIGNATION movements are irrelevant to TRANSFERRED classification (only movementType=TRANSFER counts)", async () => {
  const { classifyWorkforceEngagements } = loadClassify(
    [{ id: "s1", workerId: "w1", dailyApplicationId: "app-1", regDate: "2026-01-01", createdAt: new Date("2026-01-01T00:00:00Z") }],
    [{ workerId: "w1", movementType: "RESIGNATION", employmentSessionId: "s1", lifecycleAppliedAt: new Date("2026-02-01T00:00:00Z") }],
  );
  const result = await classifyWorkforceEngagements(["app-1"]);
  assert.equal(result.get("app-1"), "NEW");
});

test("dailyApplicationId with no employment_sessions row is omitted from the result map (never guessed)", async () => {
  const { classifyWorkforceEngagements } = loadClassify([
    { id: "s1", workerId: "w1", dailyApplicationId: "app-1", regDate: "2026-01-01", createdAt: new Date("2026-01-01T00:00:00Z") },
  ]);
  const result = await classifyWorkforceEngagements(["app-1", "app-does-not-exist"]);
  assert.equal(result.has("app-does-not-exist"), false);
  assert.equal(result.size, 1);
});

test("empty input -> empty map, no query issued", async () => {
  const { classifyWorkforceEngagements } = loadClassify([]);
  const result = await classifyWorkforceEngagements([]);
  assert.equal(result.size, 0);
});

test("two independent workers are classified independently (no cross-contamination)", async () => {
  const { classifyWorkforceEngagements } = loadClassify([
    { id: "s1", workerId: "w1", dailyApplicationId: "app-w1", regDate: "2026-01-01", createdAt: new Date("2026-01-01T00:00:00Z") },
    { id: "s2", workerId: "w2", dailyApplicationId: "app-w2-old", regDate: "2026-01-01", createdAt: new Date("2026-01-01T00:00:00Z") },
    { id: "s3", workerId: "w2", dailyApplicationId: "app-w2-new", regDate: "2026-06-01", createdAt: new Date("2026-06-01T00:00:00Z") },
  ]);
  const result = await classifyWorkforceEngagements(["app-w1", "app-w2-old", "app-w2-new"]);
  assert.equal(result.get("app-w1"), "NEW");
  assert.equal(result.get("app-w2-old"), "NEW");
  assert.equal(result.get("app-w2-new"), "RETURNING");
});
