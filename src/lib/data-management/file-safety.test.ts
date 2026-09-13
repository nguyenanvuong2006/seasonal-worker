import test from "node:test";
import assert from "node:assert/strict";
import { validateUploadFile, MAX_UPLOAD_BYTES } from "./file-safety.ts";

test("accepts a normal-sized .xlsx file", () => {
  assert.deepEqual(validateUploadFile({ name: "master.xlsx", size: 1024 }), { ok: true });
});

test("rejects a file over the size limit", () => {
  const result = validateUploadFile({ name: "master.xlsx", size: MAX_UPLOAD_BYTES + 1 });
  assert.equal(result.ok, false);
});

test("rejects an unsupported extension (e.g. .exe)", () => {
  const result = validateUploadFile({ name: "malware.exe", size: 100 });
  assert.equal(result.ok, false);
});

test("accepts .csv and .xls", () => {
  assert.equal(validateUploadFile({ name: "a.csv", size: 100 }).ok, true);
  assert.equal(validateUploadFile({ name: "a.xls", size: 100 }).ok, true);
});
