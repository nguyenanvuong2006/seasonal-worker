/**
 * ASSIGNMENT ACTOR (freeze) — assignment-actor fields must flow from
 * daily_applications into the flattened merge record, and SYSTEM_FIELD
 * `CURRENT_USER_NAME` (dùng cho placeholder `Nguoi_tiep_nhan`) phải resolve
 * thành `assignedByDisplayName` (người xếp việc) thay vì merge operator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildApplicantMergeRecord } from "./applicant-record.ts";
import { resolveFieldValue, type MergeContext, type RecordData } from "./data-resolver.ts";
import type { MergeTemplateField } from "../../db/schema.ts";

function systemField(placeholder: string, sourceField: string): MergeTemplateField {
  return {
    id: "f-" + placeholder,
    templateId: "tpl-1",
    placeholder,
    sourceType: "SYSTEM_FIELD",
    sourceEntity: null,
    sourceField,
    sourcePath: null,
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: false,
    isOrphaned: false,
    isSuggested: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as MergeTemplateField;
}

test("buildApplicantMergeRecord truyền assignedBy / assignedByDisplayName / assignedAt", () => {
  const record = buildApplicantMergeRecord({
    application: {
      id: "app-1",
      cccd: "012345678901",
      fullName: "An Vượng",
      assignedBy: "anvuong",
      assignedByDisplayName: "Nguyễn An Vượng",
      assignedAt: new Date("2026-08-26T03:00:00Z"),
    },
    department: null,
    dw: null,
    worker: null,
  });

  assert.equal(record.assignedBy, "anvuong");
  assert.equal(record.assignedByDisplayName, "Nguyễn An Vượng");
  assert.equal((record.assignedAt as Date).getTime(), new Date("2026-08-26T03:00:00Z").getTime());
});

test("CURRENT_USER_NAME ưu tiên assignedByDisplayName (Nguoi_tiep_nhan)", () => {
  const field = systemField("Nguoi_tiep_nhan", "CURRENT_USER_NAME");
  const record: RecordData = {
    id: "app-1",
    fullName: "An Vượng",
    assignedByDisplayName: "Nguyễn An Vượng",
  };
  const context: MergeContext = {
    currentUserId: "u-merger",
    currentUserName: "Người merge",
    currentDate: new Date("2026-08-26"),
  };

  assert.equal(resolveFieldValue(field, record, context), "Nguyễn An Vượng");
});

test("CURRENT_USER_NAME fallback về merge operator khi chưa có assignedByDisplayName", () => {
  const field = systemField("Nguoi_tiep_nhan", "CURRENT_USER_NAME");
  const record: RecordData = { id: "app-1", fullName: "An Vượng" };
  const context: MergeContext = {
    currentUserId: "u-merger",
    currentUserName: "Người merge",
    currentDate: new Date("2026-08-26"),
  };

  assert.equal(resolveFieldValue(field, record, context), "Người merge");
});

test("assignedByDisplayName rỗng/blank không ghi đè merge operator", () => {
  const field = systemField("Nguoi_tiep_nhan", "CURRENT_USER_NAME");
  const record: RecordData = { id: "app-1", assignedByDisplayName: "   " };
  const context: MergeContext = {
    currentUserId: "u-merger",
    currentUserName: "Người merge",
    currentDate: new Date("2026-08-26"),
  };

  assert.equal(resolveFieldValue(field, record, context), "Người merge");
});
