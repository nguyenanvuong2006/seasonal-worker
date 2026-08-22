/**
 * PDF Overlay management routes — authorization + API validation (PR2).
 *
 * Chạy CHÍNH source route.ts qua loadModule (giống cron route test): stub
 * next/server + @/lib/auth + service để khẳng định:
 *   - Mọi route management đều gọi requirePermission với đúng vai trò hệ thống
 *     + permission key document_merge.templates.manage (không tự hạ chuẩn RBAC).
 *   - Từ chối khi requirePermission fail → 403.
 *   - POST thiếu file → 400 (API validation).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "../../test-support/load-module.ts";

type NextJson = (body: unknown, init?: { status?: number }) => { status: number; body: unknown };

function nextServerStub(): { NextResponse: { json: NextJson } } {
  return {
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
    },
  };
}

type Guard = { ok: boolean; status: number; error: string; session?: { username: string } };

function authStub(calls: unknown[][], guard: Guard) {
  return {
    requirePermission: async (roles: unknown[], key: string) => {
      calls.push([roles, key]);
      if (!guard.ok) return { ok: false, status: guard.status, error: guard.error };
      return { ok: true, session: guard.session ?? { username: "admin" } };
    },
    writeAudit: async () => {},
  };
}

const VERSION_SERVICE = {
  listPdfTemplateVersions: async () => [],
  createPdfTemplateVersion: async () => ({ id: "v1", version: 1, status: "DRAFT" }),
  PdfTemplateVersionError: class extends Error {},
};

const POSITION_SERVICE = {
  listPdfFieldPositions: async () => [],
  createPdfFieldPosition: async () => ({ id: "p1" }),
  upsertPdfFieldPositions: async () => [],
  PdfFieldPositionError: class extends Error {},
};

function loadRoute(relative: string, stubs: Record<string, unknown>): Promise<Record<string, unknown>> {
  return loadModule(new URL(relative, import.meta.url), { stubs }) as unknown as Promise<Record<string, unknown>>;
}

const EXPECTED_ROLES = ["ADMIN", "HR_RECRUITER"];
const EXPECTED_PERMISSION = "document_merge.templates.manage";

test("GET pdf-versions: requirePermission đúng permission, deny → 403", async () => {
  const calls: unknown[][] = [];
  const route = await loadRoute("./../../../app/api/document-merge/templates/[id]/pdf-versions/route.ts", {
    "next/server": nextServerStub(),
    "@/lib/auth": authStub(calls, { ok: false, status: 403, error: "no" }),
    "@/lib/document-merge/pdf-overlay/version-service": VERSION_SERVICE,
  });
  const res = await (route.GET as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number }>)(
    new Request("https://x/api"),
    { params: Promise.resolve({ id: "tpl-1" }) },
  );
  assert.equal(res.status, 403);
  assert.deepEqual([...(calls[0]?.[0] as string[])], EXPECTED_ROLES);
  assert.equal(calls[0]?.[1], EXPECTED_PERMISSION);
});

test("POST pdf-versions: allow nhưng thiếu file → 400 (API validation)", async () => {
  const calls: unknown[][] = [];
  const route = await loadRoute("./../../../app/api/document-merge/templates/[id]/pdf-versions/route.ts", {
    "next/server": nextServerStub(),
    "@/lib/auth": authStub(calls, { ok: true, status: 200, error: "" }),
    "@/lib/document-merge/pdf-overlay/version-service": VERSION_SERVICE,
  });
  const res = await (route.POST as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number }>)(
    new Request("https://x/api", { method: "POST", body: new FormData() }),
    { params: Promise.resolve({ id: "tpl-1" }) },
  );
  assert.equal(res.status, 400);
  assert.equal(calls[0]?.[1], EXPECTED_PERMISSION);
});

test("publish route: requirePermission đúng permission", async () => {
  const calls: unknown[][] = [];
  const route = await loadRoute("./../../../app/api/document-merge/templates/[id]/pdf-versions/[versionId]/publish/route.ts", {
    "next/server": nextServerStub(),
    "@/lib/auth": authStub(calls, { ok: false, status: 403, error: "no" }),
    "@/lib/document-merge/pdf-overlay/version-service": {
      ...VERSION_SERVICE,
      publishPdfTemplateVersion: async () => ({ version: 1 }),
    },
  });
  await (route.POST as (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<{ status: number }>)(
    new Request("https://x/api", { method: "POST" }),
    { params: Promise.resolve({ id: "tpl-1", versionId: "v1" }) },
  );
  assert.equal(calls[0]?.[1], EXPECTED_PERMISSION);
});

test("verify route: requirePermission đúng permission", async () => {
  const calls: unknown[][] = [];
  const route = await loadRoute("./../../../app/api/document-merge/templates/[id]/pdf-versions/[versionId]/verify/route.ts", {
    "next/server": nextServerStub(),
    "@/lib/auth": authStub(calls, { ok: false, status: 403, error: "no" }),
    "@/lib/document-merge/pdf-overlay/version-service": {
      ...VERSION_SERVICE,
      getPdfTemplateVersion: async () => ({ pdfStorageKey: "k", sha256: "a".repeat(64), pageCount: 1 }),
    },
    "@/lib/document-merge/pdf-overlay/pdf-storage": {
      verifyBlankPdfIntegrity: async () => ({ ok: true }),
    },
  });
  await (route.GET as (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<{ status: number }>)(
    new Request("https://x/api"),
    { params: Promise.resolve({ id: "tpl-1", versionId: "v1" }) },
  );
  assert.equal(calls[0]?.[1], EXPECTED_PERMISSION);
});

test("positions route: requirePermission đúng permission + deny → 403", async () => {
  const calls: unknown[][] = [];
  const route = await loadRoute("./../../../app/api/document-merge/templates/[id]/pdf-versions/[versionId]/positions/route.ts", {
    "next/server": nextServerStub(),
    "@/lib/auth": authStub(calls, { ok: false, status: 403, error: "no" }),
    "@/lib/document-merge/pdf-overlay/position-service": POSITION_SERVICE,
  });
  const res = await (route.GET as (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<{ status: number }>)(
    new Request("https://x/api"),
    { params: Promise.resolve({ id: "tpl-1", versionId: "v1" }) },
  );
  assert.equal(res.status, 403);
  assert.deepEqual([...(calls[0]?.[0] as string[])], EXPECTED_ROLES);
  assert.equal(calls[0]?.[1], EXPECTED_PERMISSION);
});
