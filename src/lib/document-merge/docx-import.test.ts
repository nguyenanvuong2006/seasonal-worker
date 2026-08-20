/**
 * DOCX import — tests (Phase 4).
 * Stub mammoth để test luật import (không publish tự động, giới hạn size,
 * warning layout, count placeholder) mà không cần file DOCX thật.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

function load(mammothStub: Record<string, unknown>) {
  return loadModule(new URL("./docx-import.ts", import.meta.url), {
    stubs: {
      mammoth: mammothStub,
    },
  }) as unknown as {
    convertDocxToHtml: (buffer: Buffer | Uint8Array) => Promise<{
      html: string;
      messages: string[];
      hasWarnings: boolean;
    }>;
    countPlaceholdersInHtml: (html: string) => number;
    DocxImportError: new (message: string, status?: number) => Error;
  };
}

test("convertDocxToHtml: trả HTML + đánh dấu warning layout", async () => {
  const mod = load({
    convertToHtml: async () => ({
      value: "<h1>Đăng ký</h1><p>Họ tên: <<Ho_ten>></p>",
      messages: [{ message: "An image was skipped (too large)" }],
    }),
    images: { imgElement: () => () => Promise.resolve({ src: "" }) },
  });

  const result = await mod.convertDocxToHtml(Buffer.from("fake-docx"));
  assert.match(result.html, /<<Ho_ten>>/);
  assert.equal(result.hasWarnings, true);
  assert.equal(result.messages.length, 1);
});

test("convertDocxToHtml: không warning khi layout sạch", async () => {
  const mod = load({
    convertToHtml: async () => ({ value: "<p>OK</p>", messages: [] }),
    images: { imgElement: () => () => Promise.resolve({ src: "" }) },
  });
  const result = await mod.convertDocxToHtml(Buffer.from("fake-docx"));
  assert.equal(result.hasWarnings, false);
});

test("convertDocxToHtml: từ chối file rỗng và file quá lớn", async () => {
  const mod = load({
    convertToHtml: async () => ({ value: "", messages: [] }),
    images: { imgElement: () => () => Promise.resolve({ src: "" }) },
  });

  await assert.rejects(() => mod.convertDocxToHtml(Buffer.alloc(0)), (err: Error) =>
    err.message.includes("rỗng"),
  );
  await assert.rejects(() => mod.convertDocxToHtml(Buffer.alloc(11 * 1024 * 1024)), (err: Error) =>
    err.message.includes("quá lớn"),
  );
});

test("convertDocxToHtml: lỗi mammoth → DocxImportError", async () => {
  const mod = load({
    convertToHtml: async () => {
      throw new Error("corrupt docx");
    },
    images: { imgElement: () => () => Promise.resolve({ src: "" }) },
  });
  await assert.rejects(() => mod.convertDocxToHtml(Buffer.from("x")), (err: Error) =>
    err.message.includes("Không đọc được file DOCX"),
  );
});

test("countPlaceholdersInHtml: đếm placeholder trong HTML", async () => {
  const mod = load({
    convertToHtml: async () => ({ value: "", messages: [] }),
    images: { imgElement: () => () => Promise.resolve({ src: "" }) },
  });
  assert.equal(mod.countPlaceholdersInHtml("<p><<Ho_ten>> + <<So_CCCD>> + <<Ho_ten>></p>"), 3);
  assert.equal(mod.countPlaceholdersInHtml("<p>không có</p>"), 0);
});
