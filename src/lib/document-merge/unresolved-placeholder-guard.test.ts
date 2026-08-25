import test from "node:test";
import assert from "node:assert/strict";
import { buildUnresolvedPlaceholderWarning, buildUnresolvedPlaceholderTitle } from "./unresolved-placeholder-guard.ts";

test("returns null when nothing is unresolved", () => {
  assert.equal(buildUnresolvedPlaceholderWarning([]), null);
  assert.equal(buildUnresolvedPlaceholderTitle([]), null);
});

test("lists unresolved keys with << >> delimiters restored, matches the Phase 4 example wording pattern", () => {
  const msg = buildUnresolvedPlaceholderWarning(["Ho_ten", "Nam_thue", "Dia_diem_ky"]);
  assert.ok(msg);
  assert.match(msg, /còn 3 trường chưa được thay thế/);
  assert.match(msg, /<<Ho_ten>>/);
  assert.match(msg, /<<Nam_thue>>/);
  assert.match(msg, /<<Dia_diem_ky>>/);
});

test("singular count of 1 still reads naturally", () => {
  const msg = buildUnresolvedPlaceholderWarning(["Ho_ten"]);
  assert.match(msg ?? "", /còn 1 trường chưa được thay thế: <<Ho_ten>>/);
});

test("title variant is short and does not enumerate keys (fits a print toolbar)", () => {
  const title = buildUnresolvedPlaceholderTitle(["Ho_ten", "Nam_thue"]);
  assert.match(title ?? "", /còn 2 trường chưa được thay thế/);
  assert.doesNotMatch(title ?? "", /Ho_ten/);
});
