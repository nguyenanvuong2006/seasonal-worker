"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  toast,
} from "@/components/ui";
import { formatDate } from "@/lib/helpers";
import { AlertTriangle, CalendarClock, CheckCircle2, Loader2, RefreshCw, ShieldAlert, XCircle } from "lucide-react";

/**
 * EMPLOYMENT LIFECYCLE (#12, #17, #18) — ADMIN DATA RECONCILIATION + DUYỆT ĐIỀU CHỈNH NGÀY.
 * Report-only trước, hành động từng dòng sau: KHÔNG có nút "auto-fix hàng loạt", KHÔNG DELETE
 * lịch sử. Mỗi hành động xem trước old→new và ghi audit ở server.
 */

type AuditReport = {
  generatedAt: string;
  duplicateActive: { workerId: string; cccd: string; fullName: string; activeCount: number; sessionIds: string[] }[];
  approvedAppsWithoutSession: { id: string; cccd: string; fullName: string; regDate: string; deptId: string | null }[];
  activeWithoutDept: { id: string; workerId: string; cccd: string; fullName: string; regDate: string }[];
  resignationButActive: { movementId: string; workerId: string; cccd: string; fullName: string; effectiveDate: string; sessionId: string }[];
  endedWithoutEndDate: { id: string; workerId: string; cccd: string; fullName: string; status: string; regDate: string }[];
};

type Correction = {
  id: string;
  workerName: string | null;
  workerCccd: string | null;
  deptName: string | null;
  applicationDate: string | null;
  currentStartDate: string | null;
  requestedStartDate: string;
  reason: string;
  requestedBy: string;
  requestedAt: string;
};

function SectionCard({
  title,
  description,
  count,
  children,
}: {
  title: string;
  description: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {title} <Badge tone={count > 0 ? "red" : "green"}>{count}</Badge>
          </span>
        }
        subtitle={description}
      />
      <CardContent className="p-0">
        {count === 0 ? (
          <p className="px-5 py-4 text-[13px] text-fg-muted">✓ Không phát hiện bất thường.</p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

export default function EmploymentReconciliationPage() {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [closeModal, setCloseModal] = useState<{ sessionId: string; label: string } | null>(null);
  const [closeDate, setCloseDate] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [decideModal, setDecideModal] = useState<{ correction: Correction; decision: "APPROVE" | "REJECT" } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [auditRes, corrRes] = await Promise.all([
        fetch("/api/employment/reconciliation"),
        fetch("/api/employment/start-date-corrections"),
      ]);
      if (auditRes.status === 403 || auditRes.status === 401) {
        setForbidden(true);
        return;
      }
      setReport(await auditRes.json());
      if (corrRes.ok) {
        const d = await corrRes.json();
        setCorrections(d.rows ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const closeSession = async () => {
    if (!closeModal || !closeDate) {
      toast({ title: "Cần nhập ngày nghỉ xác nhận", variant: "destructive" });
      return;
    }
    setBusyId(closeModal.sessionId);
    try {
      const res = await fetch("/api/employment/reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "CLOSE_SESSION", sessionId: closeModal.sessionId, endDate: closeDate, note: closeNote || null }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Không đóng được session", variant: "destructive" });
        return;
      }
      toast({ title: "Đã đóng Employment Session (lịch sử được giữ, có movement đối soát)" });
      setCloseModal(null);
      setCloseDate("");
      setCloseNote("");
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const decideCorrection = async () => {
    if (!decideModal) return;
    setBusyId(decideModal.correction.id);
    try {
      const res = await fetch(`/api/employment/start-date-corrections/${decideModal.correction.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: decideModal.decision, note: decisionNote || null }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Không xử lý được", variant: "destructive" });
        return;
      }
      toast({
        title:
          decideModal.decision === "APPROVE"
            ? `Đã duyệt: ${d.oldStartDate ?? "—"} → ${d.newStartDate} (audit đã lưu giá trị cũ)`
            : "Đã từ chối — ngày nhận việc gốc giữ nguyên",
      });
      setDecideModal(null);
      setDecisionNote("");
      await load();
    } finally {
      setBusyId(null);
    }
  };

  if (forbidden) {
    return (
      <Card>
        <EmptyState icon={<ShieldAlert className="h-5 w-5" />} title="Không có quyền" description="Cần quyền employment.reconcile (Admin)." />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Đối soát dữ liệu Employment"
        description="Báo cáo dữ liệu lịch sử không nhất quán + duyệt Yêu cầu điều chỉnh ngày nhận việc. Không có auto-fix: mỗi hành động do Admin quyết định từng dòng và đều được audit."
        actions={
          <Button variant="outline" onClick={() => void load()} loading={loading}>
            <RefreshCw className="h-4 w-4" /> Tải lại báo cáo
          </Button>
        }
      />

      {loading && !report ? (
        <div className="p-8 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" /></div>
      ) : (
        <>
          {/* START DATE CORRECTIONS */}
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4" /> Yêu cầu điều chỉnh ngày nhận việc <Badge tone={corrections.length ? "amber" : "green"}>{corrections.length}</Badge>
                </span>
              }
              subtitle="Recruiter không được backdate trực tiếp — mọi điều chỉnh về quá khứ phải được Admin duyệt tại đây. Giá trị cũ được giữ trong audit trail."
            />
            <CardContent className="p-0">
              {corrections.length === 0 ? (
                <p className="px-5 py-4 text-[13px] text-fg-muted">Không có yêu cầu đang chờ.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {corrections.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-sm">
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-semibold text-fg">{c.workerName ?? "—"} <span className="font-mono text-[12px] text-fg-muted">{c.workerCccd}</span></p>
                        <p className="text-[12.5px] text-fg-muted">
                          {c.deptName ?? "—"} · Ngày đăng ký {formatDate(c.applicationDate)} · Hệ thống: {formatDate(c.currentStartDate)} → Đề nghị: <b className="text-fg">{formatDate(c.requestedStartDate)}</b>
                        </p>
                        <p className="text-[12.5px] italic text-fg-secondary">Lý do: {c.reason} — bởi {c.requestedBy}, {new Date(c.requestedAt).toLocaleString("vi-VN")}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" variant="primary" disabled={busyId === c.id} onClick={() => setDecideModal({ correction: c, decision: "APPROVE" })}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Duyệt
                        </Button>
                        <Button size="sm" variant="outline" disabled={busyId === c.id} onClick={() => setDecideModal({ correction: c, decision: "REJECT" })}>
                          <XCircle className="h-3.5 w-3.5" /> Từ chối
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {report && (
            <>
              <SectionCard
                title="Worker có >1 ACTIVE Employment Session"
                description="Vi phạm invariant nghiêm trọng nhất — chọn session đúng, đóng session sai bằng nút bên dưới (có ngày nghỉ xác nhận)."
                count={report.duplicateActive.length}
              >
                <ul className="divide-y divide-border">
                  {report.duplicateActive.map((r) => (
                    <li key={r.workerId} className="space-y-1.5 px-5 py-3.5 text-sm">
                      <p className="font-semibold text-fg">
                        <AlertTriangle className="mr-1 inline h-4 w-4 text-danger" aria-hidden />
                        {r.fullName} <span className="font-mono text-[12px] text-fg-muted">{r.cccd}</span> — {r.activeCount} ACTIVE
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {r.sessionIds.map((sid) => (
                          <Button key={sid} size="sm" variant="outline" disabled={busyId === sid} onClick={() => setCloseModal({ sessionId: sid, label: `${r.fullName} · ${sid.slice(0, 8)}…` })}>
                            Đóng session {sid.slice(0, 8)}…
                          </Button>
                        ))}
                      </div>
                      <p className="text-[12px] text-fg-muted">
                        Xem chi tiết từng session tại <a className="font-semibold text-primary underline-offset-2 hover:underline" href={`/admin/worker-profiles?cccd=${r.cccd}`}>Hồ sơ Tập nghề</a> trước khi quyết định.
                      </p>
                    </li>
                  ))}
                </ul>
              </SectionCard>

              <SectionCard
                title="Daily Application đã APPROVED nhưng không có Employment Session"
                description="Application được xếp việc nhưng thiếu session — dùng “Đồng bộ dữ liệu cũ” tại Hồ sơ Tập nghề hoặc liên kết thủ công."
                count={report.approvedAppsWithoutSession.length}
              >
                <ul className="divide-y divide-border">
                  {report.approvedAppsWithoutSession.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                      <span className="text-fg">{r.fullName} <span className="font-mono text-[12px] text-fg-muted">{r.cccd}</span> · Đăng ký {formatDate(r.regDate)}</span>
                      <a className="shrink-0 text-[12px] font-semibold text-primary underline-offset-2 hover:underline" href={`/admin/worker-profiles?cccd=${r.cccd}`}>Mở hồ sơ →</a>
                    </li>
                  ))}
                </ul>
              </SectionCard>

              <SectionCard
                title="ACTIVE session thiếu Bộ phận"
                description="Session đang ACTIVE nhưng dept_id trống — cần bổ sung bộ phận hoặc đóng nếu là dữ liệu sai."
                count={report.activeWithoutDept.length}
              >
                <ul className="divide-y divide-border">
                  {report.activeWithoutDept.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                      <span className="text-fg">{r.fullName} <span className="font-mono text-[12px] text-fg-muted">{r.cccd}</span> · Đăng ký {formatDate(r.regDate)}</span>
                      <div className="flex shrink-0 gap-2">
                        <a className="text-[12px] font-semibold text-primary underline-offset-2 hover:underline" href={`/admin/worker-profiles?cccd=${r.cccd}`}>Mở hồ sơ →</a>
                        <Button size="sm" variant="outline" onClick={() => setCloseModal({ sessionId: r.id, label: `${r.fullName} · ${r.id.slice(0, 8)}…` })}>Đóng session</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </SectionCard>

              <SectionCard
                title="Có Resignation đã duyệt nhưng session vẫn ACTIVE"
                description="Movement nghỉ việc đã xác nhận nhưng employment session chưa đóng — đóng session với đúng ngày hiệu lực của movement."
                count={report.resignationButActive.length}
              >
                <ul className="divide-y divide-border">
                  {report.resignationButActive.map((r) => (
                    <li key={`${r.movementId}-${r.sessionId}`} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                      <span className="text-fg">{r.fullName} <span className="font-mono text-[12px] text-fg-muted">{r.cccd}</span> · nghỉ hiệu lực {formatDate(r.effectiveDate)}</span>
                      <Button size="sm" variant="outline" onClick={() => { setCloseModal({ sessionId: r.sessionId, label: `${r.fullName} · ${r.sessionId.slice(0, 8)}…` }); setCloseDate(r.effectiveDate); }}>
                        Đóng session theo ngày nghỉ
                      </Button>
                    </li>
                  ))}
                </ul>
              </SectionCard>

              <SectionCard
                title="Session ENDED nhưng thiếu end_date"
                description="Trạng thái kết thúc nhưng không có ngày — bổ sung ngày nghỉ xác nhận."
                count={report.endedWithoutEndDate.length}
              >
                <ul className="divide-y divide-border">
                  {report.endedWithoutEndDate.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                      <span className="text-fg">{r.fullName} <span className="font-mono text-[12px] text-fg-muted">{r.cccd}</span> · {r.status} · Đăng ký {formatDate(r.regDate)}</span>
                      <Button size="sm" variant="outline" onClick={() => setCloseModal({ sessionId: r.id, label: `${r.fullName} · ${r.id.slice(0, 8)}…` })}>Bổ sung ngày nghỉ</Button>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            </>
          )}
        </>
      )}

      {closeModal && (
        <Modal open onClose={() => { setCloseModal(null); setCloseDate(""); setCloseNote(""); }} title={`Đóng Employment Session — ${closeModal.label}`} width="max-w-md">
          <div className="space-y-3">
            <div className="rounded-[12px] border border-warning/30 bg-warning-tint p-3 text-[13px] leading-6 text-fg-secondary">
              Session sẽ được đóng (ENDED, lý do RECONCILIATION) kèm một movement đối soát để lịch sử giải thích được.
              <b className="text-fg"> Không có dữ liệu nào bị xoá.</b>
            </div>
            <div>
              <p className="mb-1 text-[13px] font-semibold text-fg">Ngày nghỉ xác nhận <span className="text-danger">*</span></p>
              <Input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-[13px] font-semibold text-fg">Ghi chú</p>
              <Input value={closeNote} onChange={(e) => setCloseNote(e.target.value)} placeholder="Căn cứ đối soát..." />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setCloseModal(null); setCloseDate(""); setCloseNote(""); }}>Hủy</Button>
              <Button variant="primary" disabled={busyId === closeModal.sessionId} onClick={closeSession}>
                {busyId === closeModal.sessionId ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Đóng session
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {decideModal && (
        <Modal
          open
          onClose={() => { setDecideModal(null); setDecisionNote(""); }}
          title={decideModal.decision === "APPROVE" ? "Duyệt điều chỉnh ngày nhận việc" : "Từ chối điều chỉnh ngày nhận việc"}
          width="max-w-md"
        >
          <div className="space-y-3">
            <div className="rounded-[12px] border border-border bg-surface-raised p-3 text-[13px] leading-6">
              <p><b className="text-fg">{decideModal.correction.workerName}</b> <span className="font-mono text-[12px] text-fg-muted">{decideModal.correction.workerCccd}</span></p>
              <p className="text-fg-secondary">Bộ phận: {decideModal.correction.deptName ?? "—"}</p>
              <p className="text-fg-secondary">Ngày hệ thống: <b className="text-fg">{formatDate(decideModal.correction.currentStartDate)}</b> → Đề nghị: <b className="text-fg">{formatDate(decideModal.correction.requestedStartDate)}</b></p>
              <p className="text-fg-secondary">Lý do: {decideModal.correction.reason}</p>
              {decideModal.decision === "APPROVE" ? (
                <p className="mt-2 text-success">Duyệt sẽ cập nhật ngày nhận việc theo transaction an toàn — giá trị cũ được lưu trong audit trail.</p>
              ) : (
                <p className="mt-2 text-danger">Từ chối — ngày nhận việc gốc giữ nguyên.</p>
              )}
            </div>
            <Input value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} placeholder="Ghi chú quyết định (không bắt buộc)" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setDecideModal(null); setDecisionNote(""); }}>Hủy</Button>
              <Button
                variant={decideModal.decision === "APPROVE" ? "primary" : "destructive"}
                disabled={busyId === decideModal.correction.id}
                onClick={decideCorrection}
              >
                {busyId === decideModal.correction.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {decideModal.decision === "APPROVE" ? "Xác nhận duyệt" : "Xác nhận từ chối"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
