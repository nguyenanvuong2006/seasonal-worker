/**
 * PATCH /api/worker-profiles/by-id/[workerId]/fingerprint — RBAC + Data
 * Scope + IDOR tests (2026-09-10 Worker 360° Profile mission, Section 14).
 *
 * Sibling file (not nested under fingerprint/) — same Node test-runner
 * bracket-glob quirk documented elsewhere in this feature.
 *
 * Proves: only ADMIN + worker_profile.edit may reach the write; an
 * out-of-scope workerId is rejected with 404 BEFORE any UPDATE is issued
 * (getWorker360Profile()'s scoped visibility check gates the write — no
 * separate, possibly-looser authorization path for edits); a successful
 * edit issues exactly one UPDATE to worker_profiles and one audit entry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type QueryCall } from "../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/worker-profiles/by-id/[workerId]/fingerprint/route.ts";
const routeSource = readFileSync(new URL(`../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = { workerProfiles: makeTable("worker_profiles") };

type NextResponseLike = { status: number; jsonBody: Record<string, unknown> };
type Guard = { ok: true; session: { role: string } } | { ok: false; status: number; error: string };

const VALID_ID = "0d3f2a10-1111-4a2b-8c3d-abcdef123456";
const FAKE_PROFILE = { person: { workerId: VALID_ID, fullName: "nguyen van a" }, engagements: [] };

function loadRoute(opts: { guard: Guard; authorizedProfile: unknown; scope?: string[] | null; updatedRow?: unknown }) {
  const audits: { action: string; table: string; meta: unknown }[] = [];
  const serviceCalls: { workerId: string; scope: string[] | null }[] = [];

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "update" && call.table === "worker_profiles") {
        return opts.updatedRow === undefined ? [{ id: VALID_ID }] : opts.updatedRow;
      }
      return undefined;
    },
  });

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
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
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
  return { PATCH, db, audits, serviceCalls };
}

function patchReq(body: Record<string, unknown> = { fingerprintStatus: "DA_CAP" }) {
  return new Request("https://app.example", { method: "PATCH", body: JSON.stringify(body) });
}

test("non-ADMIN caller (guard.ok=false) is rejected before the authorization check or any write", async () => {
  const { PATCH, db, serviceCalls } = loadRoute({ guard: { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." }, authorizedProfile: FAKE_PROFILE });
  const res = await PATCH(patchReq(), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 403);
  assert.equal(serviceCalls.length, 0);
  assert.equal(db.writesTo("worker_profiles").length, 0);
});

test("invalid (non-UUID) workerId is rejected with 400 before authorization or any write", async () => {
  const { PATCH, db, serviceCalls } = loadRoute({ guard: { ok: true, session: { role: "ADMIN" } }, authorizedProfile: FAKE_PROFILE });
  const res = await PATCH(patchReq(), { params: Promise.resolve({ workerId: "not-a-uuid" }) });
  assert.equal(res.status, 400);
  assert.equal(serviceCalls.length, 0);
  assert.equal(db.writesTo("worker_profiles").length, 0);
});

test("IDOR: out-of-scope workerId (getWorker360Profile returns null) is rejected with 404 and issues NO UPDATE", async () => {
  const { PATCH, db, serviceCalls, audits } = loadRoute({ guard: { ok: true, session: { role: "ADMIN" } }, authorizedProfile: null, scope: ["dept-A"] });
  const res = await PATCH(patchReq(), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 404);
  assert.deepEqual(serviceCalls, [{ workerId: VALID_ID, scope: ["dept-A"] }]);
  assert.equal(db.writesTo("worker_profiles").length, 0, "an out-of-scope worker must never be mutated, even by an ADMIN-gated route, once scope says no");
  assert.equal(audits.length, 0);
});

test("authorized ADMIN edit issues exactly one UPDATE to worker_profiles and exactly one audit entry", async () => {
  const { PATCH, db, audits } = loadRoute({ guard: { ok: true, session: { role: "ADMIN" } }, authorizedProfile: FAKE_PROFILE, scope: null });
  const res = await PATCH(patchReq({ fingerprintCode: "FP123", fingerprintDevice: "dev-1", fingerprintStatus: "DA_CAP" }), { params: Promise.resolve({ workerId: VALID_ID }) });
  assert.equal(res.status, 200);
  assert.equal(db.writesTo("worker_profiles").length, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "UPDATE_FINGERPRINT");
  assert.equal(audits[0].table, "worker_profiles");
});
