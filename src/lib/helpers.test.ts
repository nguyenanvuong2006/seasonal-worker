import test from "node:test";
import assert from "node:assert/strict";
import { toVNTimeStr } from "./helpers.ts";

/** MISSION E section 15-18 — wall-clock HH:MM in Asia/Ho_Chi_Minh, used by meal-cutoff.ts. */
test("toVNTimeStr converts a UTC instant to the correct Asia/Ho_Chi_Minh HH:MM", () => {
  // 03:00 UTC == 10:00 ICT (UTC+7).
  assert.equal(toVNTimeStr(new Date("2026-09-13T03:00:00.000Z")), "10:00");
  // 23:30 UTC == 06:30 ICT the NEXT calendar day — the case a raw UTC-hour read gets wrong.
  assert.equal(toVNTimeStr(new Date("2026-09-13T23:30:00.000Z")), "06:30");
  // Midnight UTC == 07:00 ICT.
  assert.equal(toVNTimeStr(new Date("2026-09-13T00:00:00.000Z")), "07:00");
});
