/**
 * ASSIGNMENT ACTOR — propagation + Nguoi_tiep_nhan resolution.
 *
 * - assignment-actor fields flow from daily_applications into the flattened
 *   merge record.
 * - SYSTEM_FIELD `ASSIGNED_BY_DISPLAY_NAME` (used by `Nguoi_tiep_nhan`)
 *   resolves to the frozen assignedByDisplayName, never the merge operator.
 * - Historical rows without an assignment actor resolve to EMPTY (no leak).
 * - CURRENT_USER_NAME (merge operator) keeps its original semantics.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApplicantMergeRecord } from "./applicant-record.ts";
import { resolveFieldValue, type MergeContext, type RecordData } from "./data-resolver.ts";
import type { MergeTemplateField } from "../../db/schema.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

test("Nguoi_tiep_nhan resolves to assignedByDisplayName (User A), not merge operator (User B)", () => {
  const field = systemField("Nguoi_tiep_nhan", "ASSIGNED_BY_DISPLAY_NAME");
  const record: RecordData = { id: "app-1", fullName: "An Vượng", assignedByDisplayName: "Nguyễn An Vượng" };
  const context: MergeContext = { currentUserId: "u-b", currentUserName: "Người merge B", currentDate: new Date("2026-08-26") };

  assert.equal(resolveFieldValue(field, record, context), "Nguyễn An Vượng");
});

test("historical NULL assignment actor resolves to EMPTY (does NOT leak merge user)", () => {
  const field = systemField("Nguoi_tiep_nhan", "ASSIGNED_BY_DISPLAY_NAME");
  const record: RecordData = { id: "app-1", fullName: "An Vượng" }; // no assignedByDisplayName
  const context: MergeContext = { currentUserId: "u-b", currentUserName: "Người merge B", currentDate: new Date("2026-08-26") };

  assert.equal(resolveFieldValue(field, record, context), "");
});

test("blank assignedByDisplayName resolves to EMPTY (no leak)", () => {
  const field = systemField("Nguoi_tiep_nhan", "ASSIGNED_BY_DISPLAY_NAME");
  const record: RecordData = { id: "app-1", assignedByDisplayName: "   " };
  const context: MergeContext = { currentUserId: "u-b", currentUserName: "Người merge B", currentDate: new Date("2026-08-26") };

  assert.equal(resolveFieldValue(field, record, context), "");
});

test("CURRENT_USER_NAME keeps merge-operator semantics (v11 published snapshot unchanged)", () => {
  const field = systemField("Nguoi_tiep_nhan", "CURRENT_USER_NAME");
  const record: RecordData = { id: "app-1", fullName: "An Vượng", assignedByDisplayName: "Nguyễn An Vượng" };
  const context: MergeContext = { currentUserId: "u-b", currentUserName: "Người merge B", currentDate: new Date("2026-08-26") };

  // A frozen v11 published snapshot maps Nguoi_tiep_nhan → CURRENT_USER_NAME; that
  // must still resolve to the merge operator (unchanged historical semantics).
  assert.equal(resolveFieldValue(field, record, context), "Người merge B");
});

test("v11 published mapping data still records Nguoi_tiep_nhan → CURRENT_USER_NAME (snapshot data unchanged)", () => {
  const mapping = JSON.parse(readFileSync(join(REPO_ROOT, "templates/document-merge/trainee-registration/v7-mapping.json"), "utf8")) as Array<{
    placeholder: string;
    sourceField: string | null;
    sourceType: string;
  }>;
  const nguoi = mapping.find((m) => m.placeholder === "Nguoi_tiep_nhan");
  assert.ok(nguoi);
  assert.equal(nguoi.sourceType, "SYSTEM_FIELD");
  assert.equal(nguoi.sourceField, "CURRENT_USER_NAME");
});
