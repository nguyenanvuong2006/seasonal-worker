import "server-only";

import { asc } from "drizzle-orm";
import { db } from "@/db";
import { formQuestions, type FieldDefinition, type FormQuestion } from "@/db/schema";
import {
  acceptedColumnNames,
  getFieldDefinitions,
  normalizeHeader,
  normalizeHeaderFuzzy,
  type Group,
} from "@/lib/metadata";

export type ImportTemplateColumn = {
  id: string;
  fieldKey: string;
  header: string;
  label: string;
  source: "CORE" | "QUESTION";
  required: boolean;
  requiredForImport: boolean;
  fieldType: string;
  options: string[];
  aliases: string[];
  sortOrder: number;
  defaultVisible: boolean;
  isActiveQuestion: boolean;
  visibleToApplicants: boolean;
  questionFieldKeys: string[];
};

function normalizedNames(values: string[]) {
  return new Set(values.filter(Boolean).map(normalizeHeader));
}

function fuzzyNames(values: string[]) {
  return new Set(values.filter(Boolean).map(normalizeHeaderFuzzy));
}

/** Chọn một tên header nhận diện được nhưng không trùng/không mơ hồ với cột khác. */
function makeHeadersUnique(columns: ImportTemplateColumn[]): ImportTemplateColumn[] {
  const frequency = new Map<string, number>();
  for (const column of columns) {
    const namesInColumn = new Set(
      [column.header, ...column.aliases].filter(Boolean).map(normalizeHeader),
    );
    for (const name of namesInColumn) frequency.set(name, (frequency.get(name) ?? 0) + 1);
  }

  const used = new Set<string>();
  return columns.map((column) => {
    const candidates = Array.from(new Set([column.header, ...column.aliases].filter(Boolean)));
    // Ưu tiên alias chỉ thuộc đúng cột này. Ví dụ hai cột địa chỉ cùng nhận
    // "Địa chỉ", template sẽ chọn rõ "Địa chỉ hiện tại" và "Địa chỉ thường trú".
    const globallyUnique = candidates.find((candidate) =>
      frequency.get(normalizeHeader(candidate)) === 1 && !used.has(normalizeHeader(candidate)),
    );
    const locallyUnique = candidates.find((candidate) => !used.has(normalizeHeader(candidate)));
    const unique = globallyUnique ?? locallyUnique ?? column.header;
    used.add(normalizeHeader(unique));
    return { ...column, header: unique };
  });
}

/**
 * Chấm điểm một câu hỏi động so với một trường lõi. Điểm cao nhất là tên câu hỏi
 * trùng đúng tên cột/trường; alias chỉ là lớp dự phòng. Nhờ vậy các câu hỏi như
 * "Giới tính", "Dân tộc", "Thời gian đăng ký làm" dùng CHUNG một cột với dữ
 * liệu lõi thay vì xuất hiện hai cột trùng nhau trong template.
 */
function questionFieldScore(def: FieldDefinition, question: FormQuestion): number {
  const defPrimary = [def.importColumnName ?? "", def.displayName];
  const questionPrimary = question.questionText;
  const normalizedPrimary = normalizeHeader(questionPrimary);
  if (defPrimary.some((name) => normalizeHeader(name) === normalizedPrimary)) return 100;

  const defNames = acceptedColumnNames(def);
  // Không dùng fieldKey kỹ thuật để quyết định ghép ngữ nghĩa với trường lõi.
  const questionNames = [question.questionText, ...((question.aliases as string[] | null) ?? [])];
  const exact = normalizedNames(defNames);
  if (questionNames.some((name) => exact.has(normalizeHeader(name)))) return 80;

  const fuzzy = fuzzyNames(defNames);
  if (questionNames.some((name) => fuzzy.has(normalizeHeaderFuzzy(name)))) return 60;
  return 0;
}

/**
 * Nguồn template dùng chung cho bảng dán trực tiếp và file CSV mẫu.
 *
 * Với Daily Application, mọi câu hỏi đang hiển thị trên form ứng viên đều được
 * đưa vào bảng mặc định. Câu hỏi nội bộ/đã tắt vẫn có trong danh sách để Admin
 * chủ động thêm lại, nhưng không tự chiếm chỗ trong bảng.
 */
export async function getImportTemplate(group: Group): Promise<ImportTemplateColumn[]> {
  const defs = (await getFieldDefinitions(group))
    .filter((def) => def.importable)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (group !== "daily_application") {
    return makeHeadersUnique(defs.map((def) => ({
      id: `field:${def.fieldKey}`,
      fieldKey: def.fieldKey,
      header: def.importColumnName || def.displayName,
      label: def.displayName,
      source: "CORE" as const,
      required: def.required,
      requiredForImport: def.required,
      fieldType: def.fieldType,
      options: [],
      aliases: acceptedColumnNames(def),
      sortOrder: def.sortOrder,
      defaultVisible: true,
      isActiveQuestion: false,
      visibleToApplicants: false,
      questionFieldKeys: [],
    })));
  }

  const questions = await db.select().from(formQuestions).orderBy(asc(formQuestions.sortOrder));
  const publicActiveQuestions = questions.filter(
    (question) => question.isActive && question.visibleToApplicants,
  );

  // Mỗi câu hỏi công khai chỉ ghép với trường lõi phù hợp nhất (nếu có).
  const linkedByField = new Map<string, FormQuestion[]>();
  const linkedQuestionKeys = new Set<string>();
  for (const question of publicActiveQuestions) {
    let best: { def: FieldDefinition; score: number } | null = null;
    for (const def of defs) {
      const score = questionFieldScore(def, question);
      if (score > 0 && (!best || score > best.score)) best = { def, score };
    }
    if (best) {
      const linked = linkedByField.get(best.def.fieldKey) ?? [];
      linked.push(question);
      linkedByField.set(best.def.fieldKey, linked);
      linkedQuestionKeys.add(question.fieldKey);
    }
  }

  const coreColumns: ImportTemplateColumn[] = defs.map((def) => {
    const linked = linkedByField.get(def.fieldKey) ?? [];
    const primaryQuestion = linked[0];
    const allNames = [
      ...acceptedColumnNames(def),
      ...linked.flatMap((question) => acceptedColumnNames(question, true)),
    ];
    return {
      id: `field:${def.fieldKey}`,
      fieldKey: def.fieldKey,
      // Header phải là tên canonical của trường lõi. Alias câu hỏi liên kết sẽ
      // khiến Import Engine đồng thời lưu cùng giá trị vào custom_answers.
      header: def.importColumnName || def.displayName,
      label: primaryQuestion?.questionText || def.displayName,
      source: "CORE",
      required: def.required || linked.some((question) => question.isRequired),
      requiredForImport: def.required,
      fieldType: primaryQuestion?.fieldType || def.fieldType,
      options: Array.from(new Set(linked.flatMap((question) => question.options ?? []))),
      aliases: Array.from(new Set(allNames)),
      sortOrder: def.sortOrder * 10,
      defaultVisible: true,
      isActiveQuestion: linked.length > 0,
      visibleToApplicants: linked.length > 0,
      questionFieldKeys: linked.map((question) => question.fieldKey),
    };
  });

  const questionColumns: ImportTemplateColumn[] = questions
    .filter((question) => !linkedQuestionKeys.has(question.fieldKey))
    .map((question) => ({
      id: `question:${question.fieldKey}`,
      fieldKey: question.fieldKey,
      header: question.questionText,
      label: question.questionText,
      source: "QUESTION" as const,
      required: question.isRequired,
      // Dữ liệu lịch sử được phép thiếu câu hỏi động dù câu hỏi hiện tại là
      // bắt buộc trên form công khai; validation lõi vẫn do Import Engine giữ.
      requiredForImport: false,
      fieldType: question.fieldType,
      options: question.options ?? [],
      aliases: acceptedColumnNames(question, true),
      sortOrder: 10_000 + question.sortOrder,
      defaultVisible: question.isActive && question.visibleToApplicants,
      isActiveQuestion: question.isActive,
      visibleToApplicants: question.visibleToApplicants,
      questionFieldKeys: [question.fieldKey],
    }));

  return makeHeadersUnique(
    [...coreColumns, ...questionColumns].sort((a, b) => a.sortOrder - b.sortOrder),
  );
}
