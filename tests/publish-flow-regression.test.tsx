/**
 * REGRESSION — Publish Checklist silent JSON parse failure.
 *
 * Production bug: opening the Publish Checklist modal ("Xuất bản phiên bản")
 * could silently die — modal renders blank/dead, no error text, no crash in
 * the error boundary — when the ai-analyze response was 2xx with a body that
 * is NOT the expected JSON object (HTML gateway/502 page, empty 200, proxy
 * interception, truncated stream), or when the JSON object was missing the
 * arrays the render path reads.
 *
 * Root cause proven (fixed in publish-checklist-modal.tsx):
 *   `const data = (await res.json().catch(() => ({})))` — a parse failure on
 *   a 2xx body was swallowed into `{}`. The `!res.ok` check passed, the junk
 *   was stored in state, and during render `result.htmlIssues.length` (and
 *   result.security.errors / result.placeholders.*) threw a TypeError —
 *   in the COMPONENT BODY, OUTSIDE the effect's try/catch — so React
 *   unmounted the tree with no visible message. Symptom: checklist opens,
 *   then goes blank; operator cannot publish AND cannot see why.
 *
 * Fix (minimal, no redesign — read-only gate unchanged):
 *   1. readJsonObject() — parse failure / non-object body => null, handled as
 *      a VISIBLE error (fail closed; confirm stays blocked).
 *   2. isAnalyzeResultShape() — a 2xx JSON body missing the required
 *      arrays/booleans is reported as a visible loadError BEFORE it reaches
 *      render; render can never throw a TypeError on it.
 *
 * These tests render the REAL modal (jsdom + react-dom client) with a stubbed
 * fetch. Zero DB, zero network, zero writes — only read-only GET /versions +
 * POST /ai-analyze are ever issued by the modal.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
// @vitest-environment jsdom
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { installDom, loadComponent, resetComponentCache, type RenderEnv } from "../src/lib/test-support/render-tsx";
import * as checklistLib from "../src/lib/document-merge/publish-checklist";

const MODAL_URL = new URL("src/components/document-merge/publish-checklist-modal.tsx", `file://${process.cwd()}/`);

/** v16-like DRAFT — same shape the GET /versions endpoint returns. */
const TARGET = {
  id: "v16-draft-id",
  version: 16,
  htmlBody: "<h1>Hợp đồng thời vụ</h1><p>Ông/Bà {{full_name}}</p>",
  printCss: null,
};

const VERSION_ROW = {
  id: "v16-draft-id",
  version: 16,
  status: "DRAFT",
  htmlBody: TARGET.htmlBody,
  printCss: null,
  mappingSnapshot: [],
};

const ANALYZE_OK = {
  htmlValid: true,
  htmlIssues: [],
  cssValid: true,
  cssIssues: [],
  security: { errors: [], warnings: [] },
  placeholders: { total: 1, unchanged: 1, added: 0, removed: 0 },
  mappingsAffected: 0,
  layoutWarnings: [],
  placeholderCoverage: { ok: true, totalPlaceholders: 1, mappedFields: 1, issues: [] },
};

type FetchCall = { url: string; method: string };

/** A minimal JSON Response — body can be anything; `throwsOnJson` simulates a
 *  non-JSON body (HTML gateway page / empty 200) where res.json() rejects. */
function fakeResponse(body: unknown, status: number, throwsOnJson = false): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: throwsOnJson
      ? async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        }
      : async () => body,
  } as unknown as Response;
}

async function renderModal(opts: {
  versionsBody?: unknown;
  versionsStatus?: number;
  versionsThrowOnJson?: boolean;
  analyzeBody?: unknown;
  analyzeStatus?: number;
  analyzeThrowOnJson?: boolean;
}): Promise<{ container: HTMLElement; calls: FetchCall[]; renderThrew: unknown }> {
  const calls: FetchCall[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (/\/versions$/.test(url)) {
      return fakeResponse(opts.versionsBody ?? [VERSION_ROW], opts.versionsStatus ?? 200, opts.versionsThrowOnJson);
    }
    if (/\/ai-analyze$/.test(url)) {
      return fakeResponse(
        opts.analyzeBody ?? ANALYZE_OK,
        opts.analyzeStatus ?? 200,
        opts.analyzeThrowOnJson,
      );
    }
    return fakeResponse({}, 200);
  }) as typeof fetch;

  resetComponentCache();
  const mod = loadComponent(MODAL_URL, {
    stubs: {
      // The "@/..." alias resolves under tsx (node:test) but not under vitest;
      // the value module is identical either way (type-only relative import is
      // erased by the transpiler).
      "@/lib/document-merge/publish-checklist": checklistLib,
    },
  });
  const Modal = mod.PublishChecklistModal as (props: unknown) => unknown;

  const container = document.getElementById("root") as HTMLElement;
  container.innerHTML = "";
  const root = createRoot(container);
  let renderThrew: unknown = null;
  try {
    await act(async () => {
      root.render(
        React.createElement(Modal as never, {
          templateId: "tpl-hd-thoi-vu",
          templateName: "Hợp đồng lao động thời vụ",
          target: TARGET,
          currentPublishedVersionId: null,
          currentPublishedVersionNumber: null,
          action: "publish",
          onClose: () => {},
          onConfirmed: async () => {},
        } as never),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  } catch (e) {
    renderThrew = e;
  }
  return { container, calls, renderThrew };
}

describe("Publish Checklist — publish flow regression", () => {
  let env: RenderEnv;

  beforeEach(() => {
    env = installDom();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("happy path: valid versions + valid analyze result renders the gate with no error", async () => {
    const { container, renderThrew } = await renderModal({});
    expect(renderThrew, `render must not throw: ${String((renderThrew as Error)?.message ?? "")}`).toBeNull();
    // Modal header present...
    expect(container.textContent ?? "").toContain("Xác nhận xuất bản v16");
    // ...machine checks section rendered...
    expect(container.textContent ?? "").toContain("Kiểm tra tự động");
    // ...and NO error banner.
    expect(container.textContent ?? "").not.toContain("không hợp lệ");
    expect(container.textContent ?? "").not.toMatch(/Không tải được|Không phân tích được/);
  });

  it("REGRESSION: 200 ai-analyze with NON-JSON body (html gateway page) shows a visible error instead of crashing silently", async () => {
    const { container, renderThrew } = await renderModal({ analyzeThrowOnJson: true });
    // Before fix: TypeError "Cannot read properties of undefined (reading 'length')"
    // thrown from the render body — blank modal, zero operator feedback.
    expect(renderThrew, `non-JSON body must not crash render: ${String((renderThrew as Error)?.message ?? "")}`).toBeNull();
    const text = container.textContent ?? "";
    expect(text, "modal must stay mounted (not unmounted by the crash)").toContain("Xác nhận xuất bản v16");
    expect(text, "the parse failure must be a VISIBLE error").toMatch(/không hợp lệ|Không phân tích được/);
  });

  it("REGRESSION: 200 ai-analyze with a JSON object missing required fields shows a visible error, no render throw", async () => {
    const { container, renderThrew } = await renderModal({ analyzeBody: { ok: true, note: "truncated/malformed body" } });
    expect(renderThrew, `malformed JSON must not crash render: ${String((renderThrew as Error)?.message ?? "")}`).toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("Xác nhận xuất bản v16");
    expect(text, "missing-field body must be reported as a visible loadError").toMatch(/không hợp lệ/);
  });

  it("REGRESSION: 200 /versions with a non-JSON body shows a visible error instead of a silent failure", async () => {
    const { container, renderThrew } = await renderModal({ versionsThrowOnJson: true });
    expect(renderThrew, `non-JSON versions body must not crash render: ${String((renderThrew as Error)?.message ?? "")}`).toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("Xác nhận xuất bản v16");
    expect(text).toMatch(/Không tải được phiên bản/);
    // Analyze must NOT be called when the fresh row could not be loaded.
  });

  it("non-2xx ai-analyze with JSON error body shows the server's specific error (never swallowed)", async () => {
    const { container, renderThrew } = await renderModal({
      analyzeStatus: 500,
      analyzeBody: { error: "AI analyze sập." },
    });
    expect(renderThrew).toBeNull();
    expect(container.textContent ?? "").toContain("AI analyze sập.");
  });

  it("opening the checklist is READ-ONLY: exactly GET /versions + POST /ai-analyze, zero other writes", async () => {
    const { calls } = await renderModal({});
    const writeCalls = calls.filter((c) => c.method !== "GET" && !/\/ai-analyze$/.test(c.url));
    expect(writeCalls).toEqual([]);
    expect(calls.some((c) => /\/versions$/.test(c.url) && c.method === "GET")).toBe(true);
    expect(calls.some((c) => /\/ai-analyze$/.test(c.url) && c.method === "POST")).toBe(true);
  });

  it("cleanup", () => {
    env.cleanup();
  });
});
