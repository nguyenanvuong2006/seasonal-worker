/**
 * worker-trigger.ts — phải dùng CHUNG callWorker() (không tự lặp lại auth),
 * và phải LOG (không nuốt lặng lẽ) khi trigger thất bại, không bao giờ log
 * secret/token value.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

type TriggerModule = {
  triggerPdfWorker: (jobId: string, request?: Request) => void;
};

async function load(callWorkerImpl: (...args: unknown[]) => Promise<unknown>): Promise<{
  mod: TriggerModule;
  afterCalls: (() => Promise<void>)[];
  callWorkerCalls: unknown[][];
}> {
  const afterCalls: (() => Promise<void>)[] = [];
  const callWorkerCalls: unknown[][] = [];

  const mod = await loadModule(new URL("./worker-trigger.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "next/server": {
        after: (fn: () => Promise<void>) => {
          afterCalls.push(fn);
        },
      },
      "@/lib/verification/helpers": {
        callWorker: (...args: unknown[]) => {
          callWorkerCalls.push(args);
          return callWorkerImpl(...args);
        },
      },
    },
  });
  return { mod: mod as unknown as TriggerModule, afterCalls, callWorkerCalls };
}

test("triggerPdfWorker: gọi callWorker('/run', { jobId }, ..., { request }) — dùng CHUNG helper xác thực, không tự lặp lại auth", async () => {
  const { mod, afterCalls, callWorkerCalls } = await load(async () => ({ ok: true, status: 200, data: { processed: 1 } }));
  const req = new Request("https://app.example", { headers: { "x-vercel-oidc-token": "oidc-jwt" } });

  mod.triggerPdfWorker("job-1", req);
  assert.equal(afterCalls.length, 1, "phải dùng after() để không giữ response mở");
  await afterCalls[0]();

  assert.equal(callWorkerCalls.length, 1);
  const [path, body, , options] = callWorkerCalls[0] as [string, { jobId: string }, number, { request?: Request }];
  assert.equal(path, "/run");
  // body được tạo trong vm sandbox (loadModule) — JSON round-trip để so sánh
  // thuần dữ liệu, tránh deepStrictEqual strict-mode fail vì khác realm.
  assert.deepEqual(JSON.parse(JSON.stringify(body)), { jobId: "job-1" });
  assert.equal(options.request, req);
});

test("triggerPdfWorker: trigger thất bại (401) PHẢI được log với stage/status — không nuốt lặng lẽ", async () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => logs.push(msg);
  try {
    const { mod, afterCalls } = await load(async () => ({
      ok: false,
      status: 401,
      stage: "WORKER_AUTH",
      data: { error: "unauthorized" },
      diagnostics: { workerHost: "worker.example", workerSecretConfigured: false },
    }));
    mod.triggerPdfWorker("job-2");
    await afterCalls[0]();

    assert.equal(logs.length, 1, "phải log khi trigger thất bại (trước đây bị nuốt lặng lẽ)");
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.event, "pdf_worker_trigger_failed");
    assert.equal(parsed.jobId, "job-2");
    assert.equal(parsed.stage, "WORKER_AUTH");
    assert.equal(parsed.status, 401);
    // Không log secret/token value nào — chỉ boolean/stage/status.
    assert.equal(JSON.stringify(parsed).includes("Bearer"), false);
  } finally {
    console.error = originalError;
  }
});

test("triggerPdfWorker: trigger thành công KHÔNG log gì (silent success, giữ hành vi fire-and-forget)", async () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => logs.push(msg);
  try {
    const { mod, afterCalls } = await load(async () => ({ ok: true, status: 200, data: { processed: 1 } }));
    mod.triggerPdfWorker("job-3");
    await afterCalls[0]();
    assert.equal(logs.length, 0);
  } finally {
    console.error = originalError;
  }
});
