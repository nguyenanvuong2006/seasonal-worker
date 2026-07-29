"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui";
import SectionCard from "./section-card";
import FormHeader from "./form-header";
import type { WorkerInfo } from "./types";

interface Props {
  worker: WorkerInfo | null;
  onReset: () => void;
}

export default function AlreadyRegisteredStage({
  worker,
  onReset,
}: Props) {
  return (
    <SectionCard>

      <FormHeader
        icon={<AlertTriangle className="h-5 w-5" />}
        badge="ĐÃ ĐĂNG KÝ"
        title="Bạn đã đăng ký hôm nay"
        description="Không cần gửi hồ sơ thêm lần nữa."
      />

      <div className="rounded-2xl border bg-amber-50 p-5">

        <div className="font-bold">
          {worker?.full_name}
        </div>

        <div className="mt-3 text-sm">

          Bộ phận:

          <strong className="ml-2">
            {worker?.dept_name || "Đang chờ"}
          </strong>

        </div>

        {worker?.dept_location && (
          <div className="mt-2 text-sm">
            📍 {worker.dept_location}
          </div>
        )}

      </div>

      <Button
        className="mt-6 w-full"
        variant="outline"
        onClick={onReset}
      >
        Kiểm tra người khác
      </Button>

    </SectionCard>
  );
}
