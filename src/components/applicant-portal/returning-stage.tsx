"use client";

import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui";
import FormHeader from "./form-header";
import SectionCard from "./section-card";
import type { WorkerInfo } from "./types";

interface Props {
  worker: WorkerInfo | null;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ReturningStage({
  worker,
  loading,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <SectionCard>

      <FormHeader
        icon={<ShieldCheck className="h-5 w-5" />}
        badge="LAO ĐỘNG ĐÃ XÁC MINH"
        title={worker?.full_name ?? ""}
        description="Thông tin của bạn đã tồn tại trong hệ thống."
      />

      <div className="rounded-2xl border bg-slate-50 p-5">

        <p className="text-xs uppercase tracking-wider text-slate-500">
          Địa chỉ
        </p>

        <p className="mt-2 font-semibold">
          {worker?.address_current || "Chưa cập nhật"}
        </p>

      </div>

      <div className="mt-6 space-y-3">

        <Button
          variant="gold"
          size="xl"
          disabled={loading}
          className="w-full"
          onClick={onConfirm}
        >
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            "Xác nhận đăng ký"
          )}
        </Button>

        <Button
          variant="ghost"
          className="w-full"
          onClick={onCancel}
        >
          Quay lại
        </Button>

      </div>

    </SectionCard>
  );
}
