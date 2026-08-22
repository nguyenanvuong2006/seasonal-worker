import test from "node:test";
import assert from "node:assert/strict";

import {
  renderFixture,
  isOutputParseable,
  checkDeterministic,
  verifyFixture,
  runVisualVerification,
  hashReport,
} from "./visual-harness.ts";
import {
  fixtureVietnameseName,
  fixtureRequiredFieldFailure,
  fixtureFieldOverflowFailure,
  fixtureMultiPage,
  generateAllFixtures,
} from "./fixtures.ts";
import { readEmbeddedFontBytes } from "../vietnamese-font.ts";

const fontBytes = readEmbeddedFontBytes();

test("visual-harness: renderFixture thành công với fixture hợp lệ", async () => {
  const fixture = await fixtureVietnameseName();
  const { artifact, error } = await renderFixture(fixture, fontBytes);
  assert.ok(artifact);
  assert.ok(!error);
  assert.ok(artifact.bytes.byteLength > 0);
  assert.equal(artifact.sha256.length, 64);
  assert.equal(artifact.pageCount, 1);
  assert.equal(artifact.positionsDrawn, 1);
});

test("visual-harness: renderFixture trả error với fixture lỗi", async () => {
  const fixture = await fixtureRequiredFieldFailure();
  const { artifact, error, errorCode } = await renderFixture(fixture, fontBytes);
  assert.ok(!artifact);
  assert.ok(error);
  assert.equal(errorCode, "MISSING_REQUIRED_FIELD");
});

test("visual-harness: isOutputParseable trả true với PDF hợp lệ", async () => {
  const fixture = await fixtureVietnameseName();
  const { artifact } = await renderFixture(fixture, fontBytes);
  assert.ok(artifact);
  const parseable = await isOutputParseable(artifact.bytes);
  assert.equal(parseable, true);
});

test("visual-harness: isOutputParseable trả false với bytes rỗng", async () => {
  const parseable = await isOutputParseable(new Uint8Array(0));
  assert.equal(parseable, false);
});

test("visual-harness: checkDeterministic trả true khi output giống nhau", async () => {
  const fixture = await fixtureVietnameseName();
  const deterministic = await checkDeterministic(fixture, fontBytes);
  assert.equal(deterministic, true);
});

test("visual-harness: verifyFixture PASS với fixture hợp lệ", async () => {
  const fixture = await fixtureVietnameseName();
  const report = await verifyFixture(fixture, fontBytes);
  assert.equal(report.status, "PASS");
  assert.ok(report.artifact);
  assert.equal(report.checks.rendererSucceeded, true);
  assert.equal(report.checks.sha256Generated, true);
  assert.equal(report.checks.outputParseable, true);
});

test("visual-harness: verifyFixture PASS với fixture expectedError", async () => {
  const fixture = await fixtureRequiredFieldFailure();
  const report = await verifyFixture(fixture, fontBytes);
  assert.equal(report.status, "PASS");
  assert.ok(!report.artifact);
});

test("visual-harness: verifyFixture PASS với FIELD_OVERFLOW", async () => {
  const fixture = await fixtureFieldOverflowFailure();
  const report = await verifyFixture(fixture, fontBytes);
  assert.equal(report.status, "PASS");
});

test("visual-harness: verifyFixture kiểm tra pageCount với multi-page", async () => {
  const fixture = await fixtureMultiPage();
  const report = await verifyFixture(fixture, fontBytes);
  assert.equal(report.status, "PASS");
  assert.equal(report.checks.pageCountMatches, true);
  assert.equal(report.artifact!.pageCount, 3);
});

test("visual-harness: runVisualVerification chạy tất cả fixtures", async () => {
  const fixtures = await generateAllFixtures();
  const report = await runVisualVerification(fixtures);
  assert.equal(report.fixtures.length, 15);
  assert.equal(report.summary.total, 15);
  assert.ok(report.generatedAt);
  assert.equal(report.renderer, "pdf-overlay-renderer");
});

test("visual-harness: runVisualVerification tất cả fixtures PASS", async () => {
  const fixtures = await generateAllFixtures();
  const report = await runVisualVerification(fixtures);
  assert.equal(report.summary.passed, 15);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.deterministic, true);
});

test("visual-harness: hashReport trả SHA-256 hợp lệ", async () => {
  const fixtures = await generateAllFixtures();
  const report = await runVisualVerification(fixtures);
  const hash = hashReport(report);
  assert.equal(hash.length, 64);
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("visual-harness: hashReport deterministic", async () => {
  const fixtures = [await fixtureVietnameseName()];
  const report = await runVisualVerification(fixtures);
  const hash1 = hashReport(report);
  const hash2 = hashReport(report);
  assert.equal(hash1, hash2);
});
