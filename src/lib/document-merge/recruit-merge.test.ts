import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DOCUMENT_KIND_META,
  documentKindLabel,
  extractGoogleDocId,
  googleDocEditUrl,
  googleDocPdfUrl,
  isReturningWorker,
  resolveDocumentKind,
  resolveDwClassification,
  selectTemplateForApplicant,
  selectTemplateForKind,
} from "./template-routing.ts";
import {
  applyFallbackPlaceholders,
  buildPreviewContent,
  countPageBreaks,
  joinWithPageBreaks,
} from "./preview-merge.ts";
import {
  isValidSignatureDataUrl,
  normalizeConfirmedAnswersInput,
  validateConfirmedAnswers,
} from "./signature.ts";
import { buildApplicantMergeRecord } from "./applicant-record.ts";
import { PAGE_BREAK_TEXT } from "./google-docs-service.ts";

describe("Dual-template routing", () => {
  it("routes DW Cũ (MATCHED) to Tài liệu A", () => {
    assert.equal(resolveDocumentKind({ dwMatch: "MATCHED", declaredType: "NEW" }), "A");
    assert.equal(resolveDwClassification({ dwMatch: "MATCHED" }), "OLD");
    assert.equal(isReturningWorker({ dwMatch: "MATCHED" }), true);
  });

  it("routes declaredType OLD to Tài liệu A even without MATCHED", () => {
    assert.equal(resolveDocumentKind({ declaredType: "OLD", dwMatch: "NEW" }), "A");
  });

  it("routes DW Mới to Tài liệu B", () => {
    assert.equal(resolveDocumentKind({ declaredType: "NEW", dwMatch: "NEW" }), "B");
    assert.equal(resolveDwClassification({ declaredType: "NEW", dwMatch: "MISMATCH" }), "NEW");
    assert.equal(isReturningWorker({ declaredType: "NEW", dwMatch: "NEW" }), false);
  });

  it("picks template A / B and falls back to GENERIC", () => {
    const templates = [
      { id: "gen", documentKind: "GENERIC", isActive: true },
      { id: "a", documentKind: "A", isActive: true },
      { id: "b-off", documentKind: "B", isActive: false },
    ];
    assert.equal(selectTemplateForKind(templates, "A")?.id, "a");
    assert.equal(selectTemplateForKind(templates, "B")?.id, "gen");
    assert.equal(selectTemplateForApplicant(templates, { dwMatch: "MATCHED" }).kind, "A");
    assert.equal(selectTemplateForApplicant(templates, { dwMatch: "MATCHED" }).template?.id, "a");
    assert.equal(selectTemplateForApplicant(templates, { declaredType: "NEW" }).template?.id, "gen");
  });

  it("exposes labels for Tài liệu A / B", () => {
    assert.ok(DOCUMENT_KIND_META.A.subtitle.includes("Cam kết"));
    assert.ok(DOCUMENT_KIND_META.B.subtitle.includes("Hợp đồng"));
    assert.ok(documentKindLabel("A").includes("Tái ký"));
    assert.ok(documentKindLabel("B").includes("đào tạo"));
  });
});

describe("Google Doc ID extraction", () => {
  it("extracts ID from a full Google Docs URL", () => {
    const id = extractGoogleDocId(
      "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
    );
    assert.equal(id, "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms");
  });

  it("accepts a bare document id", () => {
    assert.equal(
      extractGoogleDocId("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"),
      "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
    );
  });

  it("rejects empty or garbage input", () => {
    assert.equal(extractGoogleDocId(""), null);
    assert.equal(extractGoogleDocId("not-a-doc"), null);
  });

  it("builds edit and PDF urls", () => {
    assert.equal(
      googleDocEditUrl("abc123"),
      "https://docs.google.com/document/d/abc123/edit",
    );
    assert.equal(
      googleDocPdfUrl("abc123"),
      "https://docs.google.com/document/d/abc123/export?format=pdf",
    );
  });
});

describe("Preview merge with real applicant data", () => {
  it("fills placeholders from flattened daily application data", () => {
    const record = buildApplicantMergeRecord({
      application: {
        id: "app-1",
        cccd: "012345678901",
        fullName: "Nguyễn Văn A",
        gender: "Nam",
        dob: "1990-01-15",
        phone: "0901234567",
        declaredType: "NEW",
        dwMatch: "NEW",
        regDate: "2026-08-15",
        startingDate: "2026-08-16",
        customAnswers: { cam_ket: "Đồng ý" },
      },
      department: { deptName: "Packing", groupName: "A1" },
    });

    const values = applyFallbackPlaceholders(record);
    const preview = buildPreviewContent(
      "HỌ TÊN: <<Ho_ten>>\nCCCD: <<So_CCCD>>\nBỘ PHẬN: <<Bo_phan>>\nCAM KẾT: <<cam_ket>>",
      values,
    );

    assert.ok(preview.content.includes("Nguyễn Văn A"));
    assert.ok(preview.content.includes("012345678901"));
    assert.ok(preview.content.includes("Packing"));
    assert.ok(preview.content.includes("Đồng ý"));
    assert.deepEqual(preview.unreplaced, []);
  });

  it("does not overwrite an already mapped value", () => {
    const values = applyFallbackPlaceholders(
      { fullName: "From Record", cccd: "012345678901" },
      { Ho_ten: "From Mapping" },
    );
    assert.equal(values.Ho_ten, "From Mapping");
    assert.equal(values.So_CCCD, "012345678901");
  });
});

describe("Batch print with page break", () => {
  it("joins applicant documents with a page-break marker", () => {
    const merged = joinWithPageBreaks(["DOC A", "DOC B", "DOC C"]);
    assert.equal(countPageBreaks(merged), 2);
    assert.ok(merged.includes(PAGE_BREAK_TEXT));
    assert.ok(merged.startsWith("DOC A"));
    assert.ok(merged.endsWith("DOC C"));
  });

  it("skips empty sections so trailing page breaks are not added", () => {
    const merged = joinWithPageBreaks(["ONLY", "  ", ""]);
    assert.equal(countPageBreaks(merged), 0);
    assert.equal(merged, "ONLY");
  });
});

describe("Electronic signature validation", () => {
  const validPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("accepts a real PNG data URL", () => {
    assert.equal(isValidSignatureDataUrl(validPng), true);
  });

  it("rejects empty, short, or non-image payloads", () => {
    assert.equal(isValidSignatureDataUrl(""), false);
    assert.equal(isValidSignatureDataUrl("data:image/png;base64,abc"), false);
    assert.equal(isValidSignatureDataUrl("hello"), false);
    assert.equal(isValidSignatureDataUrl(null), false);
  });

  it("requires answers for required confirmation questions", () => {
    const questions = [
      { fieldKey: "cam_ket", questionText: "Cam kết tuân thủ nội quy?", isRequired: true },
      { fieldKey: "ghi_chu", questionText: "Ghi chú", isRequired: false },
    ];
    const missing = validateConfirmedAnswers(questions, {});
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.ok(missing.error.includes("Cam kết"));

    const ok = validateConfirmedAnswers(questions, { cam_ket: "Đồng ý" });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.answers.cam_ket, "Đồng ý");
  });

  it("normalizes confirmed answer payloads", () => {
    const answers = normalizeConfirmedAnswersInput({ cam_ket: "  Có  ", empty: "  ", skip: null });
    assert.deepEqual(answers, { cam_ket: "Có" });
  });
});
