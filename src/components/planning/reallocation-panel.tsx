"use client";

/* ============================================================
   CHUYỂN PHÂN BỔ DW SANG YÊU CẦU MỚI (Yêu cầu #7, #8, #9)
   ------------------------------------------------------------
   Recruiter tick một/nhiều DW của yêu cầu cũ (đã hết hạn hoặc
   không còn hiệu lực), chọn yêu cầu mới, bấm "Chuyển phân bổ".

   HỆ QUẢ NGHIỆP VỤ — nhắc rõ ngay trên giao diện:
     • DW VẪN ĐANG LÀM VIỆC. Không ai bị ghi nhận nghỉ việc.
     • Không tạo Workforce Movement RESIGNATION, không ghi quit date.
     • Phân bổ cũ được ĐÓNG LẠI (giữ nguyên lịch sử), phân bổ mới
       trỏ ngược về bản cũ qua previous_allocation_id.
   ============================================================ */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckSquare, Info, Loader2, Shuffle, Square, Users } from "lucide-react";
import { Badge, Button, EmptyState, Modal, cn, toast } from "@/components/ui";

type AllocationRow = {
  allocationId: string;
  employmentSessionId: string;
  workerId: string | null;
  workerName: string | null;
  workerCccd: string | null;
  gender: string | null;
  deptId: string | null;
  allocationStartDate: string | null;
};

type TargetRow = {
  id: string;
  requestCode: string;
  department: string | null;
  section: string | null;
  groupName: string | null;
  expectedDate: string | null;
  endDate: string | null;
  totalBalance: number;
  status: string;
};

function formatDate(d?: string | null) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

export function ReallocationPanel({
  open,
  fromRequestId,
  fromRequestCode,
  onClose,
  onDone,
}: {
  open: boolean;
  fromRequestId: string | null;
  fromRequestCode: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [allocations, setAllocations] = useState<AllocationRow[]>([]);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [toRequestId, setToRequestId] = useState("");

  const load = useCallback(async () => {
    if (!fromRequestId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/planning/reallocate?requestId=${encodeURIComponent(fromRequestId)}`);
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Không tải được danh sách DW.", variant: "destructive" });
        setAllocations([]);
        setTargets([]);
        return;
      }
      setAllocations(data.allocations ?? []);
      setTargets(data.targets ?? []);
      setChecked({});
      setToRequestId("");
    } catch {
      toast({ title: "Lỗi kết nối.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [fromRequestId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const selectedIds = useMemo(() => Object.keys(checked).filter((k) => checked[k]), [checked]);
  const allSelected = allocations.length > 0 && selectedIds.length === allocations.length;

  const counts = useMemo(() => {
    let male = 0;
    let female = 0;
    for (const a of allocations) {
      const g = (a.gender ?? "").trim().toLowerCase();
      if (g.startsWith("f") || g.startsWith("n\u1eef") || g === "nu") female += 1;
      else if (g.startsWith("m") || g === "nam") male += 1;
    }
    return { male, female, total: allocations.length };
  }, [allocations]);

  const toggleAll = () => {
    if (allSelected) {
      setChecked({});
      return;
    }
    const next: Record<string, boolean> = {};
    allocations.forEach((a) => {
      next[a.allocationId] = true;
    });
    setChecked(next);
  };

  const submit = async () => {
    if (!fromRequestId) return;
    if (selectedIds.length === 0) {
      toast({ title: "Chưa chọn DW nào để chuyển.", variant: "destructive" });
      return;
    }
    if (!toRequestId) {
      toast({ title: "Chưa chọn yêu cầu đích.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/planning/reallocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromRequestId, toRequestId, allocationIds: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Chuyển phân bổ thất bại.", variant: "destructive" });
        return;
      }
      toast({ title: data.message ?? `Đã chuyển ${data.moved} DW.` });
      onDone();
      onClose();
    } catch {
      toast({ title: "Lỗi kết nối.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Chuyển phân bổ DW — từ yêu cầu ${fromRequestCode ?? ""}`}
      description="Chọn những DW cần chuyển sang yêu cầu tuyển dụng còn hiệu lực. Thao tác chạy trong một transaction và giữ nguyên lịch sử phân bổ cũ."
      width="max-w-4xl"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-[11.5px] text-fg-muted">
            Đã chọn <strong className="text-fg">{selectedIds.length}</strong>/{allocations.length} DW
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Huỷ
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={submit}
              loading={submitting}
              disabled={selectedIds.length === 0 || !toRequestId}
            >
              <Shuffle className="h-3.5 w-3.5" /> Chuyển phân bổ sang yêu cầu mới
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Cảnh báo nghiệp vụ — Yêu cầu #9 */}
        <div className="flex gap-2 rounded-[10px] border border-accent/30 bg-accent-tint/25 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div className="text-[11.5px] leading-relaxed text-fg">
            <p className="font-semibold">Yêu cầu hết hạn KHÔNG có nghĩa là DW nghỉ việc.</p>
            <p className="mt-0.5 text-fg-muted">
              Thao tác này chỉ đổi liên kết nhu cầu: phân bổ cũ được đóng lại (vẫn tra cứu được), phân bổ mới được tạo trên
              yêu cầu đích. Hệ thống KHÔNG tạo Workforce Movement RESIGNATION, KHÔNG ghi ngày nghỉ, KHÔNG đánh dấu DW ngừng
              hoạt động. Chỉ Workforce Movement RESIGNATION mới là nghỉ việc thật.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Đang tải danh sách DW...
          </div>
        ) : allocations.length === 0 ? (
          <EmptyState
            icon={<Users className="h-5 w-5" />}
            title="Yêu cầu này không còn DW nào đang được phân bổ"
            description="Không cần chuyển phân bổ. Task tương ứng trong Task Center sẽ tự đóng."
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="blue" dot>
                Tổng {counts.total}
              </Badge>
              <Badge tone="gray">Nam {counts.male}</Badge>
              <Badge tone="gray">Nữ {counts.female}</Badge>
            </div>

            {/* Yêu cầu đích */}
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-fg-muted">
                Yêu cầu đích (còn hiệu lực, trong Data Scope của bạn)
              </span>
              <select
                value={toRequestId}
                onChange={(e) => setToRequestId(e.target.value)}
                className="h-9 w-full rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent"
              >
                <option value="">— Chọn yêu cầu mới —</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.requestCode} · {[t.department, t.section, t.groupName].filter(Boolean).join(" / ") || "—"} · cần{" "}
                    {formatDate(t.expectedDate)} · còn thiếu {t.totalBalance}
                  </option>
                ))}
              </select>
              {targets.length === 0 && (
                <span className="mt-1 block text-[11px] text-warning">
                  Không có yêu cầu nào còn hiệu lực trong phạm vi dữ liệu của bạn. Hãy tạo yêu cầu mới trước.
                </span>
              )}
            </label>

            {/* Danh sách DW */}
            <div className="max-h-72 overflow-auto rounded-[10px] border border-border">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 z-10 bg-primary-tint">
                  <tr>
                    <th className="w-10 px-2 py-2 text-center">
                      <button type="button" onClick={toggleAll} aria-label="Chọn tất cả DW" className="mx-auto">
                        {allSelected ? (
                          <CheckSquare className="h-4 w-4 text-primary" />
                        ) : (
                          <Square className="h-4 w-4 text-fg-muted" />
                        )}
                      </button>
                    </th>
                    <th className="px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-primary">Họ tên</th>
                    <th className="px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-primary">CCCD</th>
                    <th className="px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wider text-primary">Giới tính</th>
                    <th className="px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wider text-primary">Phân bổ từ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {allocations.map((a) => (
                    <tr
                      key={a.allocationId}
                      className={cn("bg-surface transition-colors", checked[a.allocationId] && "bg-accent-tint/30")}
                    >
                      <td className="px-2 py-1.5 text-center">
                        <button
                          type="button"
                          aria-label={`Chọn ${a.workerName ?? a.allocationId}`}
                          onClick={() => setChecked((prev) => ({ ...prev, [a.allocationId]: !prev[a.allocationId] }))}
                        >
                          {checked[a.allocationId] ? (
                            <CheckSquare className="h-4 w-4 text-primary" />
                          ) : (
                            <Square className="h-4 w-4 text-fg-muted" />
                          )}
                        </button>
                      </td>
                      <td className="px-2 py-1.5 font-medium text-fg">{a.workerName ?? "—"}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-fg-muted">{a.workerCccd ?? "—"}</td>
                      <td className="px-2 py-1.5 text-center text-fg">{a.gender ?? "—"}</td>
                      <td className="px-2 py-1.5 text-center text-[11px] text-fg-muted">
                        {formatDate(a.allocationStartDate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
