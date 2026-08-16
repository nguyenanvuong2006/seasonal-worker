import crypto from "node:crypto";
import {
  PAGE_BREAK_TEXT,
  RealGoogleDocsService,
  type PlaceholderReplacement,
} from "./google-docs-service";

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type Snapshot = {
  docId: string;
  content: string;
  capturedAt: number;
};

type DocsStructuralElement = Record<string, any>;
type DocsDocument = Record<string, any>;

const snapshots = new Map<string, Snapshot>();
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const MAX_SNAPSHOTS = 40;
let cachedToken: { value: string; expiresAt: number } | null = null;
let installed = false;

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

async function exchangeServiceAccountToken(
  email: string,
  privateKey: string,
  impersonateUser?: string,
): Promise<TokenResponse> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payloadData: Record<string, string | number> = {
    iss: email,
    scope: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  if (impersonateUser) payloadData.sub = impersonateUser;
  const payload = base64Url(JSON.stringify(payloadData));
  const signingInput = `${header}.${payload}`;
  const normalizedKey = privateKey.replace(/\\n/g, "\n");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), normalizedKey);
  const assertion = `${signingInput}.${base64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth2.0:token",
      assertion,
    }),
  });
  return response.json() as Promise<TokenResponse>;
}

async function exchangeRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  return response.json() as Promise<TokenResponse>;
}

async function resolveAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  let result: TokenResponse | null = null;
  const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const servicePrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (serviceEmail && servicePrivateKey) {
    result = await exchangeServiceAccountToken(
      serviceEmail,
      servicePrivateKey,
      process.env.GOOGLE_IMPERSONATE_USER_EMAIL?.trim() || undefined,
    );
  } else {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (clientId && clientSecret && refreshToken) {
      result = await exchangeRefreshToken(clientId, clientSecret, refreshToken);
    }
  }

  if (!result?.access_token) {
    throw new Error(
      `BATCH_GOOGLE_AUTH_FAILED: ${result?.error_description || result?.error || "missing Google OAuth credentials"}`,
    );
  }

  cachedToken = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(300, result.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = await resolveAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`BATCH_GOOGLE_API_${response.status}: ${detail.slice(0, 1000)}`);
  }
  return response.json() as Promise<T>;
}

async function docsGet(docId: string): Promise<DocsDocument> {
  return requestJson<DocsDocument>(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}?includeTabsContent=true`,
  );
}

async function docsBatchUpdate(docId: string, requests: Record<string, unknown>[]): Promise<any> {
  if (requests.length === 0) return null;
  return requestJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`,
    { method: "POST", body: JSON.stringify({ requests }) },
  );
}

function rememberSnapshot(docId: string, content: string): void {
  const now = Date.now();
  for (const [key, snapshot] of snapshots) {
    if (now - snapshot.capturedAt > SNAPSHOT_TTL_MS) snapshots.delete(key);
  }
  if (snapshots.size >= MAX_SNAPSHOTS) {
    const oldest = [...snapshots.entries()].sort((a, b) => a[1].capturedAt - b[1].capturedAt)[0];
    if (oldest) snapshots.delete(oldest[0]);
  }
  snapshots.set(docId, { docId, content, capturedAt: now });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferReplacements(templateContent: string, renderedContent: string): PlaceholderReplacement[] | null {
  const matcher = /<<\s*([^<>]+?)\s*>>/g;
  const placeholders: string[] = [];
  const literalParts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(templateContent)) !== null) {
    literalParts.push(templateContent.slice(cursor, match.index));
    placeholders.push(match[1].trim());
    cursor = match.index + match[0].length;
  }
  literalParts.push(templateContent.slice(cursor));

  if (placeholders.length === 0) return templateContent === renderedContent ? [] : null;

  let pattern = "^";
  for (let i = 0; i < placeholders.length; i++) {
    pattern += escapeRegex(literalParts[i]);
    pattern += "([\\s\\S]*?)";
  }
  pattern += escapeRegex(literalParts[literalParts.length - 1]);
  pattern += "$";

  const result = new RegExp(pattern).exec(renderedContent);
  if (!result) return null;

  const values = new Map<string, string>();
  for (let i = 0; i < placeholders.length; i++) {
    const placeholder = placeholders[i];
    const value = result[i + 1] ?? "";
    const previous = values.get(placeholder);
    if (previous !== undefined && previous !== value) return null;
    values.set(placeholder, value);
  }

  return [...values.entries()].map(([placeholder, value]) => ({ placeholder, value }));
}

function findSource(renderedContent: string): { snapshot: Snapshot; replacements: PlaceholderReplacement[] } | null {
  const candidates = [...snapshots.values()]
    .filter((snapshot) => Date.now() - snapshot.capturedAt <= SNAPSHOT_TTL_MS)
    .sort((a, b) => b.capturedAt - a.capturedAt);
  for (const snapshot of candidates) {
    const replacements = inferReplacements(snapshot.content, renderedContent);
    if (replacements) return { snapshot, replacements };
  }
  return null;
}

function replacementMap(replacements: PlaceholderReplacement[]): Map<string, string> {
  return new Map(
    replacements.map((item) => [item.placeholder.replace(/^<<|>>$/g, "").trim(), item.value ?? ""]),
  );
}

function replaceTokens(text: string, replacements: Map<string, string>): string {
  return text.replace(/<<\s*([^<>]+?)\s*>>/g, (full, key: string) => {
    const value = replacements.get(String(key).trim());
    return value === undefined ? full : value;
  });
}

function getFirstDocumentTab(document: DocsDocument): { tabId?: string; body: any } {
  const tabs = document.tabs as any[] | undefined;
  if (tabs?.length) {
    const tab = tabs[0];
    return {
      tabId: tab.tabProperties?.tabId,
      body: tab.documentTab?.body,
    };
  }
  return { body: document.body };
}

function location(index: number, tabId?: string): Record<string, unknown> {
  return tabId ? { index, tabId } : { index };
}

function range(startIndex: number, endIndex: number, tabId?: string): Record<string, unknown> {
  return tabId ? { startIndex, endIndex, tabId } : { startIndex, endIndex };
}

function endIndexOf(document: DocsDocument): { endIndex: number; tabId?: string } {
  const { tabId, body } = getFirstDocumentTab(document);
  const content = (body?.content ?? []) as DocsStructuralElement[];
  const endIndex = content.reduce((max, item) => Math.max(max, Number(item.endIndex ?? 1)), 1);
  return { endIndex, tabId };
}

function collectParagraphTextRuns(paragraph: any): any[] {
  return (paragraph?.elements ?? []).filter((element: any) => Boolean(element.textRun));
}

function assertParagraphSupported(paragraph: any, replacements: Map<string, string>): void {
  if (paragraph?.bullet) {
    throw new Error(
      "FORMAT_UNSUPPORTED_BULLET: Template có bullet/list. Batch engine từ chối thay đổi vì chưa thể bảo toàn chính xác kiểu bullet.",
    );
  }
  for (const element of paragraph?.elements ?? []) {
    if (element.horizontalRule || element.equation || element.footnoteReference || element.autoText) {
      throw new Error(
        "FORMAT_UNSUPPORTED_ELEMENT: Template có phần tử đặc biệt (horizontal rule/equation/footnote/auto text) chưa hỗ trợ sao chép an toàn.",
      );
    }
  }

  const allRuns = collectParagraphTextRuns(paragraph).map((element) => element.textRun?.content ?? "");
  for (const key of replacements.keys()) {
    const tokenRegex = new RegExp(`<<\\s*${escapeRegex(key)}\\s*>>`);
    const joined = allRuns.join("");
    if (tokenRegex.test(joined) && !allRuns.some((run) => tokenRegex.test(run))) {
      throw new Error(
        `FORMAT_SPLIT_PLACEHOLDER: Placeholder <<${key}>> đang bị chia thành nhiều text run trong Google Docs. Hãy gõ lại placeholder liền mạch trong template rồi Scan lại.`,
      );
    }
  }
}

function writableTextStyle(style: any): any {
  if (!style) return {};
  const copy = { ...style };
  delete copy.link?.bookmarkId;
  return copy;
}

function writableParagraphStyle(style: any): any {
  if (!style) return {};
  const copy = { ...style };
  delete copy.headingId;
  return copy;
}

function textStyleFields(style: any): string {
  return Object.keys(writableTextStyle(style)).join(",");
}

function paragraphStyleFields(style: any): string {
  return Object.keys(writableParagraphStyle(style)).join(",");
}

async function appendParagraph(
  destinationDocId: string,
  sourceDocument: DocsDocument,
  paragraph: any,
  replacements: Map<string, string>,
): Promise<void> {
  assertParagraphSupported(paragraph, replacements);
  const destination = await docsGet(destinationDocId);
  const { endIndex, tabId } = endIndexOf(destination);
  const insertAt = Math.max(1, endIndex - 1);

  type Segment = { kind: "text" | "image" | "pageBreak"; value?: string; style?: any; sourceObjectId?: string };
  const segments: Segment[] = [];
  for (const element of paragraph?.elements ?? []) {
    if (element.textRun) {
      const original = String(element.textRun.content ?? "");
      segments.push({ kind: "text", value: replaceTokens(original, replacements), style: element.textRun.textStyle });
    } else if (element.inlineObjectElement) {
      segments.push({ kind: "image", sourceObjectId: element.inlineObjectElement.inlineObjectId });
    } else if (element.pageBreak) {
      segments.push({ kind: "pageBreak" });
    }
  }

  let cursor = insertAt;
  const requests: Record<string, unknown>[] = [];
  const textStyleRequests: Record<string, unknown>[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") {
      const text = segment.value ?? "";
      if (!text) continue;
      requests.push({ insertText: { location: location(cursor, tabId), text } });
      const start = cursor;
      cursor += text.length;
      const fields = textStyleFields(segment.style);
      if (fields) {
        textStyleRequests.push({
          updateTextStyle: {
            range: range(start, cursor, tabId),
            textStyle: writableTextStyle(segment.style),
            fields,
          },
        });
      }
    } else if (segment.kind === "pageBreak") {
      requests.push({ insertPageBreak: { location: location(cursor, tabId) } });
      cursor += 1;
    } else if (segment.kind === "image") {
      const inlineObject = sourceDocument.inlineObjects?.[segment.sourceObjectId ?? ""];
      const embedded = inlineObject?.inlineObjectProperties?.embeddedObject;
      const uri = embedded?.imageProperties?.contentUri;
      if (!uri) {
        throw new Error("FORMAT_IMAGE_URI_MISSING: Không lấy được contentUri của hình ảnh trong template.");
      }
      requests.push({
        insertInlineImage: {
          location: location(cursor, tabId),
          uri,
          ...(embedded?.size ? { objectSize: embedded.size } : {}),
        },
      });
      cursor += 1;
    }
  }

  if (requests.length) await docsBatchUpdate(destinationDocId, requests);
  if (textStyleRequests.length) await docsBatchUpdate(destinationDocId, textStyleRequests);

  const paragraphFields = paragraphStyleFields(paragraph?.paragraphStyle);
  if (paragraphFields && cursor > insertAt) {
    await docsBatchUpdate(destinationDocId, [
      {
        updateParagraphStyle: {
          range: range(insertAt, cursor, tabId),
          paragraphStyle: writableParagraphStyle(paragraph.paragraphStyle),
          fields: paragraphFields,
        },
      },
    ]);
  }
}

function tableHasNestedTable(table: any): boolean {
  for (const row of table?.tableRows ?? []) {
    for (const cell of row.tableCells ?? []) {
      for (const content of cell.content ?? []) {
        if (content.table) return true;
      }
    }
  }
  return false;
}

async function populateTableCellParagraphs(
  destinationDocId: string,
  sourceDocument: DocsDocument,
  sourceCell: any,
  destinationCell: any,
  replacements: Map<string, string>,
  tabId?: string,
): Promise<void> {
  const sourceParagraphs = (sourceCell.content ?? []).filter((item: any) => item.paragraph).map((item: any) => item.paragraph);
  if ((sourceCell.content ?? []).some((item: any) => item.table)) {
    throw new Error("FORMAT_NESTED_TABLE_UNSUPPORTED: Template có bảng lồng bảng; batch engine từ chối để không làm sai format.");
  }

  let cellInsertIndex = Number(destinationCell?.content?.[0]?.startIndex ?? destinationCell?.startIndex ?? 1);
  // Google inserts an empty paragraph in each new cell. Insert before its terminal newline.
  cellInsertIndex = Math.max(1, cellInsertIndex);

  for (let pIndex = sourceParagraphs.length - 1; pIndex >= 0; pIndex--) {
    const paragraph = sourceParagraphs[pIndex];
    assertParagraphSupported(paragraph, replacements);
    const textRuns = collectParagraphTextRuns(paragraph);
    if ((paragraph.elements ?? []).some((el: any) => el.inlineObjectElement)) {
      throw new Error(
        "FORMAT_TABLE_IMAGE_UNSUPPORTED: Template có hình ảnh nằm trong ô bảng; batch engine từ chối để không làm sai vị trí hình.",
      );
    }
    const renderedText = textRuns.map((el: any) => replaceTokens(String(el.textRun?.content ?? ""), replacements)).join("");
    if (!renderedText) continue;

    const text = renderedText.endsWith("\n") ? renderedText.slice(0, -1) : renderedText;
    if (!text) continue;
    await docsBatchUpdate(destinationDocId, [
      { insertText: { location: location(cellInsertIndex, tabId), text } },
    ]);

    let offset = cellInsertIndex;
    const styleRequests: Record<string, unknown>[] = [];
    for (const run of textRuns) {
      const runTextRaw = replaceTokens(String(run.textRun?.content ?? ""), replacements);
      const runText = runTextRaw.endsWith("\n") ? runTextRaw.slice(0, -1) : runTextRaw;
      if (!runText) continue;
      const start = offset;
      offset += runText.length;
      const fields = textStyleFields(run.textRun?.textStyle);
      if (fields) {
        styleRequests.push({
          updateTextStyle: {
            range: range(start, offset, tabId),
            textStyle: writableTextStyle(run.textRun?.textStyle),
            fields,
          },
        });
      }
    }
    if (styleRequests.length) await docsBatchUpdate(destinationDocId, styleRequests);

    const pFields = paragraphStyleFields(paragraph.paragraphStyle);
    if (pFields) {
      await docsBatchUpdate(destinationDocId, [
        {
          updateParagraphStyle: {
            range: range(cellInsertIndex, cellInsertIndex + text.length, tabId),
            paragraphStyle: writableParagraphStyle(paragraph.paragraphStyle),
            fields: pFields,
          },
        },
      ]);
    }
  }
}

async function appendTable(
  destinationDocId: string,
  sourceDocument: DocsDocument,
  sourceTable: any,
  replacements: Map<string, string>,
): Promise<void> {
  if (tableHasNestedTable(sourceTable)) {
    throw new Error("FORMAT_NESTED_TABLE_UNSUPPORTED: Template có bảng lồng bảng; batch engine từ chối để bảo toàn format.");
  }

  const rows = Number(sourceTable.rows ?? sourceTable.tableRows?.length ?? 0);
  const columns = Number(sourceTable.columns ?? sourceTable.tableRows?.[0]?.tableCells?.length ?? 0);
  if (!rows || !columns) return;

  let destination = await docsGet(destinationDocId);
  let end = endIndexOf(destination);
  const tableStartIndex = Math.max(1, end.endIndex - 1);
  await docsBatchUpdate(destinationDocId, [
    {
      insertTable: {
        rows,
        columns,
        location: location(tableStartIndex, end.tabId),
      },
    },
  ]);

  destination = await docsGet(destinationDocId);
  end = endIndexOf(destination);
  const destinationBody = getFirstDocumentTab(destination).body;
  const tables = (destinationBody?.content ?? []).filter((item: any) => item.table);
  const inserted = tables[tables.length - 1]?.table;
  if (!inserted) throw new Error("FORMAT_TABLE_INSERT_FAILED: Không tìm thấy bảng vừa chèn trong Google Docs output.");

  // Merge cells first so the target topology matches the template.
  const mergeRequests: Record<string, unknown>[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const sourceCell = sourceTable.tableRows?.[r]?.tableCells?.[c];
      const rowSpan = Number(sourceCell?.tableCellStyle?.rowSpan ?? 1);
      const columnSpan = Number(sourceCell?.tableCellStyle?.columnSpan ?? 1);
      if (rowSpan > 1 || columnSpan > 1) {
        mergeRequests.push({
          mergeTableCells: {
            tableRange: {
              tableCellLocation: {
                tableStartLocation: location(tableStartIndex, end.tabId),
                rowIndex: r,
                columnIndex: c,
              },
              rowSpan,
              columnSpan,
            },
          },
        });
      }
    }
  }
  if (mergeRequests.length) {
    await docsBatchUpdate(destinationDocId, mergeRequests);
    destination = await docsGet(destinationDocId);
  }

  const bodyAfterMerge = getFirstDocumentTab(destination).body;
  const destinationTables = (bodyAfterMerge?.content ?? []).filter((item: any) => item.table);
  const targetTable = destinationTables[destinationTables.length - 1]?.table;
  const targetTabId = getFirstDocumentTab(destination).tabId;

  // Populate from bottom-right to top-left so earlier indexes stay stable.
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = columns - 1; c >= 0; c--) {
      const sourceCell = sourceTable.tableRows?.[r]?.tableCells?.[c];
      const targetCell = targetTable?.tableRows?.[r]?.tableCells?.[c];
      if (!sourceCell || !targetCell) continue;
      await populateTableCellParagraphs(
        destinationDocId,
        sourceDocument,
        sourceCell,
        targetCell,
        replacements,
        targetTabId,
      );
    }
  }

  // Apply cell styles after text insertion.
  const cellStyleRequests: Record<string, unknown>[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const style = sourceTable.tableRows?.[r]?.tableCells?.[c]?.tableCellStyle;
      if (!style) continue;
      const writable = { ...style };
      delete writable.rowSpan;
      delete writable.columnSpan;
      const fields = Object.keys(writable).join(",");
      if (!fields) continue;
      cellStyleRequests.push({
        updateTableCellStyle: {
          tableRange: {
            tableCellLocation: {
              tableStartLocation: location(tableStartIndex, targetTabId),
              rowIndex: r,
              columnIndex: c,
            },
            rowSpan: 1,
            columnSpan: 1,
          },
          tableCellStyle: writable,
          fields,
        },
      });
    }
  }
  if (cellStyleRequests.length) await docsBatchUpdate(destinationDocId, cellStyleRequests);

  const columnProperties = sourceTable.tableStyle?.tableColumnProperties ?? [];
  const columnRequests: Record<string, unknown>[] = [];
  for (let c = 0; c < Math.min(columns, columnProperties.length); c++) {
    const props = columnProperties[c];
    if (!props) continue;
    const writable = { ...props };
    const fields = Object.keys(writable).join(",");
    if (!fields) continue;
    columnRequests.push({
      updateTableColumnProperties: {
        tableStartLocation: location(tableStartIndex, targetTabId),
        columnIndices: [c],
        tableColumnProperties: writable,
        fields,
      },
    });
  }
  if (columnRequests.length) await docsBatchUpdate(destinationDocId, columnRequests);
}

async function appendTemplateBody(
  destinationDocId: string,
  sourceDocId: string,
  replacements: PlaceholderReplacement[],
): Promise<void> {
  const sourceDocument = await docsGet(sourceDocId);
  if ((sourceDocument.tabs?.length ?? 0) > 1) {
    throw new Error(
      "FORMAT_MULTI_TAB_TEMPLATE_UNSUPPORTED: Template nguồn có nhiều tab. Hãy dùng template một tab cho batch merge.",
    );
  }
  if (sourceDocument.positionedObjects && Object.keys(sourceDocument.positionedObjects).length > 0) {
    throw new Error(
      "FORMAT_POSITIONED_OBJECT_UNSUPPORTED: Template có hình/đối tượng floating. Hãy chuyển chúng thành inline để batch merge giữ đúng format.",
    );
  }
  if (sourceDocument.footnotes && Object.keys(sourceDocument.footnotes).length > 0) {
    throw new Error("FORMAT_FOOTNOTE_UNSUPPORTED: Template có footnote; batch engine từ chối để không làm sai format.");
  }

  const replacementValues = replacementMap(replacements);
  const { body } = getFirstDocumentTab(sourceDocument);
  const content = (body?.content ?? []) as DocsStructuralElement[];

  // Separate each record explicitly. Header/footer/page setup stay inherited from
  // the copied source template because all records in a batch must use one source.
  const destination = await docsGet(destinationDocId);
  const end = endIndexOf(destination);
  await docsBatchUpdate(destinationDocId, [
    { insertPageBreak: { location: location(Math.max(1, end.endIndex - 1), end.tabId) } },
  ]);

  for (const element of content) {
    // The initial sectionBreak belongs to the document page setup already carried
    // by the copied destination. Re-inserting it can mutate page/header settings.
    if (element.sectionBreak) continue;
    if (element.paragraph) {
      await appendParagraph(destinationDocId, sourceDocument, element.paragraph, replacementValues);
    } else if (element.table) {
      await appendTable(destinationDocId, sourceDocument, element.table, replacementValues);
    } else if (element.tableOfContents) {
      throw new Error("FORMAT_TOC_UNSUPPORTED: Template có Table of Contents; batch engine từ chối để bảo toàn format.");
    }
  }
}

async function createFormatPreservingBatch(
  service: RealGoogleDocsService,
  title: string,
  content: string,
  folderId?: string,
): Promise<string> {
  const parts = content.split(PAGE_BREAK_TEXT);
  if (parts.length < 2) throw new Error("BATCH_EXPECTED_MULTIPLE_RECORDS");

  const sources = parts.map((part) => findSource(part));
  if (sources.some((source) => !source)) {
    throw new Error(
      "FORMAT_SOURCE_NOT_FOUND: Không xác định được template nguồn cho một hoặc nhiều hồ sơ trong batch; từ chối flatten plain text.",
    );
  }
  const resolved = sources as Array<{ snapshot: Snapshot; replacements: PlaceholderReplacement[] }>;
  const sourceDocIds = [...new Set(resolved.map((item) => item.snapshot.docId))];
  if (sourceDocIds.length !== 1) {
    throw new Error(
      "MIXED_TEMPLATE_BATCH_UNSUPPORTED: Batch đang chứa nhiều template A/B khác nhau. Hãy chạy riêng từng nhóm template để giữ nguyên header/footer/page setup.",
    );
  }

  const sourceDocId = sourceDocIds[0];
  const outputDocId = await service.copyDocument(sourceDocId, folderId, title);
  await service.replacePlaceholders(outputDocId, resolved[0].replacements);

  for (let i = 1; i < resolved.length; i++) {
    await appendTemplateBody(outputDocId, sourceDocId, resolved[i].replacements);
  }
  return outputDocId;
}

export function installFormatPreservingBatchPatch(): void {
  if (installed) return;
  installed = true;

  const originalGetDocumentContent = RealGoogleDocsService.prototype.getDocumentContent;
  const originalCreateDocument = RealGoogleDocsService.prototype.createDocument;
  const originalUpdateDocumentContent = RealGoogleDocsService.prototype.updateDocumentContent;
  const batchOutputs = new Set<string>();

  RealGoogleDocsService.prototype.getDocumentContent = async function patchedGetDocumentContent(docId: string) {
    const content = await originalGetDocumentContent.call(this, docId);
    rememberSnapshot(docId, content);
    return content;
  };

  RealGoogleDocsService.prototype.createDocument = async function patchedCreateDocument(
    title: string,
    content: string,
    folderId?: string,
  ) {
    if (!content.includes(PAGE_BREAK_TEXT)) {
      return originalCreateDocument.call(this, title, content, folderId);
    }
    const outputDocId = await createFormatPreservingBatch(this, title, content, folderId);
    batchOutputs.add(outputDocId);
    return outputDocId;
  };

  RealGoogleDocsService.prototype.updateDocumentContent = async function patchedUpdateDocumentContent(
    docId: string,
    content: string,
  ) {
    // route.ts calls updateDocumentContent immediately after createDocument().
    // A format-preserving batch is already fully rendered; rewriting it would
    // flatten every page back to plain text, so deliberately swallow that call.
    if (batchOutputs.has(docId)) {
      batchOutputs.delete(docId);
      return;
    }
    return originalUpdateDocumentContent.call(this, docId, content);
  };
}
