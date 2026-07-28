import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { rules, type Rule } from "@/db/schema";

/**
 * RULE ENGINE (nền tảng, #6)
 * --------------------------
 * Có chủ đích KHÔNG cho phép "viết logic tuỳ ý" (không eval() công thức) —
 * đây là rủi ro bảo mật nghiêm trọng khi chạy trên server dùng chung. Thay
 * vào đó là 1 bộ toán tử/hành động đóng gói sẵn, an toàn, đủ dùng cho các
 * ví dụ nghiệp vụ trong yêu cầu gốc (Age > 60 → WAITLIST, v.v.).
 *
 * 1 rule = nhiều điều kiện nối bằng AND. Muốn có hiệu ứng OR, tạo nhiều rule
 * độc lập cùng trigger — mỗi rule khớp sẽ tự áp dụng hành động của nó.
 */

export type RuleInput = Record<string, string | number | boolean | null | undefined>;
export type RuleActionResult = { type: string; value: string; ruleName: string };

const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"] as const;
export type Operator = (typeof OPERATORS)[number];

function toNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function evalCondition(input: RuleInput, cond: { field: string; op: string; value: string }): boolean {
  const actual = input[cond.field];
  if (actual === undefined) return false;
  switch (cond.op as Operator) {
    case "eq":
      return String(actual ?? "") === cond.value;
    case "neq":
      return String(actual ?? "") !== cond.value;
    case "contains":
      return String(actual ?? "").toLowerCase().includes(cond.value.toLowerCase());
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNumber(actual);
      const b = toNumber(cond.value);
      if (a === null || b === null) return false;
      if (cond.op === "gt") return a > b;
      if (cond.op === "gte") return a >= b;
      if (cond.op === "lt") return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

/** Chạy toàn bộ rule đang Active khớp với entityType + trigger, trả về danh sách hành động cần áp dụng. */
export async function runRules(
  entityType: string,
  trigger: string,
  input: RuleInput,
): Promise<RuleActionResult[]> {
  const activeRules = await db
    .select()
    .from(rules)
    .where(eq(rules.entityType, entityType))
    .orderBy(asc(rules.sortOrder));

  const results: RuleActionResult[] = [];
  for (const rule of activeRules) {
    if (!rule.isActive || rule.trigger !== trigger) continue;
    const conditions = rule.conditions ?? [];
    if (conditions.length === 0) continue;
    const matched = conditions.every((c) => evalCondition(input, c));
    if (matched) {
      for (const action of rule.actions ?? []) {
        results.push({ type: action.type, value: action.value, ruleName: rule.name });
      }
    }
  }
  return results;
}

export const RULE_FIELDS_DAILY_APPLICATION = [
  { key: "age", label: "Tuổi", type: "number" },
  { key: "gender", label: "Giới tính", type: "text" },
  { key: "ethnicity", label: "Dân tộc", type: "text" },
  { key: "dwMatch", label: "Cũ/Mới (đối chiếu DW)", type: "text" },
  { key: "declaredType", label: "Cũ/Mới (tự khai)", type: "text" },
  { key: "deptName", label: "Bộ phận", type: "text" },
] as const;

export const RULE_ACTIONS = [
  { key: "SET_STATUS", label: "Đặt trạng thái", hint: "vd: WAITLIST, REJECTED" },
  { key: "FLAG_NOTE", label: "Thêm ghi chú cảnh báo", hint: "vd: Cần kiểm tra sức khoẻ" },
] as const;

export const RULE_OPERATORS: { key: Operator; label: string }[] = [
  { key: "eq", label: "=" },
  { key: "neq", label: "≠" },
  { key: "gt", label: ">" },
  { key: "gte", label: "≥" },
  { key: "lt", label: "<" },
  { key: "lte", label: "≤" },
  { key: "contains", label: "chứa" },
];

export type { Rule };
