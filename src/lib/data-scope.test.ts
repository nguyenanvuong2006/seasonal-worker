import test from "node:test";
import assert from "node:assert/strict";
import {
  canAggregateTransferIn,
  canAggregateTransferOut,
  movementScopeVisibility,
  scopeAllowsDepartment,
} from "./data-scope.ts";

test("Data Scope null is unrestricted within permission", () => {
  assert.equal(scopeAllowsDepartment(null, "packing"), true);
  assert.equal(movementScopeVisibility(null, "transfer", "packing", "harvest"), "FULL");
});

test("Data Scope [] sees no department", () => {
  assert.equal(scopeAllowsDepartment([], "packing"), false);
  assert.equal(movementScopeVisibility([], "transfer", "packing", "harvest"), "NONE");
});

test("one-department scope only permits that department", () => {
  assert.equal(scopeAllowsDepartment(["packing"], "packing"), true);
  assert.equal(scopeAllowsDepartment(["packing"], "harvest"), false);
});

test("transfer source-only scope gets full outgoing record", () => {
  assert.equal(movementScopeVisibility(["packing"], "transfer", "packing", "harvest"), "FULL");
  assert.equal(canAggregateTransferOut(["packing"], "packing"), true);
  assert.equal(canAggregateTransferIn(["packing"], "harvest"), false);
});

test("transfer destination-only scope gets redacted incoming record", () => {
  assert.equal(movementScopeVisibility(["harvest"], "transfer", "packing", "harvest"), "REDACTED_INCOMING");
  assert.equal(canAggregateTransferOut(["harvest"], "packing"), false);
  assert.equal(canAggregateTransferIn(["harvest"], "harvest"), true);
});

test("resignation is visible only from source scope", () => {
  assert.equal(movementScopeVisibility(["harvest"], "resignation", "packing", null), "NONE");
  assert.equal(movementScopeVisibility(["packing"], "resignation", "packing", null), "FULL");
});

test("cross-scope department request fails closed", () => {
  assert.equal(scopeAllowsDepartment(["packing"], "camp-a"), false);
});

test("AI tool/service layer derives scope from Session and exposes no scope argument", async () => {
  const fs = await import("node:fs/promises");
  const tools = await fs.readFile(new URL("./workforce-intelligence/tools.ts", import.meta.url), "utf8");
  const service = await fs.readFile(new URL("./workforce-intelligence/service.ts", import.meta.url), "utf8");
  assert.match(tools, /session: Session/);
  assert.doesNotMatch(tools, /scope\s*:\s*(string|DepartmentScope|string\[\])/);
  assert.match(service, /getUserScope\(session\)/);
  assert.match(service, /restrictDepartmentIds\(scope, filters\.departmentId\)/);
});

test("destination-only transfer API redacts worker PII and notes", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../app/api/workforce-movements/route.ts", import.meta.url), "utf8"));
  assert.match(source, /workerId: full \? row\.workerId : null/);
  assert.match(source, /workerCccd: full \? row\.workerCccd : null/);
  assert.match(source, /reason: full \? row\.reason : null/);
  assert.match(source, /requestedBy: full \? row\.requestedBy : null/);
});
