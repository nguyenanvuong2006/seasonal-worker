"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Badge, Breadcrumb, Button, Card, CardContent, CardHeader, EmptyState, ErrorState, FormField, Input, SkeletonCard, toast } from "@/components/ui";
import { ArrowLeftRight, Fingerprint, LogOut, ShieldCheck, UserX } from "lucide-react";
import { formatDeadline } from "@/lib/candidate-consent/confirmation-deadline";

const CONFIRMATION_STATUS_LABEL: Record<string, string> = {
  GENERATING: "ĐANG TẠO",
  READY: "SẴN SÀNG",
  ISSUED: "ĐÃ PHÁT HÀNH",
  VIEWED: "ĐÃ XEM",
  CONFIRMED: "ĐÃ XÁC NHẬN",
  REVOKED: "ĐÃ THU HỒI",
  SUPERSEDED: "ĐÃ THAY THẾ",
  EXPIRED: "HẾT HẠN",
  FAILED: "LỖI",
};

type ConfirmationHistoryEntry = {
  documentId: string;
  applicationId: string;
  employmentSessionId: string | null;
  engagementStartingDate: string | null;
  templateVersion: number | null;
  templateName: string | null;
  documentKind: string | null;
  status: string;
  effectiveStatus: string;
  issuedAt: string | null;
  confirmationDeadlineAt: string | null;
  viewedAt: string | null;
  confirmedAt: string | null;
  receiptId: string | null;
  supersedesDocumentId: string | null;
};

type EngagementMovement = {
  id: string;
  movementType: "resignation" | "transfer";
  fromDeptId: string | null;
  fromDeptName: string | null;
  toDeptId: string | null;
  toDeptName: string | null;
  requestedAt: string;
  effectiveDate: string;
  status: string;
  reason: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  lifecycleAppliedAt: string | null;
};

type Engagement = {
  session: {
    id: string;
    regDate: string;
    status: string;
    startingDate: string | null;
    endDate: string | null;
    endReason: string | null;
    endedBy: string | null;
    startDateSource: string | null;
    dailyApplicationId: string | null;
    note: string | null;
    itCode: string | null;
  };
  organization: { deptId: string | null; deptName: string | null; groupName: string | null; section: string | null };
  isCurrent: boolean;
  movements: EngagementMovement[];
  electronicDocuments: ConfirmationHistoryEntry[];
};

type WorkerCurrentState = {
  lifecycleState: "ACTIVE" | "INACTIVE";
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  section: string | null;
  startingDate: string | null;
  upcoming: { type: "resignation" | "transfer"; effectiveDate: string; toDeptName: string | null } | null;
};

type Profile = {
  person: { workerId: string; fullName: string; fingerprintStatus: string | null; hasFingerprintCode: boolean };
  currentState: WorkerCurrentState;
  engagements: Engagement[];
  legacyUnlinkedDocuments: ConfirmationHistoryEntry[];
  unlinkedMovements: EngagementMovement[];
};

type HistoryFilter = "ALL" | "CONFIRMATION" | "RESIGNATION" | "TRANSFER";

const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: "ALL", label: "Tất cả" },
  { key: "CONFIRMATION", label: "Hồ sơ xác nhận" },
  { key: "RESIGNATION", label: "Nghỉ việc" },
  { key: "TRANSFER", label: "Thuyên chuyển" },
];

/**
 * Groups a flat document list into version chains (via supersedesDocumentId):
 * chain[0] is the current/effective document (nothing else in this list
 * supersedes it), followed by the older versions it replaced, oldest last.
 * Never used to infer engagement membership — that is decided entirely by
 * employmentSessionId before this function ever runs.
 */
function groupVersionChains(docs: ConfirmationHistoryEntry[]): ConfirmationHistoryEntry[][] {
  const byId = new Map(docs.map((d) => [d.documentId, d]));
  const supersededIds = new Set(docs.filter((d) => d.supersedesDocumentId).map((d) => d.supersedesDocumentId!));
  const heads = docs.filter((d) => !supersededIds.has(d.documentId));
  return heads.map((head) => {
    const chain = [head];
    let cursor = head;
    while (cursor.supersedesDocumentId && byId.has(cursor.supersedesDocumentId)) {
      const prev = byId.get(cursor.supersedesDocumentId)!;
      chain.push(prev);
      cursor = prev;
    }
    return chain;
  });
}

function EngagementCard({ engagement, index, filter }: { engagement: Engagement; index: number; filter: HistoryFilter }) {
  const { session: s, organization: org, movements, electronicDocuments } = engagement;
  const days = s.startingDate ? Math.max(0, Math.round((Date.parse(s.endDate ?? new Date().toISOString().slice(0, 10)) - Date.parse(s.startingDate)) / 86400000)) : null;
  const showConfirmation = filter === "ALL" || filter === "CONFIRMATION";
  const showResignation = filter === "ALL" || filter === "RESIGNATION";
  const showTransfer = filter === "ALL" || filter === "TRANSFER";
  const chains = groupVersionChains(electronicDocuments);

  return (
    <Card className="p-0">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[11px] font-bold text-fg-secondary">LẦN {index}</span>
          <span className="font-semibold text-fg">
            {org.deptName ?? "Chưa xếp bộ phận"}
            {org.groupName ? ` — ${org.groupName}` : ""}
          </span>
          {org.section && <span className="text-[12px] text-fg-muted">Section: {org.section}</span>}
          {engagement.isCurrent ? (
            <Badge tone="green" dot>
              Đang làm việc
            </Badge>
          ) : s.endDate || s.status === "ENDED" ? (
            <Badge tone="red">Đã kết thúc</Badge>
          ) : (
            <Badge tone="gray">{s.status}</Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-fg-muted">
          <span>Đăng ký: {s.regDate}</span>
          {s.startingDate && (
            <span>
              Nhận việc: {s.startingDate}
              {s.startDateSource === "CORRECTION" ? " (đã điều chỉnh)" : ""}
            </span>
          )}
          <span>{s.endDate ? `Kết thúc: ${s.endDate}` : "→ Hiện tại"}</span>
          {days !== null && <span>Thời gian: {days} ngày</span>}
          {s.endReason && <span>Lý do: {s.endReason}</span>}
          <span>IT Code: {s.itCode ?? "—"}</span>
        </div>
        {s.note && <p className="text-[12px] italic text-fg-secondary">{s.note}</p>}

        {showResignation &&
          movements
            .filter((m) => m.movementType === "resignation")
            .map((m) => (
              <div key={m.id} className="rounded-lg border border-red-200 bg-red-50 p-3 text-[12.5px]">
                <p className="flex items-center gap-1.5 font-semibold text-red-700">
                  <LogOut className="h-3.5 w-3.5" /> NGHỈ VIỆC
                </p>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-fg-secondary">
                  <span>Ngày yêu cầu: {new Date(m.requestedAt).toLocaleDateString("vi-VN")}</span>
                  <span>Ngày hiệu lực: {m.effectiveDate}</span>
                  <span>Trạng thái: {m.lifecycleAppliedAt ? "ĐÃ HIỆU LỰC" : m.status}</span>
                  {m.confirmedBy && <span>HR duyệt: {m.confirmedBy}</span>}
                  {m.confirmedAt && <span>Ngày duyệt: {new Date(m.confirmedAt).toLocaleDateString("vi-VN")}</span>}
                  {m.lifecycleAppliedAt && <span>Ngày áp dụng: {new Date(m.lifecycleAppliedAt).toLocaleDateString("vi-VN")}</span>}
                  {m.reason && <span>Lý do: {m.reason}</span>}
                </div>
              </div>
            ))}

        {showTransfer &&
          movements
            .filter((m) => m.movementType === "transfer")
            .map((m) => (
              <div key={m.id} className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-[12.5px]">
                <p className="flex items-center gap-1.5 font-semibold text-blue-700">
                  <ArrowLeftRight className="h-3.5 w-3.5" /> THUYÊN CHUYỂN — {m.effectiveDate}
                </p>
                <p className="mt-1 text-fg-secondary">
                  {m.fromDeptName ?? "(ngoài phạm vi)"} → {m.toDeptName ?? "—"}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-fg-secondary">
                  <span>Ngày yêu cầu: {new Date(m.requestedAt).toLocaleDateString("vi-VN")}</span>
                  <span>Trạng thái: {m.lifecycleAppliedAt ? "ĐÃ HIỆU LỰC" : m.status}</span>
                  {m.confirmedAt && <span>Ngày duyệt: {new Date(m.confirmedAt).toLocaleDateString("vi-VN")}</span>}
                  {m.lifecycleAppliedAt && <span>Ngày áp dụng: {new Date(m.lifecycleAppliedAt).toLocaleDateString("vi-VN")}</span>}
                </div>
              </div>
            ))}

        {showConfirmation &&
          chains.map((chain) => {
            const current = chain[0];
            const older = chain.slice(1);
            return (
              <div key={current.documentId} className="rounded-lg border border-border p-3 text-[12.5px]">
                <p className="flex items-center gap-1.5 font-semibold text-fg">
                  <ShieldCheck className="h-3.5 w-3.5" /> HỒ SƠ XÁC NHẬN ĐIỆN TỬ
                </p>
                <ConfirmationDocRow doc={current} />
                {older.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11.5px] font-semibold text-accent">Lịch sử phiên bản ({older.length})</summary>
                    <div className="mt-2 space-y-2 border-t border-border pt-2">
                      {older.map((d) => (
                        <ConfirmationDocRow key={d.documentId} doc={d} compact />
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
      </CardContent>
    </Card>
  );
}

function ConfirmationDocRow({ doc, compact }: { doc: ConfirmationHistoryEntry; compact?: boolean }) {
  return (
    <div className={compact ? "text-[11.5px]" : "mt-1.5 text-[12.5px]"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg-secondary">
          {doc.templateName ?? "Mẫu"}
          {doc.templateVersion !== null ? ` v${doc.templateVersion}` : ""}
        </span>
        <Badge tone={doc.effectiveStatus === "CONFIRMED" ? "green" : doc.effectiveStatus === "EXPIRED" ? "gray" : doc.effectiveStatus === "REVOKED" || doc.effectiveStatus === "FAILED" ? "red" : "amber"}>
          {CONFIRMATION_STATUS_LABEL[doc.effectiveStatus] ?? doc.effectiveStatus}
        </Badge>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-fg-muted">
        <span>Phát hành: {doc.issuedAt ? new Date(doc.issuedAt).toLocaleString("vi-VN") : "—"}</span>
        {doc.confirmationDeadlineAt && <span>Hạn xác nhận: {formatDeadline(doc.confirmationDeadlineAt)}</span>}
        {doc.viewedAt && <span>Đã xem: {new Date(doc.viewedAt).toLocaleString("vi-VN")}</span>}
        {doc.confirmedAt && <span>Xác nhận: {new Date(doc.confirmedAt).toLocaleString("vi-VN")}</span>}
      </div>
      <div className="mt-1 flex flex-wrap gap-3">
        <a href={`/api/document-merge/candidate-documents/${doc.documentId}/pdf?mode=view`} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline">
          Xem PDF
        </a>
        <a href={`/api/document-merge/candidate-documents/${doc.documentId}/pdf?mode=download`} className="font-semibold text-accent hover:underline">
          Tải PDF
        </a>
        {doc.receiptId && (
          <>
            <a href={`/xac-thuc-ho-so/${encodeURIComponent(doc.receiptId)}/bien-nhan`} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline">
              Biên nhận
            </a>
            <a href={`/xac-thuc-ho-so/${encodeURIComponent(doc.receiptId)}`} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline">
              Xác thực
            </a>
          </>
        )}
      </div>
    </div>
  );
}

export default function Worker360ProfilePage() {
  const params = useParams<{ workerId: string }>();
  const workerId = params.workerId;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>("ALL");
  const [fp, setFp] = useState({ fingerprintCode: "", fingerprintDevice: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await fetch(`/api/worker-profiles/by-id/${workerId}`, { cache: "no-store" });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        setError("Không tải được hồ sơ. Vui lòng thử lại.");
        return;
      }
      const data = await res.json();
      setProfile(data.profile);
    } catch {
      setError("Không tải được hồ sơ. Vui lòng thử lại.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (workerId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId]);

  const saveFingerprint = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/worker-profiles/by-id/${workerId}/fingerprint`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fp, fingerprintStatus: fp.fingerprintCode ? "DA_CAP" : "CHUA_CAP" }),
      });
      if (!res.ok) {
        toast({ title: "Lưu thất bại", variant: "destructive" });
        return;
      }
      toast({ title: "Đã cập nhật mã vân tay" });
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (notFound) {
    return (
      <Card>
        <EmptyState icon={<UserX className="h-5 w-5" aria-hidden />} title="Không tìm thấy hồ sơ" description="Hồ sơ không tồn tại, hoặc nằm ngoài phạm vi dữ liệu được cấp cho bạn." />
      </Card>
    );
  }

  if (error || !profile) {
    return <ErrorState title="Lỗi tải hồ sơ" description={error ?? "Đã có lỗi xảy ra."} onRetry={load} />;
  }

  const cs = profile.currentState;
  const reversedEngagements = [...profile.engagements].reverse(); // oldest-first order for LẦN numbering...
  const numberByEngagementId = new Map(reversedEngagements.map((e, i) => [e.session.id, i + 1]));

  return (
    <div className="space-y-5">
      <Breadcrumb items={[{ label: "Hồ sơ Tập nghề", href: "/admin/worker-profiles" }, { label: profile.person.fullName }]} />

      <Card>
        <CardHeader title={profile.person.fullName} />
        <CardContent className="grid gap-x-6 gap-y-1.5 text-sm text-fg-secondary sm:grid-cols-2">
          <p>
            Trạng thái:{" "}
            <span className="text-fg">
              <Badge tone={cs.lifecycleState === "ACTIVE" ? "green" : "gray"} dot>
                {cs.lifecycleState === "ACTIVE" ? "ĐANG LÀM VIỆC" : "KHÔNG HOẠT ĐỘNG"}
              </Badge>
            </span>
          </p>
          <p>
            Bộ phận hiện tại: <span className="text-fg">{cs.deptName ?? "—"}</span>
          </p>
          <p>
            Ngày bắt đầu gần nhất: <span className="text-fg">{cs.startingDate ?? "—"}</span>
          </p>
          <p>
            Mã vân tay:{" "}
            <span className="text-fg">
              <Badge tone={profile.person.hasFingerprintCode ? "green" : "amber"}>{profile.person.hasFingerprintCode ? "Đã có" : "Chưa có"}</Badge>
            </span>
          </p>
          {cs.upcoming && (
            <p className="sm:col-span-2 text-amber-700">
              {cs.upcoming.type === "resignation" ? "Sắp nghỉ" : "Sắp chuyển"}: {cs.upcoming.effectiveDate}
              {cs.upcoming.toDeptName ? ` → ${cs.upcoming.toDeptName}` : ""}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Fingerprint className="h-4 w-4" /> Biometric — Mã vân tay
            </span>
          }
        />
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <FormField label="Mã vân tay">
            <Input value={fp.fingerprintCode} onChange={(e) => setFp({ ...fp, fingerprintCode: e.target.value })} />
          </FormField>
          <FormField label="Thiết bị">
            <Input value={fp.fingerprintDevice} onChange={(e) => setFp({ ...fp, fingerprintDevice: e.target.value })} />
          </FormField>
          <div className="flex items-end">
            <Button variant="primary" onClick={saveFingerprint} loading={saving} className="h-10 w-full">
              Lưu
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-[12.5px] font-semibold ${filter === f.key ? "bg-accent text-white" : "bg-surface-hover text-fg-secondary hover:bg-border"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-bold text-fg">Lịch sử làm việc — {profile.engagements.length} đợt</h2>
        {profile.engagements.length === 0 ? (
          <Card>
            <EmptyState title="Chưa có lịch sử làm việc" description="Người này chưa có đợt làm việc nào được ghi nhận." />
          </Card>
        ) : (
          <div className="space-y-3">
            {profile.engagements.map((e) => (
              <EngagementCard key={e.session.id} engagement={e} index={numberByEngagementId.get(e.session.id)!} filter={filter} />
            ))}
          </div>
        )}
      </div>

      {profile.unlinkedMovements.length > 0 && (filter === "ALL" || filter === "RESIGNATION" || filter === "TRANSFER") && (
        <Card>
          <CardHeader title="Sự kiện chưa xác định lần làm việc" subtitle="Các bản ghi nghỉ việc/thuyên chuyển cũ chưa liên kết được với một đợt làm việc cụ thể — không suy đoán, chỉ hiển thị riêng." />
          <CardContent className="space-y-2">
            {profile.unlinkedMovements.map((m) => (
              <p key={m.id} className="text-[12.5px] text-fg-secondary">
                {m.movementType === "resignation" ? "Nghỉ việc" : "Thuyên chuyển"} — {m.effectiveDate}
                {m.movementType === "transfer" && ` (${m.fromDeptName ?? "—"} → ${m.toDeptName ?? "—"})`}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {profile.legacyUnlinkedDocuments.length > 0 && (filter === "ALL" || filter === "CONFIRMATION") && (
        <Card>
          <CardHeader title="Hồ sơ cũ chưa xác định lần làm việc" subtitle="Hồ sơ xác nhận điện tử không liên kết được với một đợt làm việc cụ thể (dữ liệu cũ) — không gán bừa vào đợt gần nhất." />
          <CardContent className="space-y-2">
            {profile.legacyUnlinkedDocuments.map((d) => (
              <div key={d.documentId} className="rounded-lg border border-border p-3">
                <ConfirmationDocRow doc={d} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
