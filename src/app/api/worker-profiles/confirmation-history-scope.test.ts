/**
 * GET /api/worker-profiles/[cccd] — Electronic Confirmation history
 * regression tests (2026-09-10 mission). Sibling file (not nested under
 * [cccd]/) — same Node test-runner bracket-glob quirk documented elsewhere
 * in this feature (see issue-single-deadline.test.ts).
 *
 * Proves: the new confirmationHistory field is present and Data-Scope-
 * filtered to EXACTLY the same employment sessions already returned in
 * `sessions` (never a wider set that would leak an out-of-scope
 * engagement's confirmation document), and a returning worker with TWO
 * engagements gets TWO independent history entries.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { condsOf, createFakeDb, drizzleStub, inArrayValues, makeTable, type QueryCall } from "../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/worker-profiles/[cccd]/route.ts";
const routeSource = readFileSync(new URL(`../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  departments: makeTable("departments"),
  employmentSessions: makeTable("employment_sessions"),
  workerProfiles: makeTable("worker_profiles"),
};

type NextResponseLike = { status: number; jsonBody: Record<string, unknown> };

const PROFILE = { id: "worker-1", cccd: "010000000001", fullName: "nguyen van a", deletedAt: null };
const SESSION_IN_SCOPE = { id: "sess-1", deptId: "d1", regDate: "2026-01-01", status: "APPROVED", startingDate: "2026-01-01" };
const SESSION_OUT_OF_SCOPE = { id: "sess-2", deptId: "d2", regDate: "2026-06-01", status: "APPROVED", startingDate: "2026-06-01" };

function loadRoute(opts: {
  sessions: Record<string, unknown>[];
  confirmationHistoryEntries: { documentId: string; employmentSessionId: string | null }[];
  scope: string[] | null;
}) {
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.table === "worker_profiles" && call.root === "select") return [PROFILE];
      if (call.table === "employment_sessions" && call.root === "select") {
        const conds = condsOf(call);
        const deptScoped = inArrayValues(call, "employment_sessions.deptId");
        let rows = opts.sessions;
        if (deptScoped) rows = rows.filter((r) => deptScoped.includes(r.deptId as string));
        const workerEq = conds.find((c) => c.op === "eq" && c.col === "employment_sessions.workerId");
        if (workerEq) rows = rows.filter(() => true);
        return rows;
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
            requirePermission: async () => ({ ok: true as const, session: { id: "staff-1", username: "staff", fullName: "Staff", role: "ADMIN", deptId: null } }),
            getUserScope: async () => opts.scope,
            writeAudit: async () => {},
          };
        case "@/lib/person-name":
          return { normalizePersonName: (s: string) => s };
        case "@/lib/validators":
          return { isValidCccd: (s: string) => /^\d{12}$/.test(s), normalizeCccd: (s: string) => s, CCCD_ERROR_MESSAGE: "CCCD không hợp lệ" };
        case "@/lib/candidate-consent/confirmation-queries":
          return {
            getElectronicConfirmationHistory: async () =>
              opts.confirmationHistoryEntries.map((e) => ({
                documentId: e.documentId,
                applicationId: "app-x",
                employmentSessionId: e.employmentSessionId,
                engagementStartingDate: null,
                templateVersion: 1,
                documentKind: "GENERIC",
                status: "ISSUED",
                effectiveStatus: "ISSUED",
                issuedAt: null,
                confirmationDeadlineAt: null,
                viewedAt: null,
                confirmedAt: null,
                receiptId: null,
              })),
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

  return (moduleObj.exports as { GET: (req: Request, ctx: { params: Promise<{ cccd: string }> }) => Promise<NextResponseLike> }).GET;
}

test("confirmationHistory only includes entries whose employmentSessionId is among the ALREADY-scoped sessions — an out-of-scope engagement's document is filtered out", async () => {
  const GET = loadRoute({
    sessions: [SESSION_IN_SCOPE], // scope=["d1"] means employment_sessions query already excludes sess-2
    confirmationHistoryEntries: [
      { documentId: "doc-in-scope", employmentSessionId: "sess-1" },
      { documentId: "doc-out-of-scope", employmentSessionId: "sess-2" },
    ],
    scope: ["d1"],
  });
  const res = await GET(new Request("https://app.example"), { params: Promise.resolve({ cccd: "010000000001" }) });
  assert.equal(res.status, 200);
  const history = res.jsonBody.confirmationHistory as { documentId: string }[];
  assert.deepEqual(Array.from(history, (h) => h.documentId), ["doc-in-scope"]);
});

test("returning worker with TWO engagements → both confirmation-history entries present when both sessions are in scope", async () => {
  const GET = loadRoute({
    sessions: [SESSION_IN_SCOPE, SESSION_OUT_OF_SCOPE],
    confirmationHistoryEntries: [
      { documentId: "doc-1", employmentSessionId: "sess-1" },
      { documentId: "doc-2", employmentSessionId: "sess-2" },
    ],
    scope: null, // GLOBAL — sees every session
  });
  const res = await GET(new Request("https://app.example"), { params: Promise.resolve({ cccd: "010000000001" }) });
  const history = res.jsonBody.confirmationHistory as { documentId: string }[];
  assert.equal(history.length, 2, "both engagements' confirmation documents must be present for a GLOBAL-scope caller");
});

test("a confirmation-history entry with employmentSessionId=null (legacy, unlinked) is never included — ambiguous linkage is never guessed", async () => {
  const GET = loadRoute({
    sessions: [SESSION_IN_SCOPE],
    confirmationHistoryEntries: [{ documentId: "legacy-doc", employmentSessionId: null }],
    scope: null,
  });
  const res = await GET(new Request("https://app.example"), { params: Promise.resolve({ cccd: "010000000001" }) });
  const history = res.jsonBody.confirmationHistory as { documentId: string }[];
  assert.equal(history.length, 0);
});
