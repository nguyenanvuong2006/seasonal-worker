/**
 * Retention policy — pure tests (Phase 2). Không cần DB.
 */

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeRetentionUntil,
  DEFAULT_RETENTION_YEARS,
  getDefaultRetentionYears,
  isAllowedRetentionYears,
  isWithinRetention,
  RETENTION_OPTIONS,
} from "./retention.ts";

describe("retention policy", () => {
  it("default = 3 năm kể từ ngày merge", () => {
    const generated = new Date("2026-08-17T10:00:00Z");
    const { retentionUntil, policy } = computeRetentionUntil(generated, undefined);
    assert.equal(policy.years, 3);
    assert.equal(policy.source, "default");
    assert.equal(retentionUntil?.toISOString(), "2029-08-17T10:00:00.000Z");
  });

  it("template cấu hình 1/2/5/10 năm", () => {
    const generated = new Date("2026-08-17T10:00:00Z");
    assert.equal(
      computeRetentionUntil(generated, 1).retentionUntil?.toISOString(),
      "2027-08-17T10:00:00.000Z",
    );
    assert.equal(
      computeRetentionUntil(generated, 5).retentionUntil?.toISOString(),
      "2031-08-17T10:00:00.000Z",
    );
    assert.equal(
      computeRetentionUntil(generated, 10).retentionUntil?.toISOString(),
      "2036-08-17T10:00:00.000Z",
    );
  });

  it("không tự động xóa khi years = null", () => {
    const { retentionUntil, policy } = computeRetentionUntil(new Date(), null);
    assert.equal(retentionUntil, null);
    assert.equal(policy.years, null);
    assert.equal(policy.source, "template");
    assert.equal(isWithinRetention(retentionUntil), true);
  });

  it("retention tính RIÊNG từng PDF (2 PDF tạo khác ngày)", () => {
    const a = computeRetentionUntil(new Date("2026-08-17T10:00:00Z"), 3);
    const b = computeRetentionUntil(new Date("2027-03-05T10:00:00Z"), 3);
    assert.equal(a.retentionUntil?.toISOString(), "2029-08-17T10:00:00.000Z");
    assert.equal(b.retentionUntil?.toISOString(), "2030-03-05T10:00:00.000Z");
  });

  it("options hợp lệ gồm 1/2/3/5/10/none", () => {
    assert.deepEqual(
      RETENTION_OPTIONS.map((o) => o.years),
      [1, 2, 3, 5, 10, null],
    );
    assert.equal(isAllowedRetentionYears(3), true);
    assert.equal(isAllowedRetentionYears(7), false);
    assert.equal(isAllowedRetentionYears(null), true);
    assert.equal(isAllowedRetentionYears(undefined), true);
  });

  it("ENV default retention", () => {
    assert.equal(getDefaultRetentionYears({}), DEFAULT_RETENTION_YEARS);
    assert.equal(getDefaultRetentionYears({ MERGE_DEFAULT_RETENTION_YEARS: "5" }), 5);
    assert.equal(getDefaultRetentionYears({ MERGE_DEFAULT_RETENTION_YEARS: "abc" }), 3);
    assert.equal(getDefaultRetentionYears({ MERGE_DEFAULT_RETENTION_YEARS: "0" }), 3);
  });

  it("isWithinRetention boundary", () => {
    const until = new Date("2029-08-17T10:00:00Z");
    assert.equal(isWithinRetention(until, new Date("2029-08-17T09:59:59Z")), true);
    assert.equal(isWithinRetention(until, new Date("2029-08-17T10:00:00Z")), true);
    assert.equal(isWithinRetention(until, new Date("2029-08-17T10:00:01Z")), false);
  });
});
