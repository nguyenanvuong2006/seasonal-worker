const GOOGLE_DOCS_WRITE_PREFIX = "https://docs.googleapis.com/v1/documents/";
const MIN_WRITE_INTERVAL_MS = 1100;
const MAX_RETRIES = 5;

let installed = false;
let nextWriteAt = 0;
let queue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDocsWrite(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  return method === "POST" && url.startsWith(GOOGLE_DOCS_WRITE_PREFIX) && url.includes(":batchUpdate");
}

async function waitForWriteSlot(): Promise<void> {
  let release!: () => void;
  const previous = queue;
  queue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const waitMs = Math.max(0, nextWriteAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    nextWriteAt = Date.now() + MIN_WRITE_INTERVAL_MS;
  } finally {
    release();
  }
}

function retryDelayMs(attempt: number): number {
  const exponential = Math.min(32_000, 1000 * 2 ** attempt);
  return exponential + Math.floor(Math.random() * 750);
}

export function installGoogleDocsRateLimitGuard(): void {
  if (installed) return;
  installed = true;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isDocsWrite(input, init)) {
      return originalFetch(input, init);
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await waitForWriteSlot();
      const response = await originalFetch(input, init);
      if (response.status !== 429 || attempt === MAX_RETRIES) {
        return response;
      }

      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : retryDelayMs(attempt);
      await sleep(delay);
    }

    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}
