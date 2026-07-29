"use client";

import {
  Button,
  Input,
  Label,
  SearchableSelect,
} from "@/components/ui";

import type { QuestionRendererProps } from "./types";

export default function QuestionRenderer({
  questions,
  answers,
  setAnswers,
}: QuestionRendererProps) {
  if (questions.length === 0) return null;

  return (
    <div className="space-y-5 border-t border-dashed pt-6">

      <div>

        <p className="text-xs font-black uppercase tracking-[0.25em] text-hasfarm-700">
          Câu hỏi khảo sát
        </p>

        <p className="mt-2 text-sm text-slate-500">
          Vui lòng trả lời đầy đủ các câu hỏi bắt buộc.
        </p>

      </div>

      {questions.map((q) => (

        <div
          key={q.id}
          className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
        >

          <Label className="text-sm font-semibold">

            {q.questionText}

            {q.isRequired && (
              <span className="ml-1 text-red-500">*</span>
            )}

          </Label>

          <div className="mt-3">

            {q.fieldType === "SELECT" &&
            (q.options?.length ?? 0) > 0 ? (

              <SearchableSelect
                value={answers[q.fieldKey]}
                onChange={(v) =>
                  setAnswers((prev) => ({
                    ...prev,
                    [q.fieldKey]: v,
                  }))
                }
                options={(q.options ?? []).map((o) => ({
                  value: o,
                  label: o,
                }))}
              />

            ) : q.fieldType === "BOOLEAN" ? (

              <div className="grid grid-cols-2 gap-3">

                <Button
                  type="button"
                  variant={
                    answers[q.fieldKey] === "Có"
                      ? "success"
                      : "outline"
                  }
                  onClick={() =>
                    setAnswers((prev) => ({
                      ...prev,
                      [q.fieldKey]: "Có",
                    }))
                  }
                >
                  Có
                </Button>

                <Button
                  type="button"
                  variant={
                    answers[q.fieldKey] === "Không"
                      ? "destructive"
                      : "outline"
                  }
                  onClick={() =>
                    setAnswers((prev) => ({
                      ...prev,
                      [q.fieldKey]: "Không",
                    }))
                  }
                >
                  Không
                </Button>

              </div>

            ) : (

              <Input
                value={answers[q.fieldKey] || ""}
                onChange={(e) =>
                  setAnswers((prev) => ({
                    ...prev,
                    [q.fieldKey]: e.target.value,
                  }))
                }
                placeholder="Nhập câu trả lời..."
              />

            )}

          </div>

        </div>

      ))}

    </div>
  );
}
