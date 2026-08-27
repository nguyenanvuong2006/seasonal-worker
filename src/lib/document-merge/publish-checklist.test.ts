import test from "node:test";
import assert from "node:assert/strict";
import {
  PUBLISH_CHECKLIST_ITEMS,
  allChecklistItemsConfirmed,
  canConfirmPublish,
  describePublishBlockers,
  emptyPublishChecklistState,
  machineChecksPassed,
  type PublishMachineChecks,
} from "./publish-checklist.ts";

test("emptyPublishChecklistState: every item starts unchecked — never pre-confirmed", () => {
  const state = emptyPublishChecklistState();
  for (const item of PUBLISH_CHECKLIST_ITEMS) {
    assert.equal(state[item.key], false, `${item.key} must start false`);
  }
  assert.equal(Object.keys(state).length, PUBLISH_CHECKLIST_ITEMS.length);
});

test("PUBLISH_CHECKLIST_ITEMS: exactly the 5 mission-specified operator checks", () => {
  assert.deepEqual(
    PUBLISH_CHECKLIST_ITEMS.map((i) => i.key),
    ["previewed", "printed", "layoutA4", "legalContent", "mergeData"],
  );
});

test("allChecklistItemsConfirmed: false unless every single item is true", () => {
  const empty = emptyPublishChecklistState();
  assert.equal(allChecklistItemsConfirmed(empty), false);

  const allButOne = { ...emptyPublishChecklistState() };
  for (const item of PUBLISH_CHECKLIST_ITEMS) allButOne[item.key] = true;
  allButOne[PUBLISH_CHECKLIST_ITEMS[0].key] = false;
  assert.equal(allChecklistItemsConfirmed(allButOne), false, "one unchecked item must still block");

  const all = { ...emptyPublishChecklistState() };
  for (const item of PUBLISH_CHECKLIST_ITEMS) all[item.key] = true;
  assert.equal(allChecklistItemsConfirmed(all), true);
});

const PASSING_MACHINE: PublishMachineChecks = {
  htmlValid: true,
  htmlIssueCount: 0,
  cssValid: true,
  cssIssueCount: 0,
  securityBlockerCount: 0,
  placeholderCoverageOk: true,
  unmappedPlaceholders: [],
  requiredUnresolvablePlaceholders: [],
  hasHtmlBody: true,
  versionStatus: "DRAFT",
  statusPublishable: true,
};

function allChecked() {
  const all = { ...emptyPublishChecklistState() };
  for (const item of PUBLISH_CHECKLIST_ITEMS) all[item.key] = true;
  return all;
}

test("machineChecksPassed: requires htmlValid AND cssValid AND zero security blockers", () => {
  assert.equal(machineChecksPassed({ ...PASSING_MACHINE }), true);
  assert.equal(machineChecksPassed({ ...PASSING_MACHINE, htmlValid: false }), false);
  assert.equal(machineChecksPassed({ ...PASSING_MACHINE, cssValid: false }), false);
  assert.equal(machineChecksPassed({ ...PASSING_MACHINE, securityBlockerCount: 1 }), false, "any security blocker must fail machine checks");
});

test("machineChecksPassed: placeholder coverage is a machine gate (mirrors backend validatePlaceholderCoverage)", () => {
  assert.equal(machineChecksPassed({ ...PASSING_MACHINE, placeholderCoverageOk: false }), false, "unmapped placeholder must block, exactly like the backend publish");
  assert.equal(
    machineChecksPassed({ ...PASSING_MACHINE, placeholderCoverageOk: false, unmappedPlaceholders: ["ABC", "XYZ"] }),
    false,
  );
});

test("machineChecksPassed: empty html_body blocks (backend 400 'chưa có nội dung HTML')", () => {
  assert.equal(machineChecksPassed({ ...PASSING_MACHINE, hasHtmlBody: false }), false);
});

test("machineChecksPassed: status must be publishable (DRAFT for publish / ARCHIVED for rollback; PUBLISHED is a no-op)", () => {
  assert.equal(machineChecksPassed({ ...PASSING_MACHINE, versionStatus: "PUBLISHED", statusPublishable: false }), false);
  assert.equal(
    machineChecksPassed({ ...PASSING_MACHINE, versionStatus: "ARCHIVED", statusPublishable: true }),
    true,
    "ARCHIVED is publishable via the rollback ('Khôi phục') path",
  );
  assert.equal(machineChecksPassed({ ...PASSING_MACHINE, versionStatus: "UNKNOWN", statusPublishable: false }), false);
});

test("canConfirmPublish: false when machine checks have not loaded (null)", () => {
  assert.equal(canConfirmPublish(null, allChecked()), false, "fresh row + analysis must have loaded before publish can be confirmed");
});

test("canConfirmPublish: false when machine checks fail, even with all operator boxes checked", () => {
  assert.equal(canConfirmPublish({ ...PASSING_MACHINE, htmlValid: false }, allChecked()), false);
  assert.equal(canConfirmPublish({ ...PASSING_MACHINE, securityBlockerCount: 3 }, allChecked()), false, "operator checkboxes can never override a real security blocker");
  assert.equal(
    canConfirmPublish({ ...PASSING_MACHINE, placeholderCoverageOk: false, unmappedPlaceholders: ["So_hop_dong"] }, allChecked()),
    false,
    "operator checkboxes can never override an unmapped placeholder",
  );
});

test("canConfirmPublish: false when machine checks pass but operator has not confirmed everything", () => {
  assert.equal(canConfirmPublish({ ...PASSING_MACHINE }, emptyPublishChecklistState()), false);
});

test("canConfirmPublish: true only when machine checks pass AND every operator box is checked", () => {
  assert.equal(canConfirmPublish({ ...PASSING_MACHINE }, allChecked()), true);
});

test("the visual confirmation checkbox (layoutA4) is never auto-checked by any helper in this module", () => {
  const state = emptyPublishChecklistState();
  assert.equal(state.layoutA4, false);
  // No function in this module mutates a checklist state — confirming a
  // checkbox is exclusively a UI-driven action (onChange in the modal).
});

// ---------------------------------------------------------------
// describePublishBlockers — a disabled Confirm must always be EXPLAINABLE.
// ---------------------------------------------------------------

test("describePublishBlockers: passing machine → empty list (nothing to explain)", () => {
  assert.deepEqual(describePublishBlockers({ ...PASSING_MACHINE }), []);
});

test("describePublishBlockers: unmapped placeholders are listed BY NAME (the exact blocker format)", () => {
  const blockers = describePublishBlockers({
    ...PASSING_MACHINE,
    placeholderCoverageOk: false,
    unmappedPlaceholders: ["ABC", "XYZ"],
  });
  assert.ok(blockers.some((b) => b.includes("2 placeholder trong HTML chưa được mapping: ABC, XYZ")));
});

test("describePublishBlockers: required-unresolvable placeholders are listed BY NAME", () => {
  const blockers = describePublishBlockers({
    ...PASSING_MACHINE,
    placeholderCoverageOk: false,
    requiredUnresolvablePlaceholders: ["So_hop_dong"],
  });
  assert.ok(blockers.some((b) => b.includes("1 placeholder BẮT BUỘC chưa có nguồn dữ liệu/fallback: So_hop_dong")));
});

test("describePublishBlockers: empty html_body → explicit blocker", () => {
  const blockers = describePublishBlockers({ ...PASSING_MACHINE, hasHtmlBody: false });
  assert.ok(blockers.some((b) => b.includes("html_body trống")));
});

test("describePublishBlockers: PUBLISHED status → 'không có gì để publish' (no (re)publish of PUBLISHED)", () => {
  const blockers = describePublishBlockers({ ...PASSING_MACHINE, versionStatus: "PUBLISHED", statusPublishable: false });
  assert.ok(blockers.some((b) => b.includes("HIỆN ĐANG PUBLISHED")));
});

test("describePublishBlockers: multiple failures → one specific line each, in checklist order (status line last)", () => {
  const blockers = describePublishBlockers({
    ...PASSING_MACHINE,
    hasHtmlBody: true,
    htmlValid: false,
    htmlIssueCount: 3,
    cssValid: false,
    cssIssueCount: 1,
    securityBlockerCount: 2,
    placeholderCoverageOk: false,
    unmappedPlaceholders: ["A"],
    requiredUnresolvablePlaceholders: ["B"],
    versionStatus: "PUBLISHED",
    statusPublishable: false,
  });
  assert.equal(blockers.length, 6);
  assert.equal(blockers[0].includes("3 lỗi cấu trúc"), true);
  assert.equal(blockers[1].includes("1 lỗi cấu trúc"), true);
  assert.equal(blockers[2].includes("2 mã nguy hiểm"), true);
  assert.equal(blockers[3].includes("A"), true);
  assert.equal(blockers[4].includes("B"), true);
  assert.equal(blockers[5].includes("HIỆN ĐANG PUBLISHED"), true);
});
