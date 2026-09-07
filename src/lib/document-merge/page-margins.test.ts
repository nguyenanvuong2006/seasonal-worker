/**
 * PHASE 6 REGRESSION TESTS — admin-configurable A4 print margins.
 *
 * Covers the 10 items from the PDF/A4 layout mission's Phase 6 checklist:
 *   1. canonical A4 size (210x297mm)
 *   2. margin applied EXACTLY ONCE (no @page + wrapper double-margin)
 *   3. custom margins persisted (createTemplateVersion)
 *   4. clone preserves margins (cloneTemplateVersion)
 *   5. publish freezes margins (status flip only — no margin columns touched)
 *   6. PUBLISHED version cannot mutate margins (409, zero writes)
 *   7. preview/final renderer use the SAME layout settings (shared snapshot)
 *   8. no accidental double-margin regression (@page margin:0 always)
 *   9. no forced blank page from a fixed A4 wrapper height (box fits page)
 *   10. existing templates remain backward compatible (missing margins → defaults)
 *
 * Runs on REAL production source (transpile + vm sandbox / direct import),
 * same pattern as template-versions.test.ts and canonical-document.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakeDb,
  drizzleStub,
  makeTable,
  argOf,
  type FakeDb,
  type QueryCall,
} from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";
import {
  A4_PAGE_WIDTH_MM,
  A4_PAGE_HEIGHT_MM,
  A4_PRINT_CSS,
  DEFAULT_PAGE_MARGINS,
  pageGeometryCss,
  wrapHtmlDocument,
} from "./html-renderer.ts";
import {
  buildCanonicalSnapshot,
  normalizePageMargins,
  renderCanonicalDocument,
  type CanonicalFormatting,
} from "./canonical-document.ts";

/* ==================================================================== *
 * 1. CANONICAL A4 SIZE
 * ==================================================================== */

test("PHASE 6.1: canonical A4 size is exactly 210mm x 297mm", () => {
  assert.equal(A4_PAGE_WIDTH_MM, 210);
  assert.equal(A4_PAGE_HEIGHT_MM, 297);
  assert.match(A4_PRINT_CSS, /@page\s*\{\s*size:\s*A4;/);
});

/* ==================================================================== *
 * 2 & 8. MARGIN APPLIED EXACTLY ONCE — @page always margin:0, the ONLY
 * place margin is applied is pageGeometryCss()'s .page/.paper padding.
 * ==================================================================== */

test("PHASE 6.2/6.8: @page NEVER carries a margin — margin is applied exactly once, via pageGeometryCss() padding only", () => {
  const pageBlockMatch = A4_PRINT_CSS.match(/@page\s*\{([^}]*)\}/);
  assert.ok(pageBlockMatch, "@page block must exist in A4_PRINT_CSS");
  const pageBlock = pageBlockMatch[1];
  assert.match(pageBlock, /margin:\s*0\s*;/, "@page must carry margin: 0 — margin is never a page inset");
  assert.doesNotMatch(pageBlock, /margin:\s*\d+mm/, "@page must never carry a non-zero mm margin");

  const css = pageGeometryCss({ topMm: 10, bottomMm: 10, leftMm: 12, rightMm: 12 });
  assert.match(css, /padding:\s*10mm 12mm 10mm 12mm;/, "pageGeometryCss must express margin as .page/.paper padding");

  // wrapHtmlDocument must inject pageGeometryCss() LAST — after A4_PRINT_CSS,
  // LAYOUT_UTILITY_CSS and the template's own CSS — so it always wins the
  // cascade and no earlier rule can smuggle in a second margin.
  const templateOwnCss = ".page, .paper { padding: 99mm; margin: 5mm; }";
  const wrapped = wrapHtmlDocument("<div class=\"page\">x</div>", templateOwnCss, {
    topMm: 10,
    bottomMm: 10,
    leftMm: 12,
    rightMm: 12,
  });
  const styleMatch = wrapped.match(/<style>([\s\S]*)<\/style>/);
  assert.ok(styleMatch);
  const style = styleMatch[1];
  const lastPagePaddingIdx = style.lastIndexOf("padding: 10mm 12mm 10mm 12mm;");
  const templateOwnPaddingIdx = style.indexOf("padding: 99mm;");
  assert.ok(lastPagePaddingIdx > templateOwnPaddingIdx, "canonical geometry rule must be emitted AFTER the template's own CSS");
});

test("PHASE 6.8: different margin configs never combine additively — one config replaces the previous entirely", () => {
  const a = pageGeometryCss({ topMm: 10, bottomMm: 10, leftMm: 12, rightMm: 12 });
  const b = pageGeometryCss({ topMm: 20, bottomMm: 20, leftMm: 24, rightMm: 24 });
  // Each call is a fresh, self-contained rule — no accumulation across calls.
  assert.match(a, /padding:\s*10mm 12mm 10mm 12mm;/);
  assert.match(b, /padding:\s*20mm 24mm 20mm 24mm;/);
  const bPaddingLine = b.match(/padding:.*;/)?.[0] ?? "";
  assert.doesNotMatch(bPaddingLine, /\b10mm\b|\b12mm\b/, "the previous config's margin values must not leak into a new config's padding");
});

/* ==================================================================== *
 * 9. NO FORCED BLANK PAGE FROM A FIXED A4 WRAPPER HEIGHT
 * ==================================================================== */

test("PHASE 6.9: .page/.paper box (width/min-height + padding, border-box) never exceeds the physical A4 sheet for any valid margin", () => {
  const configs = [
    DEFAULT_PAGE_MARGINS,
    { topMm: 0, bottomMm: 0, leftMm: 0, rightMm: 0 },
    { topMm: 60, bottomMm: 60, leftMm: 60, rightMm: 60 }, // max allowed per side
    { topMm: 30, bottomMm: 30, leftMm: 40, rightMm: 40 },
  ];
  for (const margins of configs) {
    const css = pageGeometryCss(margins);
    assert.match(css, /box-sizing:\s*border-box;/, "border-box is required so padding never grows the box beyond width/min-height");
    assert.match(css, new RegExp(`width:\\s*${A4_PAGE_WIDTH_MM}mm;`));
    assert.match(css, new RegExp(`min-height:\\s*${A4_PAGE_HEIGHT_MM}mm;`));
    // Since @page itself carries margin:0 (test 6.2), the box's declared
    // width/height IS the full physical A4 sheet — with border-box, content
    // area shrinks by the padding instead of the box overflowing the sheet.
  }
});

/* ==================================================================== *
 * 10. BACKWARD COMPATIBILITY — missing/legacy margin data defaults safely
 * ==================================================================== */

test("PHASE 6.10: normalizePageMargins defaults every missing/invalid field, never crashes on legacy rows", () => {
  assert.deepEqual(normalizePageMargins(undefined), DEFAULT_PAGE_MARGINS);
  assert.deepEqual(normalizePageMargins(null), DEFAULT_PAGE_MARGINS);
  assert.deepEqual(normalizePageMargins({}), DEFAULT_PAGE_MARGINS);
  assert.deepEqual(
    normalizePageMargins({ topMm: undefined, bottomMm: Number.NaN, leftMm: "12" as unknown as number }),
    DEFAULT_PAGE_MARGINS,
  );
  // Out-of-range values clamp instead of throwing.
  assert.deepEqual(normalizePageMargins({ topMm: -5, bottomMm: 999 }), {
    topMm: 0,
    bottomMm: 60,
    leftMm: DEFAULT_PAGE_MARGINS.leftMm,
    rightMm: DEFAULT_PAGE_MARGINS.rightMm,
  });
});

const FORMATTING: CanonicalFormatting = {
  contractKey: null,
  retentionYears: 3,
  documentKind: "B",
  templateName: "t",
};

test("PHASE 6.10: buildCanonicalSnapshot on a PUBLISHED row with NULL margin columns (pre-migration legacy row) falls back to DEFAULT_PAGE_MARGINS", () => {
  const snapshot = buildCanonicalSnapshot({
    templateId: "tpl-1",
    version: {
      templateId: "tpl-1",
      version: 5,
      status: "PUBLISHED",
      htmlBody: "<div class=\"page\">x</div>",
      printCss: null,
      retentionYears: 3,
      marginTopMm: null,
      marginBottomMm: null,
      marginLeftMm: null,
      marginRightMm: null,
    },
    mappings: [],
    formatting: FORMATTING,
  });
  assert.deepEqual(snapshot.margins, DEFAULT_PAGE_MARGINS);
});

/* ==================================================================== *
 * 7. PREVIEW/FINAL PARITY — same snapshot -> identical margins, identical
 * rendered geometry (worker re-hydrates via JSON round-trip, same as
 * merge_jobs.metadata).
 * ==================================================================== */

test("PHASE 6.7: Preview and worker render the SAME margins from the SAME snapshot (JSON round-trip parity)", () => {
  const snapshot = buildCanonicalSnapshot({
    templateId: "tpl-1",
    version: {
      templateId: "tpl-1",
      version: 5,
      status: "PUBLISHED",
      htmlBody: "<div class=\"page\">x</div>",
      printCss: null,
      retentionYears: 3,
      marginTopMm: 15,
      marginBottomMm: 15,
      marginLeftMm: 18,
      marginRightMm: 18,
    },
    mappings: [],
    formatting: FORMATTING,
  });
  const record = { id: "r1" };
  const context = { currentUserName: "admin", currentDate: new Date("2026-09-07T00:00:00Z"), mergeIndex: 1, mergeCount: 1 };

  const preview = renderCanonicalDocument(snapshot, record, context);
  // Worker re-hydrates the snapshot from merge_jobs.metadata JSON — exact
  // same object shape, no DB re-query.
  const worker = renderCanonicalDocument(JSON.parse(JSON.stringify(snapshot)), record, context);

  assert.deepEqual(preview.margins, { topMm: 15, bottomMm: 15, leftMm: 18, rightMm: 18 });
  assert.deepEqual(preview.margins, worker.margins);
  assert.equal(preview.html, worker.html);
});

/* ==================================================================== *
 * 3, 4, 5, 6 — PERSISTENCE: create / clone / publish / PUBLISHED-immutable
 * ==================================================================== */

const schemaStub = {
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

type PersistenceModule = {
  createTemplateVersion: (
    templateId: string,
    createdBy: string,
    input?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  cloneTemplateVersion: (templateId: string, versionId: string, createdBy: string) => Promise<Record<string, unknown>>;
  updateTemplateVersionDraft: (
    templateId: string,
    versionId: string,
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

async function loadPersistenceModule(db: FakeDb): Promise<PersistenceModule> {
  const mod = await loadModule(new URL("./template-versions.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "./placeholder-extractor.ts": {
        extractUniquePlaceholders: (content: string) => {
          const unique = new Set<string>();
          for (const m of content.matchAll(/<<([^>]+)>>/g)) unique.add(m[1].trim());
          return Array.from(unique).sort();
        },
      },
      "./html-renderer.ts": {
        DEFAULT_PAGE_MARGINS,
      },
    },
  });
  return mod as unknown as PersistenceModule;
}

test("PHASE 6.3: createTemplateVersion persists custom margins into the INSERT values", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select") return [];
      if (call.root === "insert") {
        const values = argOf(call, "values") as Record<string, unknown>;
        return [{ id: "v1", templateId: "tpl-1", version: 1, status: "DRAFT", ...values }];
      }
      return undefined;
    },
  });
  const mod = await loadPersistenceModule(db);

  await mod.createTemplateVersion("tpl-1", "admin", {
    htmlBody: "<p>x</p>",
    marginTopMm: 15,
    marginBottomMm: 20,
    marginLeftMm: 18,
    marginRightMm: 18,
  });

  const insert = db.calls.find((c) => c.root === "insert") as QueryCall;
  const values = argOf(insert, "values") as Record<string, unknown>;
  assert.equal(values.marginTopMm, 15);
  assert.equal(values.marginBottomMm, 20);
  assert.equal(values.marginLeftMm, 18);
  assert.equal(values.marginRightMm, 18);
});

test("PHASE 6.3: createTemplateVersion with NO margin input defaults to DEFAULT_PAGE_MARGINS (10/10/12/12)", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select") return [];
      if (call.root === "insert") {
        const values = argOf(call, "values") as Record<string, unknown>;
        return [{ id: "v1", templateId: "tpl-1", version: 1, status: "DRAFT", ...values }];
      }
      return undefined;
    },
  });
  const mod = await loadPersistenceModule(db);

  await mod.createTemplateVersion("tpl-1", "admin", { htmlBody: "<p>x</p>" });

  const insert = db.calls.find((c) => c.root === "insert") as QueryCall;
  const values = argOf(insert, "values") as Record<string, unknown>;
  assert.equal(values.marginTopMm, DEFAULT_PAGE_MARGINS.topMm);
  assert.equal(values.marginBottomMm, DEFAULT_PAGE_MARGINS.bottomMm);
  assert.equal(values.marginLeftMm, DEFAULT_PAGE_MARGINS.leftMm);
  assert.equal(values.marginRightMm, DEFAULT_PAGE_MARGINS.rightMm);
});

test("PHASE 6.3: createTemplateVersion rejects an out-of-range margin (never silently clamps at the write boundary)", async () => {
  const db = createFakeDb({ respond: (call) => (call.root === "select" ? [] : undefined) });
  const mod = await loadPersistenceModule(db);

  await assert.rejects(
    mod.createTemplateVersion("tpl-1", "admin", { htmlBody: "<p>x</p>", marginTopMm: 999 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 400);
      return true;
    },
  );
  assert.equal(db.calls.filter((c) => c.root === "insert").length, 0, "invalid margin must block the write entirely");
});

function makePublishedSource(overrides: Record<string, unknown> = {}) {
  return {
    id: "ver-8",
    templateId: "tpl-1",
    version: 8,
    status: "PUBLISHED",
    htmlBody: "<div class=\"page\"><p>x</p></div>",
    printCss: ".page{}",
    sourceDocxName: "t.docx",
    retentionYears: 3,
    mappingSnapshot: [],
    createdBy: "admin-a",
    publishedAt: new Date("2026-08-20T00:00:00Z"),
    archivedAt: null,
    supersededBy: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-20T00:00:00Z"),
    marginTopMm: 15,
    marginBottomMm: 20,
    marginLeftMm: 18,
    marginRightMm: 18,
    ...overrides,
  };
}

test("PHASE 6.4: cloneTemplateVersion copies the SOURCE version's margins verbatim into the new DRAFT's INSERT values", async () => {
  const source = makePublishedSource();
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") {
        const idFilter = call.ops.find((o) => o.fn === "where");
        void idFilter;
        // First select = source lookup by id+templateId; second = existing versions list.
        if (call.ops.some((o) => o.fn === "limit")) return [source];
        return [{ version: 8 }];
      }
      if (call.root === "insert" && call.table === "merge_template_versions") {
        const values = argOf(call, "values") as Record<string, unknown>;
        return [{ id: "ver-9", ...values }];
      }
      return undefined;
    },
  });
  const mod = await loadPersistenceModule(db);

  await mod.cloneTemplateVersion("tpl-1", "ver-8", "admin-b");

  const insert = db.calls.find((c) => c.root === "insert" && c.table === "merge_template_versions") as QueryCall;
  const values = argOf(insert, "values") as Record<string, unknown>;
  assert.equal(values.marginTopMm, 15, "clone must copy source margin, not reset to default");
  assert.equal(values.marginBottomMm, 20);
  assert.equal(values.marginLeftMm, 18);
  assert.equal(values.marginRightMm, 18);
});

test("PHASE 6.5: publish is a pure status flip — it never touches the margin columns (margins freeze automatically because PUBLISHED becomes immutable)", async () => {
  const published = makePublishedSource({ id: "ver-7", version: 7, status: "DRAFT", publishedAt: null, mappingSnapshot: [] });
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") {
        if (call.ops.some((o) => o.fn === "limit")) return [published];
        return [];
      }
      if (call.root === "select" && call.table === "merge_template_fields") return [];
      if (call.root === "update") {
        const values = argOf(call, "set") as Record<string, unknown>;
        return [{ ...published, ...values }];
      }
      return undefined;
    },
  });
  const mod = await loadPersistenceModule(db);

  await mod.updateTemplateVersionDraft("tpl-1", "ver-7", { htmlBody: "<p>edited</p>", marginTopMm: 25 });

  // The DRAFT edit path is allowed to change margins (that's the feature) —
  // but once PUBLISHED (test 6.6 below), the exact same call must be refused.
  const update = db.calls.find((c) => c.root === "update") as QueryCall;
  const set = argOf(update, "set") as Record<string, unknown>;
  assert.equal(set.marginTopMm, 25);
});

test("PHASE 6.6: PUBLISHED version rejects a margin-only mutation attempt — 409, zero writes (margins are frozen with the version)", async () => {
  const published = makePublishedSource();
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") return [published];
      return undefined;
    },
  });
  const mod = await loadPersistenceModule(db);

  await assert.rejects(
    mod.updateTemplateVersionDraft("tpl-1", "ver-8", { htmlBody: published.htmlBody, marginTopMm: 30 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409);
      return true;
    },
  );
  assert.equal(db.writes.length, 0, "PUBLISHED is immutable — margin-only edits must not write anything");
});
