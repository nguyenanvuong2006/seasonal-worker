import test from "node:test";
import assert from "node:assert/strict";
import { MockKnowledgeProvider, getKnowledgeProvider } from "./knowledge-provider.ts";

test("MockKnowledgeProvider always returns available:false with no results — never fabricates a policy answer", async () => {
  const provider = new MockKnowledgeProvider();
  const result = await provider.search("quy trình chuyển bộ phận", null, 5);
  assert.deepEqual(result, { results: [], available: false });
});

test("MockKnowledgeProvider ignores scope/limit and still returns the same honest empty result — no accidental data leakage across scopes", async () => {
  const provider = new MockKnowledgeProvider();
  const a = await provider.search("q", ["dept-1"], 1);
  const b = await provider.search("q", [], 100);
  assert.deepEqual(a, { results: [], available: false });
  assert.deepEqual(b, { results: [], available: false });
});

test("getKnowledgeProvider() returns a provider satisfying the KnowledgeProvider interface (has name + search)", async () => {
  const provider = getKnowledgeProvider();
  assert.equal(typeof provider.name, "string");
  assert.equal(typeof provider.search, "function");
  const result = await provider.search("x", null, 5);
  assert.equal(typeof result.available, "boolean");
  assert.ok(Array.isArray(result.results));
});
