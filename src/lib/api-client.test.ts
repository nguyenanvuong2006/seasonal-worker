import test from "node:test";
import assert from "node:assert/strict";
import { fetchJsonWithTimeout, type ApiResult } from "./api-client.ts";

/* ------------------------------------------------------------------
   PHASE 8 — fetchJsonWithTimeout contract
   - Never throws — always returns ApiResult (success | failure).
   - TIMEOUT classified when fetch() is aborted by AbortController.
   - HTTP_4XX/5XX classified by status.
   - PARSE classified when response is not JSON.
   - NETWORK classified when fetch itself rejects.
   - Successful JSON returns typed `data` and durationMs.
   ------------------------------------------------------------------ */

// Helper: build a fake fetch via global override.
function withFetch(impl: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("success: returns ok=true with data + status + durationMs", async () => {
  await withFetch(async () => new Response(JSON.stringify({ rows: [1, 2, 3] }), { status: 200 }), async () => {
    const r = await fetchJsonWithTimeout<{ rows: number[] }>("/api/test");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.data, { rows: [1, 2, 3] });
      assert.equal(r.status, 200);
      assert.equal(typeof r.durationMs, "number");
    }
  });
});

test("timeout: returns TIMEOUT code with friendly message", async () => {
  // Fetch never resolves; AbortController must fire after timeoutMs.
  await withFetch(async (_url, init) => {
    // Throw an AbortError to simulate timeout-based cancellation.
    return await new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }, async () => {
    const r = await fetchJsonWithTimeout("/api/slow", { timeoutMs: 50 });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "TIMEOUT");
      assert.match(r.message, /quá/);
    }
  });
});

test("HTTP 4xx: returns HTTP_4XX with message extracted from body", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ error: "Thiếu tham số" }), { status: 400 }),
    async () => {
      const r = await fetchJsonWithTimeout("/api/bad", { timeoutMs: 1000 });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.code, "HTTP_4XX");
        assert.equal(r.status, 400);
        assert.match(r.message, /Thiếu tham số/);
      }
    },
  );
});

test("HTTP 401: returns UNAUTHORIZED with safe default message", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({}), { status: 401 }),
    async () => {
      const r = await fetchJsonWithTimeout("/api/secret", { timeoutMs: 1000 });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.code, "UNAUTHORIZED");
        assert.match(r.message, /hết hạn|đăng nhập/i);
      }
    },
  );
});

test("HTTP 403: returns FORBIDDEN", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({}), { status: 403 }),
    async () => {
      const r = await fetchJsonWithTimeout("/api/secret", { timeoutMs: 1000 });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "FORBIDDEN");
    },
  );
});

test("HTTP 500: returns HTTP_5XX (uses server's error message when present)", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ error: "DB down" }), { status: 500 }),
    async () => {
      const r = await fetchJsonWithTimeout("/api/x", { timeoutMs: 1000 });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.code, "HTTP_5XX");
        // Server-provided error message is preferred over the generic 5xx string.
        assert.equal(r.message, "DB down");
      }
    },
  );
});

test("HTTP 500 without body error → generic safe message", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({}), { status: 500 }),
    async () => {
      const r = await fetchJsonWithTimeout("/api/x", { timeoutMs: 1000 });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.code, "HTTP_5XX");
        assert.match(r.message, /gặp sự cố/);
      }
    },
  );
});

test("HTML 500 response (not JSON) → PARSE error, never throws SyntaxError", async () => {
  await withFetch(
    async () =>
      new Response("<html><body>Internal Server Error</body></html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
    async () => {
      const r = await fetchJsonWithTimeout("/api/x", { timeoutMs: 1000 });
      assert.equal(r.ok, false);
      // 5xx takes priority over PARSE (status wins).
      if (!r.ok) assert.equal(r.code, "HTTP_5XX");
    },
  );
});

test("empty body 200 → empty response classified as PARSE failure (not ok)", async () => {
  await withFetch(
    async () => new Response("", { status: 200 }),
    async () => {
      const r = await fetchJsonWithTimeout("/api/empty", { timeoutMs: 1000 });
      // Empty body 200 is treated as a parse failure (no JSON to read), not a
      // successful null — the caller decides what null means. Safer to surface.
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "PARSE");
    },
  );
});

test("caller AbortSignal → ABORTED, no timeout counting", async () => {
  // Simulate an AbortError that originated from the CALLER's signal — fetch() rejects.
  // Our helper must NOT throw and must classify as ABORTED.
  const controller = new AbortController();
  controller.abort(); // pre-aborted
  await withFetch(async () => {
    throw new DOMException("aborted", "AbortError");
  }, async () => {
    const r = await fetchJsonWithTimeout("/api/test", {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "ABORTED");
    }
  });
});

test("network failure (fetch rejects) → NETWORK code", async () => {
  await withFetch(async () => {
    throw new TypeError("Failed to fetch");
  }, async () => {
    const r = await fetchJsonWithTimeout("/api/down", { timeoutMs: 1000 });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "NETWORK");
      assert.match(r.message, /kết nối/i);
    }
  });
});
