/**
 * PATCH /api/worker-profiles/by-id/[workerId]/fingerprint — RBAC + Data
 * Scope + IDOR tests (2026-09-10 Worker 360° Profile mission, Section 14).
 *
 * Sibling file (not nested under fingerprint/) — same Node test-runner
 * bracket-glob quirk documented elsewhere in this feature.
 *
 * Proves: only ADMIN + worker_profile.edit may reach the write; an
 * out-of-scope workerId is rejected with 404 BEFORE any updateWorkerBiometric
 * call (getWorker360Profile()'s scoped visibility check gates the write — no
 * separate, possibly-looser authorization path for edits); a successful edit
 * calls updateWorkerBiometric() exactly once and writes exactly one audit
 * entry (MISSION F2 section 11/250 — the route no longer writes
 * worker_profiles directly, it delegates to the canonical IT Code service so
 * an edit can no longer silently steal another worker's active IT Code).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const ROUTE_PATH = "src/app/api/worker-profiles/by-id/[workerId]/fingerprint/route.ts";
const routeSource = readFileSync(new URL(`../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

type NextResponseLike = { status: number; jsonBody: Record<string, unknown> };
type Guard = { ok: true; session: { role: string; username: string } } | { ok: false; status: number; error: string };
type UpdateResult =
  | { ok: true; itCodeRoute: "CANONICAL" | "DIRECT_NO_ACTIVE_ENGAGEMENT" }
  | { ok: false; error: "WORKER_NOT_FOUND" | "IT_CODE_ALREADY_ACTIVE" | "WORKER_ALREADY_HAS_ACTIVE_IT_CODE" };

const VALID_ID = "0d3f2a10-1111-4a2b-8c3d-abcdef123456";
const FAKE_PROFILE = { person: { workerId: VALID_ID, fullName: "nguyen van a" }, engagements: [] };

function loadRoute(opts: { guard: Guard; authorizedProfile: unknown; scope?: string[] | null; updateResult?: UpdateResult }) {
  const audits: { action: string; table: string; meta: unknown }[] = [];
  const serviceCalls: { workerId: string; scope: string[] | null }[] = [];
  const updateCalls: unknown[] = [];

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return {
            NextResponse: {
              json: (body: unknown, init?: { status?: number }): NextResponseLike => ({ status: init?.status ?? 200, jsonBody: body as Record<string, unknown> }),
            },
          };
        case "@/lib/auth":
          return {
            requirePermission: async () => opts.guard,
            getUserScope: async () => (opts.scope === undefined ? null : opts.scope),
            writeAudit: async (_session: unknown, action: string, table: string, meta: unknown) => {
              audits.push({ action, table, meta });
            },
          };
        case "@/lib/worker-360-profile":
          return {
            getWorker360Profile: async (workerId: string, scope: string[] | null) => {
              serviceCalls.push({ workerId, scope });
              return opts.authorizedProfile;
            },
          };
        case "@/lib/it-code-assignment":
          return {
            updateWorkerBiometric: async (input: unknown) => {
              updateCalls.push(input);
              return opts.updateResult ?? { ok: true, itCodeRoute: "DIRECT_NO_ACTIVE_ENGAGEMENT" };
            },
          };
        default:
          throw new Error(`Unexpected require("${id}") — route không được phụ thuộc module này.`);
      }
    },
    process,
    Request,
    console,
    JSON,
  });
  vm.runInContext(jsSource, context);

  const PATCH = (moduleObj.exports as { PATCH: (req: Request, ctx: { params: Promise<{ workerId: string }> }) => Promise<NextResponseLike> }).PATCH;
  return { PATCH, audits, serviceCalls, updateCalls };
}

function patchReq(body: Record<string, unknown> = { fingerprintStatus: "DA_CAP" }) {
  return new Request("https://app.example", { method: "PATCH", body: JSON.stringify(body) });
}

test("non-ADMIN caller (guard.ok=false) is rejected before the authorization check or any write", async () => {
  const { PATCH, serviceCalls, updateCalls } = loadRoute({ guard: { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." }, authorizedProfile: FAKE_PROFILE });
  const res = await PATCH(patchReq(), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 403);
  assert.equal(serviceCalls.length, 0);
  assert.equal(updateCalls.length, 0);
});

test("invalid (non-UUID) workerId is rejected with 400 before authorization or any write", async () => {
  const { PATCH, serviceCalls, updateCalls } = loadRoute({ guard: { ok: true, session: { role: "ADMIN", username: "admin1" } }, authorizedProfile: FAKE_PROFILE });
  const res = await PATCH(patchReq(), { params: Promise.resolve({ workerId: "not-a-uuid" }) });
  assert.equal(res.status, 400);
  assert.equal(serviceCalls.length, 0);
  assert.equal(updateCalls.length, 0);
});

test("IDOR: out-of-scope workerId (getWorker360Profile returns null) is rejected with 404 and issues NO update call", async () => {
  const { PATCH, serviceCalls, updateCalls, audits } = loadRoute({ guard: { ok: true, session: { role: "ADMIN", username: "admin1" } }, authorizedProfile: null, scope: ["dept-A"] });
  const res = await PATCH(patchReq(), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 404);
  assert.deepEqual(serviceCalls, [{ workerId: VALID_ID, scope: ["dept-A"] }]);
  assert.equal(updateCalls.length, 0, "an out-of-scope worker must never be mutated, even by an ADMIN-gated route, once scope says no");
  assert.equal(audits.length, 0);
});

test("authorized ADMIN edit calls updateWorkerBiometric exactly once and writes exactly one audit entry", async () => {
  const { PATCH, audits, updateCalls } = loadRoute({ guard: { ok: true, session: { role: "ADMIN", username: "admin1" } }, authorizedProfile: FAKE_PROFILE, scope: null, updateResult: { ok: true, itCodeRoute: "CANONICAL" } });
  const res = await PATCH(patchReq({ fingerprintCode: "FP123", fingerprintDevice: "dev-1", fingerprintStatus: "DA_CAP" }), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 200);
  assert.equal(updateCalls.length, 1);
  const call = updateCalls[0] as Record<string, unknown>;
  assert.equal(call.workerId, VALID_ID);
  assert.equal(call.fingerprintCode, "FP123");
  assert.equal(call.fingerprintDevice, "dev-1");
  assert.equal(call.fingerprintStatus, "DA_CAP");
  assert.equal(call.updatedBy, "admin1");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "UPDATE_FINGERPRINT");
  assert.equal(audits[0].table, "worker_profiles");
});

// MISSION F2 section 11/250 — the route now delegates the IT Code identity change to the
// canonical service, which can reject an edit that would silently steal another worker's active
// IT Code (impossible under the old direct-write behavior — a real correctness fix, not just a
// refactor).
test("IT_CODE_ALREADY_ACTIVE from updateWorkerBiometric is surfaced as 409, never silently applied", async () => {
  const { PATCH } = loadRoute({ guard: { ok: true, session: { role: "ADMIN", username: "admin1" } }, authorizedProfile: FAKE_PROFILE, scope: null, updateResult: { ok: false, error: "IT_CODE_ALREADY_ACTIVE" } });
  const res = await PATCH(patchReq({ fingerprintCode: "FP123" }), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 409);
});

test("WORKER_ALREADY_HAS_ACTIVE_IT_CODE from updateWorkerBiometric is surfaced as 409", async () => {
  const { PATCH } = loadRoute({ guard: { ok: true, session: { role: "ADMIN", username: "admin1" } }, authorizedProfile: FAKE_PROFILE, scope: null, updateResult: { ok: false, error: "WORKER_ALREADY_HAS_ACTIVE_IT_CODE" } });
  const res = await PATCH(patchReq({ fingerprintCode: "FP123" }), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 409);
});

test("WORKER_NOT_FOUND from updateWorkerBiometric is surfaced as 404", async () => {
  const { PATCH } = loadRoute({ guard: { ok: true, session: { role: "ADMIN", username: "admin1" } }, authorizedProfile: FAKE_PROFILE, scope: null, updateResult: { ok: false, error: "WORKER_NOT_FOUND" } });
  const res = await PATCH(patchReq({ fingerprintCode: "FP123" }), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 404);
});
