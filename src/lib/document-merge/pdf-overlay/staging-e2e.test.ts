/**
 * PDF Overlay — staging E2E fixture tests (PR5).
 *
 * Chứng minh fixture NON-PRODUCTION:
 *   - KHÔNG PII (assertFixtureSafe)
 *   - deterministic (cùng input → cùng sha256)
 *   - page count đúng (structural gate)
 *   - no unresolved placeholders (mọi placeholder có giá trị, mọi position vẽ, 0 warning)
 *   - per-item variation deterministic + khác nhau giữa các item
 *   - snapshot parse/validate chặt
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";

import {
  OVERLAY_E2E_EXPECTED_PAGE_COUNT,
  buildStagingE2EBaseFieldValues,
  buildStagingE2EFieldValues,
  buildStagingE2EPositions,
  buildStagingE2ESnapshot,
  parseOverlayE2ESnapshot,
  renderStagingE2EItem,
} from "./staging-e2e.ts";
import { assertFixtureSafe, containsRealPii } from "./verification/production-isolation.ts";

test("staging-e2e fixture: field values KHÔNG chứa PII thật (assertFixtureSafe)", () => {
  const values = buildStagingE2EBaseFieldValues();
  assert.equal(containsRealPii(values), false, "không CCCD 12 số / phone / email thật");
  const safe = assertFixtureSafe(values);
  assert.equal(safe.safe, true, safe.reason);
});

test("staging-e2e fixture: per-item values deterministic và khác nhau giữa item", () => {
  const base = buildStagingE2EBaseFieldValues();
  const a = buildStagingE2EFieldValues(base, 1, 10);
  const b = buildStagingE2EFieldValues(base, 1, 10);
  const c = buildStagingE2EFieldValues(base, 2, 10);
  assert.deepEqual(a, b, "cùng index + total → cùng values (deterministic)");
  assert.notEqual(a.So_thu_tu, c.So_thu_tu);
  assert.equal(a.So_thu_tu, "1");
  assert.equal(a.Tong_so, "10");
  assert.equal(c.So_thu_tu, "2");
  assert.equal(c.Tong_so, "10");
});

test("staging-e2e fixture: mọi placeholder đều có giá trị (không unresolved placeholder)", () => {
  const values = buildStagingE2EFieldValues(buildStagingE2EBaseFieldValues(), 1, 10);
  const positions = buildStagingE2EPositions();
  const placeholders = positions.map((p) => p.placeholder);
  const missing = placeholders.filter((ph) => values[ph] === undefined);
  assert.deepEqual(missing, [], "mọi position spec đều có field value tương ứng");
  assert.ok(positions.length >= 10, "fixture phủ đa dạng position type");
});

test("staging-e2e fixture: render deterministic + đúng page count + no warnings", async () => {
  const snapshot = await buildStagingE2ESnapshot(1);
  const r1 = await renderStagingE2EItem(snapshot, 1, 1);
  const r2 = await renderStagingE2EItem(snapshot, 1, 1);
  assert.equal(r1.sha256, r2.sha256, "deterministic: cùng input → cùng sha256");
  assert.equal(r1.pageCount, OVERLAY_E2E_EXPECTED_PAGE_COUNT);
  assert.equal(r1.positionsDrawn, snapshot.positions.length, "mọi position được vẽ");
  assert.deepEqual(r1.warnings, [], "0 warning — không overflow / thiếu glyph");

  // Output parse lại được (PDF hợp lệ)
  const doc = await PDFDocument.load(r1.bytes);
  assert.equal(doc.getPageCount(), OVERLAY_E2E_EXPECTED_PAGE_COUNT);
});

test("staging-e2e fixture: các item khác nhau → sha256 khác nhau (đủ bằng chứng không duplicate)", async () => {
  const snapshot = await buildStagingE2ESnapshot(10);
  const shas = new Set<string>();
  for (let i = 1; i <= 10; i++) {
    const r = await renderStagingE2EItem(snapshot, i, 10);
    shas.add(r.sha256);
  }
  assert.equal(shas.size, 10, "10 item → 10 sha256 khác nhau (So_thu_tu/Tong_so làm output khác)");
});

test("staging-e2e snapshot: parse chấp nhận snapshot hợp lệ", async () => {
  const snapshot = await buildStagingE2ESnapshot(5);
  const parsed = parseOverlayE2ESnapshot({ engine: "PDF_OVERLAY", e2e: snapshot });
  assert.equal(parsed.kind, "staging-e2e-overlay");
  assert.equal(parsed.total, 5);
  assert.equal(parsed.expectedPageCount, OVERLAY_E2E_EXPECTED_PAGE_COUNT);
  assert.equal(parsed.nonProduction, true);
});

test("staging-e2e snapshot: parse từ chối metadata thiếu/không hợp lệ", () => {
  const cases: unknown[] = [
    null,
    {},
    { e2e: {} },
    { e2e: { kind: "other" } },
    { e2e: { kind: "staging-e2e-overlay", nonProduction: false } },
    { e2e: { kind: "staging-e2e-overlay", nonProduction: true, templatePdfB64: "", positions: [], fieldValues: {} } },
    { e2e: { kind: "staging-e2e-overlay", nonProduction: true, templatePdfB64: "AA==", positions: [], fieldValues: {} } },
  ];
  for (const c of cases) {
    assert.throws(() => parseOverlayE2ESnapshot(c), /OVERLAY_E2E_SNAPSHOT_INVALID/, JSON.stringify(c).slice(0, 80));
  }
});

test("staging-e2e snapshot: render từ snapshot khớp sha256 khi render trực tiếp", async () => {
  const snapshot = await buildStagingE2ESnapshot(3);
  const parsed = parseOverlayE2ESnapshot({ e2e: snapshot });
  const viaParsed = await renderStagingE2EItem(parsed, 2, 3);
  const direct = await renderStagingE2EItem(snapshot, 2, 3);
  assert.equal(viaParsed.sha256, direct.sha256);
  assert.equal(viaParsed.pageCount, 2);
});
