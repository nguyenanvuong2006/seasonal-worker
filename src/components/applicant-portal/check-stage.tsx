"use client";

import { Loader2, Sparkles } from "lucide-react";
import { Button, Input, Label } from "@/components/ui";
import { CccdQrScanner, type CccdQrData } from "@/components/cccd-qr-scanner";
import FormHeader from "./form-header";
import SectionCard from "./section-card";

interface CheckStageProps {
  cccd: string;
  phone: string;
  loading: boolean;
  setCccd: (value: string) => void;
  setPhone: (value: string) => void;
  onCheck: () => void;
  onQrScanned: (data: CccdQrData) => void;
}

export default function CheckStage({
  cccd,
  phone,
  loading,
  setCccd,
  setPhone,
  onCheck,
  onQrScanned,
}: CheckStageProps) {
  return (
    <SectionCard>
      <FormHeader
        icon={<Sparkles className="h-5 w-5" />}
        badge="BƯỚC 1 / 2"
        title="Xác thực thông tin"
        description="Nhập số CCCD và số điện thoại để hệ thống kiểm tra bạn là lao động mới hay lao động đã từng làm việc."
      />

      <div className="space-y-6">

        <div>
          <Label>Số CCCD / CMND *</Label>

          <div className="mt-2 flex gap-3">

            <Input
              value={cccd}
              type="tel"
              inputMode="numeric"
              maxLength={12}
              className="h-14 flex-1"
              placeholder="Nhập số CCCD"
              onChange={(e) =>
                setCccd(e.target.value.replace(/\D/g, ""))
              }
            />

            <CccdQrScanner onResult={onQrScanned} />

          </div>

        </div>

        <div>

          <Label>Số điện thoại *</Label>

          <Input
            value={phone}
            type="tel"
            inputMode="numeric"
            maxLength={11}
            className="mt-2 h-14"
            placeholder="090..."
            onChange={(e) =>
              setPhone(e.target.value.replace(/\D/g, ""))
            }
          />

        </div>

        <Button
          onClick={onCheck}
          disabled={loading}
          variant="gold"
          size="xl"
          className="w-full"
        >
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            "Tiếp tục kiểm tra"
          )}
        </Button>

      </div>
    </SectionCard>
  );
}
