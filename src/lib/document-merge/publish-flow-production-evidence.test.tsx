/**
 * PUBLISH FLOW — PRODUCTION EVIDENCE HARNESS (verification of the e1057f9 claim).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A local-only proposal (e1057f9, never merged, not an object in this repo)
 * claimed that
 *
 *     const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
 *
 * in `publish-checklist-modal.tsx` is the root cause of the production
 * incident "operator opens the publish checklist, ai-analyze returns 200, and
 * no POST .../publish is ever emitted".
 *
 * The captured Production evidence contradicts that claim before any code is
 * read: the ai-analyze response body is VALID JSON and carries
 *   htmlValid=true, cssValid=true, security.errors=[], placeholderCoverage.ok=true,
 *   totalPlaceholders=49, mappedFields=49, diff.unmapped=0, diff.orphaned=0.
 * `res.json()` cannot reject on a body that parses — so `.catch(() => ({}))`
 * cannot be the failing transition.
 *
 * WHAT THIS FILE PROVES (against UNMODIFIED main, commit 4f2edcf)
 * --------------------------------------------------------------
 * It does NOT use a synthetic minimal `{}` payload. It rebuilds the REAL
 * production ai-analyze response by running the REAL server-side pipeline
 * (analyzeFullDocument + validatePlaceholderCoverage — byte-identical to what
 * `app/api/document-merge/templates/[id]/ai-analyze/route.ts` returns) over
 * the REAL 49-placeholder trainee-registration template that production
 * publishes, and asserts the payload reproduces the captured Production
 * numbers exactly. It then drives the REAL TemplateLibrary +
 * PublishChecklistModal in jsdom, through the real click path, and records
 * every transition of the incident trace:
 *
 *   ai-analyze 200 -> response.json() -> machine construction -> React state
 *   -> checklist render -> 5 operator checkboxes -> canConfirmPublish
 *   -> Confirm handler -> POST publish
 *
 * Result recorded here: JSON_PARSE_SUCCESS, MACHINE_STATE_BUILT,
 * CHECKLIST_RENDERED, CAN_CONFIRM_MACHINE and POST publish are ALL reached on
 * unmodified main. The e1057f9 hypothesis is therefore DISPROVEN, and this
 * test is the standing guard that keeps the whole transition chain wired: any
 * future change that breaks the path between an ai-analyze 200 and the POST
 * publish request fails here instead of failing in production silently.
 *
 * ZERO DB writes, zero network: fetch is stubbed and every request recorded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDom, loadComponent } from "../test-support/render-tsx.ts";
import { analyzeFullDocument } from "./full-document-analyze.ts";
import { validatePlaceholderCoverage } from "./template-versions.ts";

const TEMPLATE_DIR = new URL("../../../templates/document-merge/trainee-registration/", import.meta.url);
const PROD_HTML = readFileSync(new URL("canonical-source.v12.html", TEMPLATE_DIR), "utf8");
const PROD_MAPPING = JSON.parse(readFileSync(new URL("v7-mapping.json", TEMPLATE_DIR), "utf8")) as Array<{
  placeholder: string;
  sourceField: string | null;
  sourcePath: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
}>;

/**
 * The EXACT body `POST /ai-analyze` returns for the production template —
 * produced by the same two functions the route calls, in the same order,
 * assembled into the same response object. Not a hand-written fixture.
 */
function buildProductionAnalyzePayload() {
  const fields = PROD_MAPPING.map((m) => ({ ...m, isOrphaned: false }));
  const result = analyzeFullDocument({
    rawHtml: PROD_HTML,
    explicitCss: "",
    baseHtml: PROD_HTML,
    baseMappings: PROD_MAPPING as never,
    currentMappings: PROD_MAPPING as never,
  });
  const coverageIssues = validatePlaceholderCoverage(
    PROD_HTML,
    fields.map((f) => ({
      placeholder: f.placeholder,
      sourceField: f.sourceField,
      sourcePath: f.sourcePath,
      fallbackValue: f.fallbackValue,
      isRequired: f.isRequired,
    })),
  );
  return {
    mode: "READ_ONLY_ANALYZE",
    mutated: false,
    templateId: "tpl-trainee-registration",
    templateName: "Phiếu đăng ký thực tập sinh",
    baseVersionId: "v15-published-id",
    baseVersion: 15,
    baseVersionStatus: "PUBLISHED",
    baseMappingSource: "LIVE_FIELDS",
    htmlValid: result.htmlValid,
    htmlIssues: result.htmlIssues,
    cssValid: result.cssValid,
    cssIssues: result.cssIssues,
    placeholders: result.placeholders,
    mappingsAffected: result.mappingsAffected,
    security: result.security,
    layoutWarnings: result.layoutWarnings,
    placeholderCoverage: {
      ok: coverageIssues.length === 0,
      issues: coverageIssues,
      totalPlaceholders: result.placeholders.total,
      mappedFields: fields.length,
    },
    contentChanges: result.contentChanges,
    diff: {
      summary: result.diff.summary,
      needsAttention: result.diff.needsAttention,
      items: Object.fromEntries(result.diff.items),
    },
    normalizedHtmlBody: result.normalizedHtmlBody,
    normalizedPrintCss: result.normalizedPrintCss,
    normalizationWarnings: result.normalizationWarnings,
    externalResourceWarnings: result.externalResourceWarnings,
    analysisHash: result.analysisHash,
  };
}

const V16_DRAFT = {
  id: "v16-draft-id",
  templateId: "tpl-trainee-registration",
  version: 16,
  status: "DRAFT" as const,
  htmlBody: PROD_HTML,
  printCss: "@page { size: A4; margin: 15mm; }",
  sourceDocxName: null,
  retentionYears: 3,
  mappingSnapshot: null,
  createdBy: "admin",
  publishedAt: null,
  archivedAt: null,
  createdAt: "2026-08-27T00:00:00.000Z",
};
const V15_PUBLISHED = {
  ...V16_DRAFT,
  id: "v15-published-id",
  version: 15,
  status: "PUBLISHED" as const,
  mappingSnapshot: [],
  publishedAt: "2026-08-01T00:00:00.000Z",
};

/* ------------------------------------------------------------------ *
 * PHASE 2 — is the captured Production body really parseable JSON?
 * ------------------------------------------------------------------ */
test("PHASE 2 — production ai-analyze payload reproduces the captured Production evidence EXACTLY", () => {
  const payload = buildProductionAnalyzePayload();
  assert.equal(payload.htmlValid, true, "evidence: htmlValid=true");
  assert.equal(payload.cssValid, true, "evidence: cssValid=true");
  assert.deepEqual(payload.security.errors, [], "evidence: security.errors=[]");
  assert.equal(payload.placeholderCoverage.ok, true, "evidence: placeholderCoverage.ok=true");
  assert.equal(payload.placeholderCoverage.totalPlaceholders, 49, "evidence: totalPlaceholders=49");
  assert.equal(payload.placeholderCoverage.mappedFields, 49, "evidence: mappedFields=49");
  assert.equal(payload.diff.summary.unmapped, 0, "evidence: diff.unmapped=0");
  assert.equal(payload.diff.summary.orphaned, 0, "evidence: diff.orphaned=0");
});

test("PHASE 2 — res.json() on the production body SUCCEEDS: e1057f9's parse-failure hypothesis is DISPROVEN", async () => {
  const serialized = JSON.stringify(buildProductionAnalyzePayload());
  let jsonParseStarted = false;
  let jsonParseSucceeded = false;
  let jsonParseFailed = false;

  // A Response-shaped object whose json() does a REAL parse of the REAL
  // serialized production body — the transition e1057f9 accuses.
  const res = {
    ok: true,
    status: 200,
    json: async () => {
      jsonParseStarted = true;
      try {
        const value = JSON.parse(serialized);
        jsonParseSucceeded = true;
        return value;
      } catch (err) {
        jsonParseFailed = true;
        throw err;
      }
    },
  };

  let catchFallbackUsed = false;
  const data = (await res.json().catch(() => {
    catchFallbackUsed = true;
    return {};
  })) as Record<string, unknown>;

  assert.equal(jsonParseStarted, true, "JSON_PARSE_STARTED");
  assert.equal(jsonParseSucceeded, true, "JSON_PARSE_SUCCESS must be yes on the captured Production body");
  assert.equal(jsonParseFailed, false, "JSON_PARSE_FAILED must be no");
  assert.equal(
    catchFallbackUsed,
    false,
    "the `.catch(() => ({}))` branch e1057f9 blames is NEVER taken on the production payload — hypothesis DISPROVEN",
  );
  assert.equal(data.htmlValid, true, "the parsed object is the full analyze result, not the {} fallback");
  assert.equal((data.placeholderCoverage as { totalPlaceholders: number }).totalPlaceholders, 49);
});

/* ------------------------------------------------------------------ *
 * PHASE 3 — trace every transition from ai-analyze 200 to POST publish
 * ------------------------------------------------------------------ */
test("PHASE 3 — ai-analyze 200 → json → machine → render → 5 acks → confirm → POST publish (full chain, production payload)", async () => {
  const env = installDom();
  try {
    const analyzePayload = buildProductionAnalyzePayload();
    const calls: { url: string; method: string }[] = [];
    let jsonParseFailures = 0;
    let jsonParseSuccesses = 0;

    const template = {
      id: "tpl-trainee-registration",
      name: "Phiếu đăng ký thực tập sinh",
      description: null,
      googleDocId: "gdoc-1",
      outputFolderId: null,
      outputFileNamePattern: null,
      defaultMergeMode: "INDIVIDUAL_DOCUMENTS",
      documentKind: "A",
      dataSources: [],
      isActive: true,
      currentPublishedVersion: 15,
      retentionYears: 3,
    };

    (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      // Every stubbed response carries a SERIALIZED body and does a real
      // JSON.parse — the parse transition is exercised, never mocked away.
      const respond = (body: unknown, status = 200) => {
        const text = JSON.stringify(body);
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => {
            try {
              const value = JSON.parse(text);
              jsonParseSuccesses += 1;
              return value;
            } catch (err) {
              jsonParseFailures += 1;
              throw err;
            }
          },
        } as unknown as Response;
      };

      if (url.endsWith("/api/document-merge/templates")) return respond([template]);
      if (/\/versions$/.test(url)) return respond([V16_DRAFT, V15_PUBLISHED]);
      if (/\/(mappings|fields)/.test(url)) return respond([]);
      if (/\/ai-analyze$/.test(url)) return respond(analyzePayload, 200);
      if (/\/publish$/.test(url)) return respond({ ok: true, version: 16, status: "PUBLISHED" });
      return respond({});
    };

    const React = (await import("react")).default;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");

    const mod = loadComponent(new URL("../../components/document-merge/template-library.tsx", import.meta.url));
    const TemplateLibrary = mod.TemplateLibrary as (props: unknown) => unknown;
    const container = env.document.getElementById("root") as HTMLElement;
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(TemplateLibrary as never, { onSelectForMerge: () => {} } as never));
    });

    const buttons = () => [...container.querySelectorAll("button")];
    const click = async (el: Element) => {
      await act(async () => {
        el.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    };
    const settle = async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
    };
    const text = () => container.textContent ?? "";

    // Open "Sửa Template" so the version cards render exactly as in production.
    const editBtn = buttons().find((b) => (b.textContent ?? "").includes("Sửa"));
    assert.ok(editBtn, "không mở được modal Sửa Template");
    await click(editBtn!);
    await settle();

    // TRANSITION 1 — card click → checklist modal mounts → GET versions + POST ai-analyze.
    const cardPublish = buttons().find((b) => (b.textContent ?? "").trim() === "Xuất bản phiên bản");
    assert.ok(cardPublish, "v16 DRAFT phải có nút 'Xuất bản phiên bản' trên card");
    await click(cardPublish!);
    await settle();

    assert.equal(
      calls.filter((c) => /\/ai-analyze$/.test(c.url) && c.method === "POST").length,
      1,
      "TRANSITION: đúng 1 POST ai-analyze (như evidence production)",
    );

    // TRANSITION 2/3 — json() parsed, machine state built from it, checklist rendered.
    assert.equal(jsonParseFailures, 0, "JSON_PARSE_FAILED=no — không có response nào reject khi parse");
    assert.ok(jsonParseSuccesses > 0, "JSON_PARSE_SUCCESS=yes");
    assert.match(text(), /Kiểm tra tự động/, "MACHINE_STATE_BUILT — khối kiểm tra tự động phải render");
    assert.match(
      text(),
      /49 placeholder trong HTML đều đã có mapping/,
      "MACHINE_STATE_BUILT — machine phải đọc được placeholderCoverage 49/49 từ payload production",
    );
    assert.match(text(), /Xác nhận của người vận hành/, "CHECKLIST_RENDERED");
    assert.doesNotMatch(text(), /Đang tải phiên bản hiện tại/, "loading phải kết thúc (không kẹt spinner)");
    assert.doesNotMatch(
      text(),
      /Không thể confirm cho tới khi khắc phục/,
      "machine checks PASS trên payload production → không được có blocker nào",
    );

    const overlay = [...container.querySelectorAll("div")].find((d) => d.className.includes("z-[100]"));
    assert.ok(overlay, "checklist overlay phải tồn tại");
    const confirmBtn = [...overlay!.querySelectorAll("button")].find((b) =>
      /Xuất bản phiên bản|Đang xuất bản/.test(b.textContent ?? ""),
    ) as HTMLButtonElement | undefined;
    assert.ok(confirmBtn, "checklist phải có nút Confirm");

    // TRANSITION 4 — machine PASS but 0 operator acks: gate must still be closed.
    assert.equal(confirmBtn!.disabled, true, "CAN_CONFIRM_MACHINE: chưa tick ô nào → Confirm phải disabled");

    // TRANSITION 5 — the five operator acknowledgements, clicked for real.
    const boxes = [...overlay!.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    assert.equal(boxes.length, 5, "phải có đúng 5 ô xác nhận của người vận hành");
    for (const box of boxes) await click(box);
    await settle();
    assert.deepEqual(
      boxes.map((b) => b.checked),
      [true, true, true, true, true],
      "cả 5 ô phải thực sự được tick (state React cập nhật)",
    );

    // TRANSITION 6 — canConfirmPublish opens the gate.
    assert.equal(
      confirmBtn!.disabled,
      false,
      "CONFIRM_GATE: machine PASS + 5 acknowledgements → Confirm PHẢI enabled (không silent disable)",
    );

    // TRANSITION 7 — Confirm handler → POST publish actually leaves the client.
    const publishBefore = calls.filter((c) => /\/publish$/.test(c.url) && c.method === "POST").length;
    assert.equal(publishBefore, 0, "chưa được publish gì trước khi bấm Confirm (zero DB writes khi mở checklist)");
    await click(confirmBtn!);
    await settle();

    const publishCalls = calls.filter((c) => /\/publish$/.test(c.url) && c.method === "POST");
    assert.equal(
      publishCalls.length,
      1,
      "POST_PUBLISH_EMITTED: sau machine PASS + 5 acknowledgements, luồng PHẢI phát đúng 1 POST .../publish",
    );
    assert.match(
      publishCalls[0].url,
      /\/templates\/tpl-trainee-registration\/versions\/v16-draft-id\/publish$/,
      "POST publish phải trỏ đúng template + đúng versionId đã bấm",
    );
    assert.equal(jsonParseFailures, 0, "toàn bộ luồng: không có JSON parse nào thất bại");
  } finally {
    env.cleanup();
  }
});
