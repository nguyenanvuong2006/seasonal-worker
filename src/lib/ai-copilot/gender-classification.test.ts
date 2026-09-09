import test from "node:test";
import assert from "node:assert/strict";
import { classifyGender, tallyGender } from "./gender-classification.ts";

test("classifyGender recognizes the same Nam/Nữ variants as isMale/isFemale", () => {
  assert.equal(classifyGender("Nam"), "MALE");
  assert.equal(classifyGender("nam"), "MALE");
  assert.equal(classifyGender("Male"), "MALE");
  assert.equal(classifyGender("Nữ"), "FEMALE");
  assert.equal(classifyGender("nu"), "FEMALE");
  assert.equal(classifyGender("Female"), "FEMALE");
});

test("classifyGender returns UNKNOWN for null/undefined/empty/unrecognized values — never throws, never guesses", () => {
  assert.equal(classifyGender(null), "UNKNOWN");
  assert.equal(classifyGender(undefined), "UNKNOWN");
  assert.equal(classifyGender(""), "UNKNOWN");
  assert.equal(classifyGender("   "), "UNKNOWN");
  assert.equal(classifyGender("Khác"), "UNKNOWN");
  assert.equal(classifyGender("N/A"), "UNKNOWN");
  assert.equal(classifyGender("???"), "UNKNOWN");
});

test("tallyGender: male + female + unknownGender === total always, by construction", () => {
  const genders = ["Nam", "Nữ", "Nữ", null, "", "Nam", "unrecognized-legacy-value"];
  const result = tallyGender(genders);
  assert.equal(result.male, 2);
  assert.equal(result.female, 2);
  assert.equal(result.unknownGender, 3);
  assert.equal(result.total, 7);
  assert.equal(result.male + result.female + result.unknownGender, result.total);
});

test("tallyGender reproduces the reported Production case: 542 total, 186 male, 355 female -> 1 unknownGender", () => {
  const genders = [...Array(186).fill("Nam"), ...Array(355).fill("Nữ"), null];
  const result = tallyGender(genders);
  assert.equal(result.total, 542);
  assert.equal(result.male, 186);
  assert.equal(result.female, 355);
  assert.equal(result.unknownGender, 1);
  assert.equal(result.male + result.female + result.unknownGender, 542);
});

test("tallyGender on an empty list reconciles trivially (0 = 0 + 0 + 0)", () => {
  const result = tallyGender([]);
  assert.deepEqual(result, { male: 0, female: 0, unknownGender: 0, total: 0 });
});

test("classifyGender takes exactly one argument (the gender field) — callers must never pass a worker's name or any other field into it", () => {
  // isMale's substring match ("nam") would misfire on a full name like "Nguyễn Nam Khánh" —
  // this is exactly why every caller (workers.ts, organization.ts, analytics.ts) selects
  // ONLY worker_profiles.gender for this function, never fullName. Documented here, not
  // guarded in code, because guarding against a caller's own mistake is out of scope for
  // a pure classification function — the guarantee lives in what callers select from the DB.
  assert.equal(classifyGender.length, 1);
});
