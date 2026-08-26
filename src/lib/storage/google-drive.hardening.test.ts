/**
 * Google Drive hardening tests (no-schema phase)
 * - single-flight folder creation
 * - read path never creates folders
 * - error propagation
 */

import test from "node:test";
import assert from "node:assert/strict";

type FetchMock = {
  calls: { url: string; method: string }[];
  folderCreations: number;
  fileQueries: number;
  tokenFetched: number;
  folderMap: Map<string, string>; // key: parentId|name -> id
  fileMap: Map<string, string>; // key: folderId|filename -> fileId
  nextFolderId: number;
  nextFileId: number;
  injectFolderLookupError?: { status: number; message: string } | null;
  injectFileLookupError?: { status: number; message: string } | null;
};

function createFetchMock(): FetchMock {
  return {
    calls: [],
    folderCreations: 0,
    fileQueries: 0,
    tokenFetched: 0,
    folderMap: new Map(),
    fileMap: new Map(),
    nextFolderId: 1,
    nextFileId: 1,
    injectFolderLookupError: null,
    injectFileLookupError: null,
  };
}

function installFetchMock(mock: FetchMock) {
  const originalFetch = global.fetch;
  // @ts-ignore
  global.fetch = async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    mock.calls.push({ url: urlStr, method });

    // Token endpoint
    if (urlStr.includes("oauth2.googleapis.com/token")) {
      mock.tokenFetched++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "fake-token", expires_in: 3600 }),
        text: async () => JSON.stringify({ access_token: "fake-token" }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }

    // Drive API files? q=...
    if (urlStr.includes("/drive/v3/files") && method === "GET" && urlStr.includes("q=")) {
      const qMatch = decodeURIComponent(urlStr);
      // Folder lookup
      if (qMatch.includes("mimeType") && qMatch.includes("folder")) {
        if (mock.injectFolderLookupError) {
          const { status, message } = mock.injectFolderLookupError;
          return {
            ok: false,
            status,
            text: async () => message,
            json: async () => ({ error: message }),
            arrayBuffer: async () => new ArrayBuffer(0),
          } as unknown as Response;
        }
        // Extract name and parent
        const nameMatch = qMatch.match(/name='([^']+)'/);
        const parentMatch = qMatch.match(/'([^']+)' in parents/);
        const name = nameMatch?.[1] ?? "";
        const parentId = parentMatch?.[1] ?? "null";
        const key = `${parentId}|${name}`;
        const id = mock.folderMap.get(key) ?? null;
        return {
          ok: true,
          status: 200,
          json: async () => ({ files: id ? [{ id, name }] : [] }),
          text: async () => JSON.stringify({ files: id ? [{ id }] : [] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }
      // File lookup
      if (qMatch.includes("trashed=false") && !qMatch.includes("mimeType")) {
        mock.fileQueries++;
        if (mock.injectFileLookupError) {
          const { status, message } = mock.injectFileLookupError;
          return {
            ok: false,
            status,
            text: async () => message,
            json: async () => ({ error: message }),
            arrayBuffer: async () => new ArrayBuffer(0),
          } as unknown as Response;
        }
        const nameMatch = qMatch.match(/name='([^']+)'/);
        const parentMatch = qMatch.match(/'([^']+)' in parents/);
        const name = nameMatch?.[1] ?? "";
        const parentId = parentMatch?.[1] ?? "null";
        const key = `${parentId}|${name}`;
        const id = mock.fileMap.get(key) ?? null;
        return {
          ok: true,
          status: 200,
          json: async () => ({ files: id ? [{ id, size: "100", sha256Checksum: "abc" }] : [] }),
          text: async () => JSON.stringify({ files: id ? [{ id }] : [] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }
    }

    // Drive API files POST – create folder
    if (urlStr.includes("/drive/v3/files") && method === "POST" && !urlStr.includes("uploadType")) {
      mock.folderCreations++;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const name = body.name ?? `folder-${mock.nextFolderId}`;
      const parentId = body.parents?.[0] ?? "null";
      const id = `folder-${mock.nextFolderId++}`;
      const key = `${parentId}|${name}`;
      mock.folderMap.set(key, id);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id }),
        text: async () => JSON.stringify({ id }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }

    // Upload API – put file
    if (urlStr.includes("/upload/drive/v3/files") && method === "POST") {
      // For simplicity, return file id
      const id = `file-${mock.nextFileId++}`;
      // We need to extract filename and parent from multipart body – parse roughly
      const bodyStr = (init?.body as Buffer)?.toString?.() ?? "";
      const nameMatch = bodyStr.match(/"name"\s*:\s*"([^"]+)"/);
      const filename = nameMatch?.[1] ?? `file-${id}.pdf`;
      // parent is in body JSON as parents: [folderId]
      const parentMatch = bodyStr.match(/"parents"\s*:\s*\["([^"]+)"\]/);
      const parentId = parentMatch?.[1] ?? "unknown";
      mock.fileMap.set(`${parentId}|${filename}`, id);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id, webViewLink: `https://drive.google.com/${id}`, size: "100" }),
        text: async () => JSON.stringify({ id }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }

    // Download file content
    if (urlStr.includes("/drive/v3/files/") && urlStr.includes("alt=media")) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("pdf-bytes").buffer,
        text: async () => "pdf-bytes",
        json: async () => ({}),
      } as unknown as Response;
    }

    // get metadata for url
    if (urlStr.includes("/drive/v3/files/") && urlStr.includes("fields=webViewLink")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ webViewLink: "https://drive.google.com/view", webContentLink: "https://drive.google.com/content" }),
        text: async () => JSON.stringify({ webViewLink: "https://drive.google.com/view" }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }

    // root metadata
    if (urlStr.includes("/drive/v3/files/") && urlStr.includes("fields=id,name,trashed")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "root-id", name: "Seasonal Worker Documents", trashed: false }),
        text: async () => JSON.stringify({ id: "root-id" }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}",
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  };
  return () => {
    global.fetch = originalFetch;
  };
}

test("10 concurrent ensureFolderPath calls create one folder chain", async () => {
  const mock = createFetchMock();
  const restore = installFetchMock(mock);
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "";

  const { GoogleDriveStorageProvider } = await import("./google-drive.ts");
  const provider = new GoogleDriveStorageProvider();

  const pathParts = ["Candidate Documents", "2026", "08", "26"];
  // @ts-ignore access private
  const promises = Array.from({ length: 10 }, () => (provider as any).ensureFolderPath(pathParts));
  const results = await Promise.all(promises);

  // All results same final folder id
  assert.equal(new Set(results).size, 1, "all concurrent calls should resolve to same folder id");
  // Only 4 folder creations (one per segment), not 40
  assert.equal(mock.folderCreations, 4, `expected 4 folder creations, got ${mock.folderCreations}`);

  restore();
});

test("Concurrent puts for same date path do not create duplicate folders", async () => {
  const mock = createFetchMock();
  const restore = installFetchMock(mock);
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "";

  const { GoogleDriveStorageProvider } = await import("./google-drive.ts");
  const provider = new GoogleDriveStorageProvider();

  const keys = [
    "Candidate Documents/2026/08/26/file1.pdf",
    "Candidate Documents/2026/08/26/file2.pdf",
    "Candidate Documents/2026/08/26/file3.pdf",
  ];

  await Promise.all(keys.map((k) => provider.put(k, Buffer.from("pdf"))));

  // Folder chain should be created once: 4 folders
  assert.equal(mock.folderCreations, 4, `expected 4 folder creations for concurrent puts, got ${mock.folderCreations}`);
  // 3 files uploaded
  assert.equal(mock.fileMap.size, 3, "should have 3 files");
  assert.equal(mock.folderMap.size, 4, "should have 4 folders");

  restore();
});

test("get() on missing folder does NOT create folder", async () => {
  const mock = createFetchMock();
  const restore = installFetchMock(mock);
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "";

  const { GoogleDriveStorageProvider } = await import("./google-drive.ts");
  const provider = new GoogleDriveStorageProvider();

  try {
    await provider.get("Candidate Documents/2026/08/26/missing.pdf");
    assert.fail("should have thrown FILE_NOT_FOUND");
  } catch (e) {
    assert.match((e as Error).message, /GOOGLE_DRIVE_FILE_NOT_FOUND/);
  }

  assert.equal(mock.folderCreations, 0, "get() should not create folders on missing path");

  restore();
});

test("getSignedUrl() on missing folder does NOT create folder", async () => {
  const mock = createFetchMock();
  const restore = installFetchMock(mock);
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "";

  const { GoogleDriveStorageProvider } = await import("./google-drive.ts");
  const provider = new GoogleDriveStorageProvider();

  try {
    await provider.getSignedUrl("Candidate Documents/2026/08/26/missing.pdf");
    assert.fail("should have thrown");
  } catch (e) {
    assert.match((e as Error).message, /GOOGLE_DRIVE_FILE_NOT_FOUND/);
  }

  assert.equal(mock.folderCreations, 0, "getSignedUrl should not create folders");

  restore();
});

test("auth/rate-limit error is not rewritten as FILE_NOT_FOUND", async () => {
  const mock = createFetchMock();
  mock.injectFolderLookupError = { status: 401, message: "Unauthorized" };
  const restore = installFetchMock(mock);
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "";

  const { GoogleDriveStorageProvider } = await import("./google-drive.ts");
  const provider = new GoogleDriveStorageProvider();

  try {
    await provider.get("Candidate Documents/2026/08/26/file.pdf");
    assert.fail("should have thrown auth error");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /GOOGLE_DRIVE_FOLDER_LOOKUP_401/);
    assert.doesNotMatch(msg, /FILE_NOT_FOUND/);
  }

  restore();
});

test("genuine file-not-found returns FILE_NOT_FOUND", async () => {
  const mock = createFetchMock();
  const restore = installFetchMock(mock);
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "";

  const { GoogleDriveStorageProvider } = await import("./google-drive.ts");
  const provider = new GoogleDriveStorageProvider();

  // Create folder chain first via put, but no file
  await provider.put("Candidate Documents/2026/08/26/existing.pdf", Buffer.from("pdf"));
  mock.fileMap.clear(); // remove file, keep folders

  try {
    await provider.get("Candidate Documents/2026/08/26/missing.pdf");
    assert.fail("should throw FILE_NOT_FOUND");
  } catch (e) {
    assert.match((e as Error).message, /GOOGLE_DRIVE_FILE_NOT_FOUND/);
  }

  restore();
});

test("no DB schema changes – storage provider does not require new columns", async () => {
  // This is a meta test – we just assert the file exists and does not reference new columns
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(new URL("./google-drive.ts", import.meta.url), "utf8");
  assert.doesNotMatch(content, /drive_file_id/);
  assert.doesNotMatch(content, /storage_file_id.*drive/);
});
