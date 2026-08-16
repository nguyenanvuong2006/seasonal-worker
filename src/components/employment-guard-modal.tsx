"use client";

import * as React from "react";
import { Badge, Button, Input, Modal, toast } from "@/components/ui";
import { formatDate, todayStr } from "@/lib/helpers";
import { AlertTriangle, Ban, CalendarClock, CheckCircle2, History, Loader2 } from "lucide-react";

/**
 * EMPLOYMENT LIFECYCLE (#7-9, #23) — modal hiện khi Recruiter cố xếp việc (APPROVED) cho ứng
 * viên còn Employment Session ACTIVE ở bộ phận khác. KHÔNG cho xếp âm thầm; các lựa chọn:
 *   A. Từ chối xếp việc (REJECTED + reason rõ — application vẫn giữ trong lịch sử)
 *   B. Yêu cầu xác nhận nghỉ (tạo task PREVIOUS_EMPLOYMENT_RESIGNATION_CONFIRMATION_REQUIRED)
 *   C. Xác nhận nghỉ & xếp việc mới (chỉ khi có employment.resignation.confirm; bắt buộc nhập
 *      Ngày nghỉ thực tế; server chạy 1 transaction đóng session cũ + mở session mới)
 *   D. Xem lịch sử làm việc.
 * Server enforce độc lập — modal chỉ là UX, không phải lớp bảo vệ duy nhất.
 */

type EmploymentContext = {
  activeSession: {
    id: string;
    deptName: string | null;
    groupName: string | null;
    startingDate: string | null;
    regDate: string;
  } | null;
  endedSessions: {
    id: string;
    deptName: string | null;
    startingDate: string | null;
    endDate: string | null;
    endReason: string | null;
  }[];
  selfDeclaration: {
    declaredResignationDate: string | null;
    declaredResignationNote: string | null;
    declaredAt: string | null;
  } | null;
  duplicateActive: boolean;
};

export default function EmploymentGuardModal({
  cccd,
  workerName,
  applicationId,
  targetDeptId,
  canConfirmResignation,
  onClose,
  onResolved,
}: {
  cccd: string;
  workerName: string;
  applicationId: string;
  targetDeptId: string | null;
  canConfirmResignation: boolean;
  onClose: () => void;
  /** Gọi sau khi một hành động đã xử lý xong (reload danh sách). */
  onResolved: () => void;
}) {
  const [context, setContext] = React.useState<EmploymentContext | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"menu" | "confirm_assign" | "history">("menu");
  const [actualResignationDate, setActualResignationDate] = React.useState("");
  const [rejectReason, setRejectReason] = React.useState("");
  const [showReject, setShowReject] = React.useState(false);

  React.useEffect(() => {
    fetch(`/api/employment/context?cccd=${cccd}`)
      .then((r) => r.json())
      .then((d) => setContext(d))
      .catch(() => setContext(null));
  }, [cccd]);

  const active = context?.activeSession ?? null;
  const declaration = context?.selfDeclaration ?? null;

  const requestConfirmation = async () => {
    if (!active) return;
    setBusy("request");
    try {
      const res = await fetch("/api/employment/resignation-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employmentSessionId: active.id,
          declaredResignationDate: declaration?.declaredResignationDate ?? null,
          note: `${workerName} đang được ghi nhận làm việc tại ${active.deptName ?? "bộ phận cũ"} nhưng đăng ký xin việc mới. Cần xác nhận nghỉ tại bộ phận cũ trước khi xếp việc mới.`,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Không tạo được yêu cầu", variant: "destructive" });
        return;
      }
      toast({ title: d.created ? "Đã tạo yêu cầu xác nhận nghỉ — theo dõi tại Task Center" : "Yêu cầu xác nhận nghỉ đã tồn tại từ trước" });
      onResolved();
      onClose();
    } finally {
      setBusy(null);
    }
  };

  const rejectAssignment = async () => {
    setBusy("reject");
    try {
      const res = await fetch(`/api/registrations/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "REJECTED",
          reason:
            rejectReason.trim() ||
            `Từ chối xếp việc — người lao động vẫn đang ACTIVE tại ${active?.deptName ?? "bộ phận cũ"}; yêu cầu NLĐ quay lại bộ phận đang làm để hoàn tất xác nhận nghỉ.`,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Không từ chối được", variant: "destructive" });
        return;
      }
      toast({ title: "Đã từ chối xếp việc (application vẫn được giữ trong lịch sử)" });
      onResolved();
      onClose();
    } finally {
      setBusy(null);
    }
  };

  const confirmAndAssign = async () => {
    if (!actualResignationDate) {
      toast({ title: "Cần nhập Ngày nghỉ thực tế", variant: "destructive" });
      return;
    }
    setBusy("confirm");
    try {
      const res = await fetch(`/api/registrations/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "APPROVED",
          ...(targetDeptId ? { deptId: targetDeptId } : {}),
          confirmPreviousResignation: true,
          actualResignationDate,
          reason: "Xác nhận nghỉ bộ phận cũ & xếp việc mới",
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Không thực hiện được", variant: "destructive" });
        return;
      }
      toast({ title: "Đã đóng đợt làm việc cũ và xếp việc mới thành công" });
      onResolved();
      onClose();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} title="CẢNH BÁO: Người lao động đang được ghi nhận đang làm việc" width="max-w-lg">
      {!context ? (
        <div className="p-6 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" /></div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-[12px] border border-danger/30 bg-danger-tint p-4 text-[13px] leading-6">
            <p className="flex items-center gap-2 font-bold text-danger">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {workerName}
            </p>
            {active ? (
              <ul className="mt-2 space-y-1 text-fg-secondary">
                <li>Bộ phận: <b className="text-fg">{active.deptName ?? "—"}{active.groupName ? ` — ${active.groupName}` : ""}</b></li>
                <li>Ngày nhận việc: <b className="text-fg">{formatDate(active.startingDate)}</b></li>
              </ul>
            ) : (
              <p className="mt-2 text-fg-secondary">Không còn tìm thấy đợt làm việc ACTIVE — có thể vừa được xử lý. Đóng và tải lại danh sách.</p>
            )}
            {context.duplicateActive && (
              <p className="mt-2 font-semibold text-danger">⚠ Dữ liệu bất thường: nhiều hơn 1 đợt làm việc ACTIVE — cần Admin đối soát trước.</p>
            )}
          </div>

          {declaration && (
            <div className="rounded-[12px] border border-warning/30 bg-warning-tint p-3 text-[13px] leading-6 text-fg-secondary">
              Người lao động khai rằng <b className="text-fg">đã báo nghỉ bộ phận này vào ngày {formatDate(declaration.declaredResignationDate)}</b> nhưng
              chưa được xác nhận trên hệ thống.
              {declaration.declaredResignationNote && <p className="mt-1 italic">Ghi chú: {declaration.declaredResignationNote}</p>}
            </div>
          )}

          {mode === "menu" && (
            <div className="space-y-2">
              <Button variant="outline" className="w-full justify-start" disabled={!!busy} onClick={requestConfirmation}>
                {busy === "request" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
                Yêu cầu xác nhận nghỉ (tạo task cho HR)
              </Button>
              <Button variant="outline" className="w-full justify-start" disabled={!!busy} onClick={() => setShowReject((v) => !v)}>
                <Ban className="h-4 w-4" /> Từ chối xếp việc
              </Button>
              {showReject && (
                <div className="space-y-2 rounded-[12px] border border-border p-3">
                  <Input
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder={`Lý do (mặc định: vẫn đang ACTIVE tại ${active?.deptName ?? "bộ phận cũ"})`}
                  />
                  <Button variant="destructive" className="w-full" disabled={!!busy} onClick={rejectAssignment}>
                    {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Xác nhận từ chối
                  </Button>
                </div>
              )}
              <Button variant="outline" className="w-full justify-start" onClick={() => setMode("history")}>
                <History className="h-4 w-4" /> Xem lịch sử làm việc ({context.endedSessions.length} đợt đã kết thúc)
              </Button>
              {canConfirmResignation && active && (
                <Button variant="primary" className="w-full justify-start" onClick={() => setMode("confirm_assign")}>
                  <CheckCircle2 className="h-4 w-4" /> Xác nhận nghỉ & xếp việc mới
                </Button>
              )}
              {!canConfirmResignation && (
                <p className="text-[12px] text-fg-muted">
                  Bạn không có quyền “Xác nhận nghỉ & xếp việc mới” — chỉ có thể Yêu cầu xác nhận nghỉ hoặc Từ chối.
                </p>
              )}
            </div>
          )}

          {mode === "confirm_assign" && (
            <div className="space-y-3 rounded-[12px] border border-border p-4">
              <p className="text-[13px] font-semibold text-fg">Ngày nghỉ thực tế tại {active?.deptName ?? "bộ phận cũ"} <span className="text-danger">*</span></p>
              <Input type="date" value={actualResignationDate} max={todayStr()} onChange={(e) => setActualResignationDate(e.target.value)} />
              <p className="text-[12px] leading-5 text-fg-muted">
                Hệ thống sẽ (1) kết thúc đợt làm việc cũ với lý do RESIGNATION, (2) ghi nhận sự kiện nghỉ việc,
                (3) mở đợt làm việc mới với ngày nhận việc = hôm nay — tất cả trong một giao dịch. Lịch sử cũ được giữ nguyên.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setMode("menu")}>← Quay lại</Button>
                <Button variant="primary" disabled={!!busy} onClick={confirmAndAssign}>
                  {busy === "confirm" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Xác nhận & xếp việc
                </Button>
              </div>
            </div>
          )}

          {mode === "history" && (
            <div className="space-y-2">
              {context.endedSessions.length === 0 ? (
                <p className="p-3 text-center text-[13px] text-fg-muted">Chưa có đợt làm việc nào đã kết thúc.</p>
              ) : (
                <ul className="max-h-[40vh] space-y-2 overflow-y-auto">
                  {context.endedSessions.map((s, idx) => (
                    <li key={s.id} className="rounded-[10px] border border-border p-3 text-[13px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-fg">LẦN {context.endedSessions.length - idx} · {s.deptName ?? "—"}</span>
                        <Badge tone="red">{s.endReason ?? "Đã nghỉ"}</Badge>
                      </div>
                      <p className="mt-1 text-fg-muted">{formatDate(s.startingDate)} → {formatDate(s.endDate)}</p>
                    </li>
                  ))}
                </ul>
              )}
              <Button variant="ghost" className="w-full" onClick={() => setMode("menu")}>← Quay lại</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
