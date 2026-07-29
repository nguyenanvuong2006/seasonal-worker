import type { FormQuestion } from "@/db/schema";

export type Stage =
  | "check"
  | "returning_autofilled"
  | "already_registered"
  | "new"
  | "success";

export interface WorkerInfo {
  full_name?: string;
  phone?: string | null;
  dob?: string | null;
  address_current?: string | null;
  status?: string;
  dept_name?: string | null;
  dept_location?: string | null;
}

export interface QuestionRendererProps {
  questions: FormQuestion[];
  answers: Record<string, string>;
  setAnswers: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
}
