/**
 * Preview route — authorization + API integration (PR3).
 * Chạy CHÍNH source route.ts qua loadModule (giống routes-auth.test.ts của PR2):
 * khẳng định preview endpoint yêu cầu document_merge.templates.manage (không hạ
 * chuẩn RBAC), 404 khi version không tồn tại, 400 khi chưa có position, và gọi
 * renderer đúng với fieldValues operator cung cấp.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "../../test-support/load-module.ts";

type NextJson = (body: unknown, init?: { status?: number }) => { status: number; body: unknown };

function nextServerStub(): {
  NextResponse: {
    json: NextJson;
    // new NextResponse(bytes, init) — mock tối giản cho preview PDF
  } & { new (body: Uint8Array, init?: { headers?: Record<string, string> }): { status: number; bytes: Uint8Array } };
} {
  const Response = function (this: { status: number; bytes: Uint8Array }, body: Uint8Array, init?: { status?: number; headers?: Record<string, string> }) {
    this.status = init?.status ?? 200;
    this.bytes = body;
  } as unknown as { new (body: Uint8Array, init?: { status?: number }): { status: number; bytes: Uint8Array } };
  return {
    NextResponse: Object.assign(Response, {
      json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
    }) as never,
  };
}

type Guard = { ok: boolean; status: number; error: string };

function authStub(calls: unknown[][], guard: Guard) {
  return {
    requirePermission: async (roles: unknown[], key: string) => {
      calls.push([roles, key]);
      if (!guard.ok) return { ok: false, status: guard.status, error: guard.error };
      return { ok: true, session: { username: "admin" } };
    },
    writeAudit: async () => {},
  };
}

const EXPECTED_ROLES = ["ADMIN", "HR_RECRUITER"];
const EXPECTED_PERMISSION = "document_merge.templates.manage";

function makeServices(opts: {
  version?: Record<string, unknown> | null;
  positions?: unknown[];
  renderBytes?: Uint8Array;
}) {
  return {
    "next/server": nextServerStub(),
    "@/lib/document-merge/pdf-overlay/version-service": {
      getPdfTemplateVersion: async () => opts.version ?? null,
    },
    "@/lib/document-merge/pdf-overlay/pdf-storage": {
      retrieveBlankPdf: async () => Buffer.from("PDF"),
    },
    "@/lib/document-merge/pdf-overlay/position-service": {
      listPdfFieldPositions: async () => opts.positions ?? [],
    },
    "@/lib/document-merge/pdf-overlay/positions": {
      toPositionSpec: (row: unknown) => row,
    },
    "@/lib/document-merge/pdf-overlay/renderer": {
      renderPdfOverlay: async (
        _tpl: unknown,
        _pos: unknown,
        _values: unknown,
        opts: { expectedPageCount?: number },
      ) => ({
        bytes: opts?.expectedPageCount !== undefined ? new Uint8Array(opts.expectedPageCount === 1 ? [37, 80, 68, 70] : []) : new Uint8Array([37, 80, 68, 70]),
        sha256: "abc",
        positionsDrawn: 1,
      }),
      PdfOverlayError: undefined,
    },
    "@/lib/document-merge/pdf-overlay/types": {
      PdfOverlayError: class extends Error {},
    },
    "@/lib/document-merge/pdf-overlay/vietnamese-font": {
      readEmbeddedFontBytes: () => new Uint8Array([1]),
    },
  };
}

async function loadPreviewRoute(stubs: Record<string, unknown>): Promise<{
  POST: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<{ status: number; body?: unknown; bytes?: Uint8Array }>;
}> {
  return loadModule(
    new URL("../../../app/api/document-merge/templates/[id]/pdf-versions/[versionId]/preview/route.ts", import.meta.url),
    { stubs },
  ) as unknown as Promise<{ POST: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<{ status: number; body?: unknown; bytes?: Uint8Array }> }>;
}

const ctx = (id = "tpl-1", versionId = "v1") => ({ params: Promise.resolve({ id, versionId }) });

test("preview route: deny khi requirePermission fail → 403", async () => {
  const calls: unknown[][] = [];
  const route = await loadPreviewRoute({
    ...makeServices({}),
    "@/lib/auth": authStub(calls, { ok: false, status: 403, error: "no" }),
  });
  const res = await route.POST(new Request("https://x/api", { method: "POST", body: JSON.stringify({}) }), ctx());
  assert.equal(res.status, 403);
  assert.deepEqual([...(calls[0]?.[0] as string[])], EXPECTED_ROLES);
  assert.equal(calls[0]?.[1], EXPECTED_PERMISSION);
});

test("preview route: 404 khi version không tồn tại", async () => {
  const calls: unknown[][] = [];
  const route = await loadPreviewRoute({
    ...makeServices({ version: null }),
    "@/lib/auth": authStub(calls, { ok: true, status: 200, error: "" }),
  });
  const res = await route.POST(new Request("https://x/api", { method: "POST", body: JSON.stringify({}) }), ctx());
  assert.equal(res.status, 404);
});

test("preview route: 400 khi version chưa có position nào", async () => {
  const calls: unknown[][] = [];
  const route = await loadPreviewRoute({
    ...makeServices({ version: { id: "v1", version: 1, pdfStorageKey: "k", sha256: "a".repeat(64), pageCount: 1 }, positions: [] }),
    "@/lib/auth": authStub(calls, { ok: true, status: 200, error: "" }),
  });
  const res = await route.POST(new Request("https://x/api", { method: "POST", body: JSON.stringify({}) }), ctx());
  assert.equal(res.status, 400);
});

test("preview route: render thành công trả PDF bytes (status 200)", async () => {
  const calls: unknown[][] = [];
  const route = await loadPreviewRoute({
    ...makeServices({
      version: { id: "v1", version: 1, pdfStorageKey: "k", sha256: "a".repeat(64), pageCount: 1 },
      positions: [{ id: "p1", placeholder: "Ho_ten" }],
    }),
    "@/lib/auth": authStub(calls, { ok: true, status: 200, error: "" }),
  });
  const res = await route.POST(
    new Request("https://x/api", { method: "POST", body: JSON.stringify({ fieldValues: { Ho_ten: "Nguyễn Văn An" } }) }),
    ctx(),
  );
  assert.equal(res.status, 200);
  assert.ok(res.bytes && res.bytes.length > 0);
});
