/**
 * Template versioning service — tests (Phase 3).
 * Chạy trên ĐÚNG src/lib/document-merge/template-versions.ts, với drizzle
 * thay bằng fake-drizzle để soi toàn bộ truy vấn mà không cần DB thật.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakeDb,
  drizzleStub,
  makeTable,
  eqValue,
  argOf,
  type FakeDb,
  type QueryCall,
} from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

const schemaStub = {
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

type VersionModule = {
  nextVersionNumber: (existing: { version: number }[]) => number;
  normalizeRetentionYears: (value: number | null | undefined) => number | null;
  createTemplateVersion: (
    templateId: string,
    createdBy: string,
    input?: Record<string, unknown>,
  ) => Promise<{
    id: string;
    templateId: string;
    version: number;
    status: string;
    htmlBody: string | null;
    createdBy: string;
  }>;
  publishTemplateVersion: (
    templateId: string,
    versionId: string,
    createdBy: string,
  ) => Promise<Record<string, unknown>>;
  archiveTemplateVersion: (templateId: string, versionId: string) => Promise<Record<string, unknown>>;
  scanPlaceholdersInVersionHtml: (htmlBody: string) => string[];
};

async function load(db: FakeDb): Promise<VersionModule> {
  const mod = await loadModule(new URL("./template-versions.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "./placeholder-extractor.ts": {
        extractUniquePlaceholders: (content: string) => {
          const unique = new Set<string>();
          for (const m of content.matchAll(/<<([^>]+)>>/g)) unique.add(m[1].trim());
          return Array.from(unique).sort();
        },
      },
    },
  });
  return mod as unknown as VersionModule;
}

const FIELD_MAPPED = {
  id: "f1",
  templateId: "tpl-1",
  placeholder: "Ho_ten",
  sourceType: "CORE_FIELD",
  sourceEntity: null,
  sourceField: null,
  sourcePath: "fullName",
  optionValue: null,
  formatType: "RAW",
  fallbackValue: null,
  isRequired: true,
  isOrphaned: false,
};
const FIELD_ORPHAN = {
  id: "f2",
  templateId: "tpl-1",
  placeholder: "Phantom_x",
  sourceType: "CORE_FIELD",
  sourceEntity: null,
  sourceField: null,
  sourcePath: "x",
  optionValue: null,
  formatType: "RAW",
  fallbackValue: null,
  isRequired: false,
  isOrphaned: true,
};

test("nextVersionNumber: 0 version → 1, có version → max+1", async () => {
  const mod = await load(createFakeDb({ respond: () => [] }));
  assert.equal(mod.nextVersionNumber([]), 1);
  assert.equal(mod.nextVersionNumber([{ version: 1 }, { version: 3 }]), 4);
});

test("normalizeRetentionYears: hợp lệ giữ nguyên, không hợp lệ → 3, null → null", async () => {
  const mod = await load(createFakeDb({ respond: () => [] }));
  assert.equal(mod.normalizeRetentionYears(1), 1);
  assert.equal(mod.normalizeRetentionYears(5), 5);
  assert.equal(mod.normalizeRetentionYears(7), 3);
  assert.equal(mod.normalizeRetentionYears(null), null);
  assert.equal(mod.normalizeRetentionYears(undefined), null);
});

test("createTemplateVersion: version DRAFT mới, số version tăng dần", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select") return [{ version: 1 }, { version: 2 }];
      if (call.root === "insert") {
        return [
          {
            id: "v3",
            templateId: "tpl-1",
            version: 3,
            status: "DRAFT",
            htmlBody: "<p>X</p>",
            createdBy: "admin",
          },
        ];
      }
      return undefined;
    },
  });
  const mod = await load(db);

  const version = await mod.createTemplateVersion("tpl-1", "admin", { htmlBody: "<p>X</p>" });
  assert.equal(version.version, 3);
  assert.equal(version.status, "DRAFT");

  const insert = db.calls.find((c) => c.root === "insert");
  assert.ok(insert, "phải INSERT version");
  const values = argOf(insert as QueryCall, "values") as Record<string, unknown>;
  assert.equal(values.templateId, "tpl-1");
  assert.equal(values.version, 3);
  assert.equal(values.status, "DRAFT");
  assert.equal(values.createdBy, "admin");
});

test("publishTemplateVersion: snapshot mapping + archive version cũ + cập nhật template", async () => {
  const db = createFakeDb({
    respond: (call) => {
      // select 1: version mục tiêu (DRAFT)
      if (call.root === "select" && call.table === "merge_template_versions") {
        if (db.calls.filter((c) => c.root === "select" && c.table === "merge_template_versions").length === 1) {
          return [
            {
              id: "v2",
              templateId: "tpl-1",
              version: 2,
              status: "DRAFT",
              htmlBody: "<p>X</p>",
              createdBy: "admin",
            },
          ];
        }
        // select 2: version PUBLISHED cũ
        return [{ id: "v1", templateId: "tpl-1", version: 1, status: "PUBLISHED" }];
      }
      if (call.root === "select" && call.table === "merge_template_fields") {
        return [FIELD_MAPPED, FIELD_ORPHAN];
      }
      if (call.root === "update" && call.table === "merge_template_versions") {
        return [
          {
            id: "v2",
            templateId: "tpl-1",
            version: 2,
            status: "PUBLISHED",
            mappingSnapshot: [
              {
                placeholder: "Ho_ten",
                sourceType: "CORE_FIELD",
                sourceEntity: null,
                sourceField: null,
                sourcePath: "fullName",
                optionValue: null,
                formatType: "RAW",
                fallbackValue: null,
                isRequired: true,
              },
            ],
          },
        ];
      }
      if (call.root === "update" && call.table === "merge_templates") {
        return [{ id: "tpl-1", currentPublishedVersion: 2 }];
      }
      return undefined;
    },
  });
  const mod = await load(db);

  const published = await mod.publishTemplateVersion("tpl-1", "v2", "admin");
  assert.equal(published.version, 2);
  assert.equal(published.status, "PUBLISHED");
  assert.equal(db.transactions, 1, "publish phải chạy trong transaction");

  // Snapshot chỉ chứa field không orphan
  assert.deepEqual(published.mappingSnapshot, [
    {
      placeholder: "Ho_ten",
      sourceType: "CORE_FIELD",
      sourceEntity: null,
      sourceField: null,
      sourcePath: "fullName",
      optionValue: null,
      formatType: "RAW",
      fallbackValue: null,
      isRequired: true,
    },
  ]);

  // Version cũ v1 bị ARCHIVED + superseded_by = 2
  const v1Update = db.calls.find(
    (c) =>
      c.root === "update" &&
      c.table === "merge_template_versions" &&
      eqValue(c, "merge_template_versions.id") === "v1",
  );
  assert.ok(v1Update, "phải UPDATE version cũ v1");
  const setArgs = argOf(v1Update as QueryCall, "set") as Record<string, unknown>;
  assert.equal(setArgs.status, "ARCHIVED");
  assert.equal(setArgs.supersededBy, 2);

  // merge_templates.current_published_version = 2
  const tplUpdate = db.calls.find(
    (c) => c.root === "update" && c.table === "merge_templates",
  );
  assert.ok(tplUpdate, "phải UPDATE merge_templates");
});

test("publishTemplateVersion: từ chối publish version không có HTML", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") {
        return [{ id: "v1", templateId: "tpl-1", version: 1, status: "DRAFT", htmlBody: null }];
      }
      return undefined;
    },
  });
  const mod = await load(db);

  await assert.rejects(
    () => mod.publishTemplateVersion("tpl-1", "v1", "admin"),
    (err: { status?: number; message?: string }) =>
      err instanceof Error && err.message.includes("chưa có nội dung HTML"),
  );
});

test("archiveTemplateVersion: không archive version đang PUBLISHED", async () => {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") {
        return [{ id: "v3", templateId: "tpl-1", version: 3, status: "PUBLISHED" }];
      }
      return undefined;
    },
  });
  const mod = await load(db);

  await assert.rejects(
    () => mod.archiveTemplateVersion("tpl-1", "v3"),
    (err: { status?: number; message?: string }) =>
      err instanceof Error && err.message.includes("đang PUBLISHED"),
  );
});

test("scanPlaceholdersInVersionHtml: đọc placeholder từ html_body (không cần Google Docs)", async () => {
  const mod = await load(createFakeDb({ respond: () => [] }));
  const html = "<p>Họ tên: <<Ho_ten>></p><p>CCCD: <<So_CCCD>></p><p>Họ tên lặp: <<Ho_ten>></p>";
  assert.deepEqual(mod.scanPlaceholdersInVersionHtml(html), ["Ho_ten", "So_CCCD"]);
});
