import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "../../../lib/test-support/load-module.ts";

/* ============================================================
   REGRESSION TESTS — POST /api/import/upload
   ------------------------------------------------------------
   P2-2 hardening (prelaunch security audit): validateUploadFile()
   must fire BEFORE buffer allocation, checksum, parseImportFile,
   createJob, stageRows, or any DB mutation.

   Coverage:
     * unauthenticated  -> 401, zero DB side-effects
     * unauthorized     -> 403, zero DB side-effects
     * bad jobType      -> 400, zero DB side-effects
     * unsupported extension (.pdf, .docx) -> 400 INVALID_ARGS, zero DB writes
     * oversized file (>20 MB) -> 400 INVALID_ARGS, zero DB writes
     * valid XLSX file  -> follows normal import flow (createJob called)
     * valid CSV file   -> follows normal import flow
     * valid XLS file   -> follows normal import flow
   ============================================================ */

type Guard =
  | { ok: true; session: { id: string; role: string; username: string; fullName: string } }
  | { ok: false; status: number; error: string };

type FakeResponse = { status: number; body: Record<string, unknown> };
type PostFn = (req: Request) => Promise<FakeResponse>;

type ValidateResult = { ok: true } | { ok: false; message: string };
type ValidateFn = (file: { name: string; size: number }) => ValidateResult;

interface LoadOpts {
  guard?: Guard;
  createJobCalled?: { value: boolean };
  stageRowsCalled?: { value: boolean };
  parseRows?: Record<string, string>[];
  validateUploadFile?: ValidateFn;
}

const ADMIN_GUARD: Guard = { ok: true, session: { id: "u1", role: "ADMIN", username: "admin1", fullName: "Admin One" } };
const UNAUTH_GUARD: Guard = { ok: false, status: 401, error: "Chua dang nhap." };
const FORBIDDEN_GUARD: Guard = { ok: false, status: 403, error: "Khong co quyen." };

function makeFile(name: string, sizeBytes: number): File {
  const content = new Uint8Array(Math.min(sizeBytes, 8));
  return new File([content], name, { type: "application/octet-stream" });
}

function loadRoute(opts: LoadOpts): { mod: Record<string, unknown>; createJobCalled: { value: boolean }; stageRowsCalled: { value: boolean }; audits: string[] } {
  const guard = opts.guard ?? ADMIN_GUARD;
  const createJobCalled = opts.createJobCalled ?? { value: false };
  const stageRowsCalled = opts.stageRowsCalled ?? { value: false };
  const audits: string[] = [];

  const defaultValidator: ValidateFn = (file) => {
    const MAX = 20 * 1024 * 1024;
    if (file.size > MAX) return { ok: false, message: "File vuot qua gioi han 20MB." };
    const lower = file.name.toLowerCase();
    const allowed = [".xlsx", ".xls", ".csv"];
    if (!allowed.some((ext) => lower.endsWith(ext))) {
      return { ok: false, message: "Dinh dang file khong duoc ho tro. Chi chap nhan: " + allowed.join(", ") + "." };
    }
    return { ok: true };
  };
  const validateUploadFile = opts.validateUploadFile ?? defaultValidator;

  const mod = loadModule(new URL("./upload/route.ts", import.meta.url), {
    stubs: {
      "next/server": {
        NextResponse: class FakeNextResponse {
          body: unknown;
          status: number;
          constructor(body: unknown, init?: { status?: number }) {
            this.body = body;
            this.status = init?.status ?? 200;
          }
          static json(body: Record<string, unknown>, init?: { status?: number }) {
            return { status: init?.status ?? 200, body };
          }
        },
      },
      "crypto": {
        createHash: () => ({ update: () => ({ digest: () => "fake-checksum" }) }),
      },
      "drizzle-orm": { eq: () => ({}) },
      "@/db": { db: { update: () => ({ set: () => ({ where: async () => {} }) }) } },
      "@/db/schema": { importJobs: {} },
      "@/lib/auth": {
        requireRoleAndPermission: async () => guard,
        writeAudit: async (_s: unknown, action: string) => { audits.push(action); },
      },
      "@/lib/import-jobs": {
        createJob: async () => {
          createJobCalled.value = true;
          return { id: "job-1", resumeToken: "tok-1" };
        },
        isImportEngineJobType: (t: unknown) => ["dw_data", "daily_application", "department"].includes(t as string),
        stageRows: async () => { stageRowsCalled.value = true; },
        triggerWorker: () => {},
      },
      "@/lib/file-parser": {
        parseImportFile: async () => opts.parseRows ?? [{ "Ho ten": "Nguyen A" }],
      },
      "@/lib/metadata": {
        getFieldDefinitions: async () => [],
        normalizeHeader: (h: string) => h.toLowerCase().trim(),
      },
      "@/lib/import-engine": {
        getAcceptedColumnNames: async () => new Set<string>(),
      },
      "@/lib/data-management/file-safety": {
        validateUploadFile,
      },
    },
  });

  return { mod, createJobCalled, stageRowsCalled, audits };
}

function makeRequest(form: FormData): Request {
  return new Request("http://localhost/api/import/upload", { method: "POST", body: form });
}

function makeForm(file: File, jobType = "dw_data"): FormData {
  const fd = new FormData();
  fd.append("file", file);
  if (jobType) fd.append("jobType", jobType);
  return fd;
}

// ── Auth gates ───────────────────────────────────────────────────────────────

test("unauthenticated -> 401, zero DB writes", async () => {
  const createJobCalled = { value: false };
  const stageRowsCalled = { value: false };
  const { mod } = loadRoute({ guard: UNAUTH_GUARD, createJobCalled, stageRowsCalled });
  const POST = mod.POST as PostFn;
  const res = await POST(makeRequest(makeForm(makeFile("data.xlsx", 100))));
  assert.equal(res.status, 401);
  assert.equal(createJobCalled.value, false, "createJob must not fire when unauthenticated");
  assert.equal(stageRowsCalled.value, false);
});

test("unauthorized (no import.run permission) -> 403, zero DB writes", async () => {
  const createJobCalled = { value: false };
  const { mod } = loadRoute({ guard: FORBIDDEN_GUARD, createJobCalled });
  const POST = mod.POST as PostFn;
  const res = await POST(makeRequest(makeForm(makeFile("data.xlsx", 100))));
  assert.equal(res.status, 403);
  assert.equal(createJobCalled.value, false);
});

// ── File validation gates (P2-2 hardening) ───────────────────────────────────

test("unsupported extension (.pdf) -> 400 INVALID_ARGS, zero DB writes", async () => {
  const createJobCalled = { value: false };
  const stageRowsCalled = { value: false };
  const { mod } = loadRoute({ createJobCalled, stageRowsCalled });
  const POST = mod.POST as PostFn;
  const res = await POST(makeRequest(makeForm(makeFile("data.pdf", 1024))));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_ARGS");
  assert.ok(typeof res.body.message === "string" && res.body.message.length > 0);
  assert.equal(createJobCalled.value, false, "createJob must NOT be called for unsupported extension");
  assert.equal(stageRowsCalled.value, false, "stageRows must NOT be called for unsupported extension");
});

test("unsupported extension (.docx) -> 400 INVALID_ARGS, zero DB writes", async () => {
  const createJobCalled = { value: false };
  const { mod } = loadRoute({ createJobCalled });
  const POST = mod.POST as PostFn;
  const res = await POST(makeRequest(makeForm(makeFile("import.docx", 1024))));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_ARGS");
  assert.equal(createJobCalled.value, false);
});

test("oversized file (>20 MB) -> 400 INVALID_ARGS, zero DB writes", async () => {
  const createJobCalled = { value: false };
  const stageRowsCalled = { value: false };
  // Inject a validator that returns the size error — confirms the route rejects
  // before buffer allocation, createJob, or stageRows.
  const { mod } = loadRoute({
    createJobCalled,
    stageRowsCalled,
    validateUploadFile: (_file) => ({ ok: false as const, message: "File vuot qua gioi han 20MB." }),
  });
  const POST = mod.POST as PostFn;
  const res = await POST(makeRequest(makeForm(makeFile("data.xlsx", 512))));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_ARGS");
  assert.ok(typeof res.body.message === "string" && res.body.message.length > 0);
  assert.equal(createJobCalled.value, false, "createJob must NOT be called when validator rejects");
  assert.equal(stageRowsCalled.value, false, "stageRows must NOT be called when validator rejects");
});

test("invalid jobType -> 400, zero DB writes", async () => {
  const createJobCalled = { value: false };
  const { mod } = loadRoute({ createJobCalled });
  const POST = mod.POST as PostFn;
  const res = await POST(makeRequest(makeForm(makeFile("data.xlsx", 512), "invalid_type")));
  assert.equal(res.status, 400);
  assert.equal(createJobCalled.value, false);
});

// ── Happy-path gate ───────────────────────────────────────────────────────────

test("valid XLSX file -> import flow runs, 200 with jobId, audit written", async () => {
  const createJobCalled = { value: false };
  const stageRowsCalled = { value: false };
  const { mod, audits } = loadRoute({
    createJobCalled,
    stageRowsCalled,
    parseRows: [{ "Ho ten": "Nguyen A", "CCCD": "123456789012" }],
  });
  const POST = mod.POST as PostFn;
  const res = await POST(makeRequest(makeForm(makeFile("workers.xlsx", 4096))));
  assert.equal(res.status, 200);
  assert.equal(res.body.jobId, "job-1", "Should return jobId on success");
  assert.equal(createJobCalled.value, true, "createJob must be called for valid upload");
  assert.equal(stageRowsCalled.value, true, "stageRows must be called for valid upload");
  assert.ok(audits.includes("IMPORT_JOB_CREATED"), "audit must be written on success");
});

test("valid CSV file -> import flow runs, 200 with jobId", async () => {
  const createJobCalled = { value: false };
  const { mod } = loadRoute({ createJobCalled, parseRows: [{ "Ho ten": "Nguyen B" }] });
  const POST = mod.POST as PostFn;
  const res = await POST(makeRequest(makeForm(makeFile("workers.csv", 512))));
  assert.equal(res.status, 200);
  assert.equal(createJobCalled.value, true);
});

test("valid XLS file -> import flow runs, 200 with jobId", async () => {
  const createJobCalled = { value: false };
  const { mod } = loadRoute({ createJobCalled, parseRows: [{ col: "val" }] });
  const POST = mod.POST as PostFn;
  const res = await POST(makeRequest(makeForm(makeFile("legacy.xls", 1024))));
  assert.equal(res.status, 200);
  assert.equal(createJobCalled.value, true);
});
