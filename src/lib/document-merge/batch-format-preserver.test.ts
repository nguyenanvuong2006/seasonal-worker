/**
 * Batch format preserver — regression tests.
 *
 * Guards against BATCH_GOOGLE_API_400 "Unallowed field: tabStops".
 * The Google Docs API returns `tabStops`, `headingId` and
 * `linkedContentReference` on read, but rejects them inside
 * `updateParagraphStyle` requests. The batch engine must strip these
 * read-only fields (and `pageBreakBefore` for paragraphs inside table
 * cells) from both the `paragraphStyle` payload and the `fields` mask.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { installFormatPreservingBatchPatch } from "./batch-format-preserver.ts";
import { PAGE_BREAK_TEXT, RealGoogleDocsService } from "./google-docs-service.ts";

const TEMPLATE_DOC_ID = "template-doc-1";
const OUTPUT_DOC_ID = "output-doc-1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const templatePlainText = "Họ tên: <<Ho_ten>>\nĐịa chỉ: <<Dia_chi>>";

const templateDocJson = {
  body: {
    content: [
      {
        startIndex: 1,
        endIndex: 40,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 18,
              textRun: { content: "Họ tên: <<Ho_ten>>\n", textStyle: {} },
            },
            {
              startIndex: 18,
              endIndex: 39,
              textRun: { content: "Địa chỉ: <<Dia_chi>>\n", textStyle: {} },
            },
          ],
          paragraphStyle: {
            namedStyleType: "NORMAL_TEXT",
            alignment: "CENTER",
            // Read-only fields returned by the API but rejected on update.
            tabStops: [{ offset: { magnitude: 72, unit: "PT" }, alignment: "LEFT" }],
            headingId: "h.abc123",
            linkedContentReference: {
              sheetsChartReference: { spreadsheetId: "spreadsheet-1", chartId: 7 },
            },
          },
        },
      },
    ],
  },
};

/** Captured bodies of every POST .../documents/:id:batchUpdate call. */
let capturedBatchUpdates: Array<Record<string, unknown>[]> = [];
let originalFetch: typeof fetch;

function installFetchMock(): void {
  capturedBatchUpdates = [];
  const realFetch = fetch.bind(globalThis);
  originalFetch = fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return jsonResponse({ access_token: "fake-access-token", expires_in: 3600 });
    }

    if (url.includes("/export?")) {
      return new Response(templatePlainText, { status: 200 });
    }

    if (url.includes(`/documents/${TEMPLATE_DOC_ID}`)) {
      return jsonResponse(templateDocJson);
    }

    if (url.includes(`/documents/${OUTPUT_DOC_ID}:batchUpdate`)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { requests?: Record<string, unknown>[] };
      capturedBatchUpdates.push(body.requests ?? []);
      return jsonResponse({ replies: [] });
    }

    if (url.includes(`/documents/${OUTPUT_DOC_ID}`)) {
      // Destination doc: empty body; the batch engine inserts content at
      // index 1 regardless of how many times it re-reads the document.
      return jsonResponse({ body: { content: [] } });
    }

    throw new Error(`Unexpected fetch in test mock: ${url}`);
  }) as typeof fetch;
}

function updateParagraphStyleRequests(): Array<Record<string, any>> {
  return capturedBatchUpdates
    .flat()
    .filter((request) => Boolean(request.updateParagraphStyle))
    .map((request) => request.updateParagraphStyle as Record<string, any>);
}

describe("Batch format preserver — read-only paragraph style fields", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_REFRESH_TOKEN = "test-refresh-token";
    installFetchMock();
    installFormatPreservingBatchPatch();
  });

  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REFRESH_TOKEN;
    globalThis.fetch = originalFetch;
  });

  it("strips tabStops/headingId/linkedContentReference from updateParagraphStyle", async () => {
    const service = new RealGoogleDocsService("test-token");
    service.copyDocument = async () => OUTPUT_DOC_ID;
    service.replacePlaceholders = async () => {};

    // Capture the template snapshot through the patched getDocumentContent.
    const snapshot = await service.getDocumentContent(TEMPLATE_DOC_ID);
    assert.match(snapshot, /<<Ho_ten>>/);

    const content = [
      "Họ tên: Nguyễn Văn A\nĐịa chỉ: Hà Nội",
      "Họ tên: Trần Thị B\nĐịa chỉ: TP. HCM",
    ].join(PAGE_BREAK_TEXT);

    const outputId = await service.createDocument("Batch hồ sơ", content);
    assert.strictEqual(outputId, OUTPUT_DOC_ID);

    const paragraphStyleRequests = updateParagraphStyleRequests();
    assert.ok(
      paragraphStyleRequests.length >= 1,
      "Expected at least one updateParagraphStyle request for the appended paragraphs",
    );

    for (const request of paragraphStyleRequests) {
      const fields = String(request.fields ?? "").split(",");
      const style = request.paragraphStyle ?? {};
      assert.ok(!("tabStops" in style), "tabStops must be stripped from paragraphStyle");
      assert.ok(!("headingId" in style), "headingId must be stripped from paragraphStyle");
      assert.ok(
        !("linkedContentReference" in style),
        "linkedContentReference must be stripped from paragraphStyle",
      );
      assert.ok(!fields.includes("tabStops"), "tabStops must not appear in the fields mask");
      assert.ok(!fields.includes("headingId"), "headingId must not appear in the fields mask");
      assert.ok(
        !fields.includes("linkedContentReference"),
        "linkedContentReference must not appear in the fields mask",
      );
    }
  });

  it("also strips pageBreakBefore for paragraphs inside table cells", async () => {
    // Same template body, but rendered through the table-cell path. The
    // fixture below is the destination doc returned after insertTable.
    capturedBatchUpdates = [];
    let tableInserted = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "fake-access-token", expires_in: 3600 });
      }
      if (url.includes("/export?")) {
        return new Response("Ô <<Ma_so>>", { status: 200 });
      }
      if (url.includes(`/documents/${TEMPLATE_DOC_ID}`)) {
        return jsonResponse({
          body: {
            content: [
              {
                startIndex: 1,
                endIndex: 10,
                table: {
                  rows: 1,
                  columns: 1,
                  tableRows: [
                    {
                      startIndex: 2,
                      endIndex: 9,
                      tableCells: [
                        {
                          startIndex: 3,
                          endIndex: 8,
                          content: [
                            {
                              startIndex: 4,
                              endIndex: 8,
                              paragraph: {
                                elements: [
                                  {
                                    startIndex: 4,
                                    endIndex: 7,
                                    textRun: { content: "Ô <<Ma_so>>\n", textStyle: {} },
                                  },
                                ],
                                paragraphStyle: {
                                  alignment: "CENTER",
                                  pageBreakBefore: true,
                                  tabStops: [{ offset: { magnitude: 72, unit: "PT" }, alignment: "RIGHT" }],
                                  headingId: "h.table",
                                },
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                  tableStyle: {},
                },
              },
            ],
          },
        });
      }
      if (url.includes(`/documents/${OUTPUT_DOC_ID}:batchUpdate`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { requests?: Record<string, unknown>[] };
        const requests = body.requests ?? [];
        capturedBatchUpdates.push(requests);
        if (requests.some((request) => Boolean(request.insertTable))) tableInserted = true;
        return jsonResponse({ replies: [] });
      }
      if (url.includes(`/documents/${OUTPUT_DOC_ID}`)) {
        if (!tableInserted) return jsonResponse({ body: { content: [] } });
        return jsonResponse({
          body: {
            content: [
              {
                startIndex: 1,
                endIndex: 2,
                paragraph: { elements: [{ textRun: { content: "\n", textStyle: {} } }] },
              },
              {
                startIndex: 2,
                endIndex: 8,
                table: {
                  tableRows: [
                    {
                      tableCells: [
                        {
                          startIndex: 3,
                          endIndex: 7,
                          content: [
                            {
                              startIndex: 4,
                              endIndex: 6,
                              paragraph: {
                                elements: [{ textRun: { content: "\n", textStyle: {} } }],
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected fetch in test mock: ${url}`);
    }) as typeof fetch;

    const service = new RealGoogleDocsService("test-token");
    service.copyDocument = async () => OUTPUT_DOC_ID;
    service.replacePlaceholders = async () => {};

    await service.getDocumentContent(TEMPLATE_DOC_ID);

    const content = ["Ô M-001", "Ô M-002"].join(PAGE_BREAK_TEXT);
    const outputId = await service.createDocument("Batch bảng", content);
    assert.strictEqual(outputId, OUTPUT_DOC_ID);

    const paragraphStyleRequests = updateParagraphStyleRequests();
    assert.ok(
      paragraphStyleRequests.length >= 1,
      "Expected at least one updateParagraphStyle request for the table cell paragraph",
    );

    for (const request of paragraphStyleRequests) {
      const style = request.paragraphStyle ?? {};
      const fields = String(request.fields ?? "").split(",");
      assert.ok(!("tabStops" in style), "tabStops must be stripped inside table cells");
      assert.ok(
        !("pageBreakBefore" in style),
        "pageBreakBefore must be stripped for paragraphs inside table cells",
      );
      assert.ok(!fields.includes("tabStops"), "tabStops must not appear in the fields mask");
      assert.ok(
        !fields.includes("pageBreakBefore"),
        "pageBreakBefore must not appear in the fields mask",
      );
    }
  });
});
