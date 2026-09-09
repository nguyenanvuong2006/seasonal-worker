/**
 * POST /api/document-merge/candidate-documents/issue-ready — EXECUTION
 * regression tests (2026-09, Defect 3: bulk issue). Unlike
 * routes-wiring.test.ts's structural (regex-over-source) assertions, this
 * file transpiles and RUNS the real route.ts against a fake DB that models
 * the actual CAS semantics (an UPDATE only "matches" a row whose CURRENT
 * status is READY with both pdf_sha256/storage_key present — exactly the
 * WHERE clause the real route issues), so it proves runtime behavior:
 * malicious/stale client-supplied ids never bypass server-side enforcement,
 * a duplicate bulk request never double-issues, and one row's conflict
 * never blocks the others.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { condsOf, createFakeDb, drizzleStub, eqValue, inArrayValues, makeTable, type FakeDb, type QueryCall } from "../../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/document-merge/candidate-documents/issue-ready/route.ts";
const routeSource = readFileSync(new URL(`../../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = { candidateDocuments: makeTable("candidate_documents") };

type CandidateState = { id: string; status: string; applicationId: string; hasArtifact: boolean };

type NextResponseLike = { status: number; jsonBody: unknown };

function loadRoute(initialCandidates: CandidateState[]) {
  // Mutable authoritative state — models the real Postgres row, so a CAS
  // UPDATE only succeeds while status is STILL READY at the moment it runs
  // (exactly like a real concurrent UPDATE ... WHERE status='READY').
  const state = new Map(initialCandidates.map((c) => [c.id, { ...c }]));
  const auditWrites: { action: string; details: Record<string, unknown> }[] = [];

  const db: FakeDb = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "candidate_documents") {
        // Mirror the real query's WHERE — the route's SELECT itself filters
        // to status='READY' when no `ids` were given, or to `inArray(id,
        // scopedIds)` (any status) when they were. A fake that ignored this
        // and always returned every row would hide a real defect: it would
        // make the default "no ids" path indistinguishable from "all rows".
        const conds = condsOf(call);
        const scopedIds = inArrayValues(call, "candidate_documents.id");
        if (scopedIds) {
          const idSet = new Set(scopedIds as string[]);
          return [...state.values()].filter((c) => idSet.has(c.id)).map((c) => ({ id: c.id, status: c.status }));
        }
        const requiredStatus = conds.find((c) => c.op === "eq" && c.col === "candidate_documents.status") as
          | { val: unknown }
          | undefined;
        if (requiredStatus) {
          return [...state.values()].filter((c) => c.status === requiredStatus.val).map((c) => ({ id: c.id, status: c.status }));
        }
        return [...state.values()].map((c) => ({ id: c.id, status: c.status }));
      }
      if (call.root === "update" && call.table === "candidate_documents") {
        const id = eqValue(call, "candidate_documents.id") as string | undefined;
        const requiredStatus = eqValue(call, "candidate_documents.status") as string | undefined;
        if (!id) return [];
        const row = state.get(id);
        if (!row) return [];
        // CAS: matches only if the row's CURRENT status equals what the
        // WHERE clause requires (READY) AND the artifact is present —
        // exactly the real route's atomic predicate.
        if (row.status === requiredStatus && row.hasArtifact) {
          row.status = "ISSUED";
          return [{ id: row.id, applicationId: row.applicationId }];
        }
        return [];
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
        case "next/server": {
          return {
            NextResponse: {
              json: (body: unknown, init?: { status?: number }): NextResponseLike => ({ status: init?.status ?? 200, jsonBody: body }),
            },
          };
        }
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/auth":
          return {
            requirePermission: async () => ({
              ok: true as const,
              session: { id: "staff-1", username: "staff", fullName: "Staff", role: "ADMIN", deptId: null },
            }),
            writeAudit: async (_session: unknown, action: string, _targetType: string, details: Record<string, unknown>) => {
              auditWrites.push({ action, details });
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

  const POST = (moduleObj.exports as { POST: (req: Request) => Promise<NextResponseLike> }).POST;
  return { POST, state, auditWrites };
}

function postWith(ids: string[] | undefined): Request {
  return new Request("https://app.example/api/document-merge/candidate-documents/issue-ready", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ids ? { ids } : {}),
  });
}

test("3 READY selected → 3 ISSUED, each via its own independent CAS", async () => {
  const { POST, state } = loadRoute([
    { id: "c1", status: "READY", applicationId: "a1", hasArtifact: true },
    { id: "c2", status: "READY", applicationId: "a2", hasArtifact: true },
    { id: "c3", status: "READY", applicationId: "a3", hasArtifact: true },
  ]);

  const res = await POST(postWith(["c1", "c2", "c3"]));
  const body = res.jsonBody as { processed: number; issued: number; results: { id: string; outcome: string }[] };

  assert.equal(res.status, 200);
  assert.equal(body.issued, 3);
  // Array.from (not .map()) — body.results is a cross-realm array (built
  // inside the vm sandbox); .map() on it would still construct its result
  // via that same realm's Array, which assert.deepEqual then reports as
  // "same structure but not reference-equal" against a host array literal.
  // Array.from() is called on the HOST's Array and always yields a host array.
  assert.deepEqual(
    Array.from(body.results, (r) => r.outcome),
    ["issued", "issued", "issued"],
  );
  assert.equal(state.get("c1")!.status, "ISSUED");
  assert.equal(state.get("c2")!.status, "ISSUED");
  assert.equal(state.get("c3")!.status, "ISSUED");
});

test("READY + ISSUED + CONFIRMED selected together (e.g. a stale/malicious client selection) → only the READY one changes, server-side CAS is the real gate", async () => {
  const { POST, state } = loadRoute([
    { id: "ready-1", status: "READY", applicationId: "a1", hasArtifact: true },
    { id: "already-issued", status: "ISSUED", applicationId: "a2", hasArtifact: true },
    { id: "confirmed", status: "CONFIRMED", applicationId: "a3", hasArtifact: true },
  ]);

  const res = await POST(postWith(["ready-1", "already-issued", "confirmed"]));
  const body = res.jsonBody as { issued: number; results: { id: string; outcome: string }[] };

  assert.equal(body.issued, 1);
  const outcomeById = new Map(body.results.map((r) => [r.id, r.outcome]));
  assert.equal(outcomeById.get("ready-1"), "issued");
  assert.equal(outcomeById.get("already-issued"), "not_ready");
  assert.equal(outcomeById.get("confirmed"), "not_ready");
  // The already-ISSUED and CONFIRMED rows must be structurally UNCHANGED —
  // never regressed, never re-stamped.
  assert.equal(state.get("already-issued")!.status, "ISSUED");
  assert.equal(state.get("confirmed")!.status, "CONFIRMED");
});

test("duplicate bulk request for the SAME already-issued document → no duplicate DOCUMENT_ISSUED audit, idempotent not_ready outcome", async () => {
  const { POST, auditWrites } = loadRoute([{ id: "c1", status: "READY", applicationId: "a1", hasArtifact: true }]);

  const first = await POST(postWith(["c1"]));
  const firstBody = first.jsonBody as { results: { id: string; outcome: string }[] };
  assert.equal(firstBody.results[0].outcome, "issued");

  const second = await POST(postWith(["c1"]));
  const secondBody = second.jsonBody as { results: { id: string; outcome: string }[] };
  assert.equal(secondBody.results[0].outcome, "not_ready", "the second submission must find the document no longer READY");

  const issuedAudits = auditWrites.filter((a) => a.action === "DOCUMENT_ISSUED" && a.details.candidateDocumentId === "c1");
  assert.equal(issuedAudits.length, 1, "exactly one DOCUMENT_ISSUED audit for c1, never two");
});

test("one row's conflict (missing artifact — CAS cannot match) does not block the other eligible rows in the same batch", async () => {
  const { POST, state } = loadRoute([
    { id: "c1", status: "READY", applicationId: "a1", hasArtifact: true },
    { id: "c2-missing-artifact", status: "READY", applicationId: "a2", hasArtifact: false },
    { id: "c3", status: "READY", applicationId: "a3", hasArtifact: true },
  ]);

  const res = await POST(postWith(["c1", "c2-missing-artifact", "c3"]));
  const body = res.jsonBody as { issued: number; results: { id: string; outcome: string }[] };

  assert.equal(body.issued, 2);
  const outcomeById = new Map(body.results.map((r) => [r.id, r.outcome]));
  assert.equal(outcomeById.get("c1"), "issued");
  assert.equal(outcomeById.get("c2-missing-artifact"), "not_ready");
  assert.equal(outcomeById.get("c3"), "issued");
  assert.equal(state.get("c1")!.status, "ISSUED");
  assert.equal(state.get("c3")!.status, "ISSUED");
});

test("empty/omitted ids → defaults to every currently READY document (existing behavior preserved, not narrowed by the new selective-ids path)", async () => {
  const { POST } = loadRoute([
    { id: "c1", status: "READY", applicationId: "a1", hasArtifact: true },
    { id: "c2", status: "GENERATING", applicationId: "a2", hasArtifact: false },
  ]);

  const res = await POST(postWith(undefined));
  const body = res.jsonBody as { results: { id: string; outcome: string }[] };
  assert.equal(body.results.length, 1, "GENERATING rows are excluded from the default 'all READY' selection entirely");
  assert.equal(body.results[0].id, "c1");
  assert.equal(body.results[0].outcome, "issued");
});
