import test from "node:test";
import assert from "node:assert/strict";
import {
  PUBLISH_CHECKLIST_ITEMS,
  allChecklistItemsConfirmed,
  canConfirmPublish,
  emptyPublishChecklistState,
  machineChecksPassed,
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

test("machineChecksPassed: requires htmlValid AND cssValid AND zero security blockers", () => {
  assert.equal(machineChecksPassed({ htmlValid: true, cssValid: true, securityBlockerCount: 0 }), true);
  assert.equal(machineChecksPassed({ htmlValid: false, cssValid: true, securityBlockerCount: 0 }), false);
  assert.equal(machineChecksPassed({ htmlValid: true, cssValid: false, securityBlockerCount: 0 }), false);
  assert.equal(machineChecksPassed({ htmlValid: true, cssValid: true, securityBlockerCount: 1 }), false, "any security blocker must fail machine checks");
});

test("canConfirmPublish: false when machine checks have not loaded (null)", () => {
  const allChecked = { ...emptyPublishChecklistState() };
  for (const item of PUBLISH_CHECKLIST_ITEMS) allChecked[item.key] = true;
  assert.equal(canConfirmPublish(null, allChecked), false, "analysis must have run before publish can be confirmed");
});

test("canConfirmPublish: false when machine checks fail, even with all operator boxes checked", () => {
  const allChecked = { ...emptyPublishChecklistState() };
  for (const item of PUBLISH_CHECKLIST_ITEMS) allChecked[item.key] = true;
  assert.equal(canConfirmPublish({ htmlValid: false, cssValid: true, securityBlockerCount: 0 }, allChecked), false);
  assert.equal(canConfirmPublish({ htmlValid: true, cssValid: true, securityBlockerCount: 3 }, allChecked), false, "operator checkboxes can never override a real security blocker");
});

test("canConfirmPublish: false when machine checks pass but operator has not confirmed everything", () => {
  const machine = { htmlValid: true, cssValid: true, securityBlockerCount: 0 };
  assert.equal(canConfirmPublish(machine, emptyPublishChecklistState()), false);
});

test("canConfirmPublish: true only when machine checks pass AND every operator box is checked", () => {
  const machine = { htmlValid: true, cssValid: true, securityBlockerCount: 0 };
  const allChecked = { ...emptyPublishChecklistState() };
  for (const item of PUBLISH_CHECKLIST_ITEMS) allChecked[item.key] = true;
  assert.equal(canConfirmPublish(machine, allChecked), true);
});

test("the visual confirmation checkbox (layoutA4) is never auto-checked by any helper in this module", () => {
  const state = emptyPublishChecklistState();
  assert.equal(state.layoutA4, false);
  // No function in this module mutates a checklist state — confirming a
  // checkbox is exclusively a UI-driven action (onChange in the modal).
});
