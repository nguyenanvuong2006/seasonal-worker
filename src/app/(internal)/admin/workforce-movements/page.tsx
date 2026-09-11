"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  FormField,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  cn,
  toast,
} from "@/components/ui";
import { ArrowLeftRight, Check, Clock, Search, X, type LucideIcon } from "lucide-react";
import { CCCD_ERROR_MESSAGE, isValidCccd } from "@/lib/validators";

type Movement = {
  id: string;
  movementType: "resignation" | "transfer";
  workerId: string;
  workerName: string | null;
  workerCccd: string | null;
  fromDeptId: string | null;
  toDeptId: string | null;
  effectiveDate: string;
  reason: string | null;
  note: string | null;
  status: string;
  relatedMovementId: string | null;
  requestedBy: string;
  createdAt: string;
};
type Dept = { id: string; deptName: string; groupName: string | null };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Stage = { stageKey: string; label: string; color: string };

const STATUS_ACTIONS: Record<string, { action: string; label: string; tone: "green" | "red" | "amber" | "gray"; icon: LucideIcon }[]> = {
  resignation_PENDING_HR: [
    { action: "APPROVE_RESIGNATION", label: "Duyệt nghỉ việc", tone: "green", icon: Check },
    { action: "REJECT", label: "Từ chối", tone: "red", icon: X },
  ],
  transfer_PENDING_HR: [
    { action: "CONFIRM_ARRIVED", label: "Đã nhận việc", tone: "green", icon: Check },
    { action: "RESCHEDULE", label: "Hoãn", tone: "amber", icon: Clock },
    { action: "NOT_ARRIVED", label: "Không đến", tone: "amber", icon: X },
    { action: "REJECT", label: "Từ chối", tone: "red", icon: X },
  ],
  transfer_TRANSFER_RESCHEDULED: [
    { action: "CONFIRM_ARRIVED", label: "Đã nhận việc", tone: "green", icon: Check },
    { action: "RESCHEDULE", label: "Hoãn tiếp", tone: "amber", icon: Clock },
    { action: "NOT_ARRIVED", label: "Không đến", tone: "amber", icon: X },
    { action: "REJECT", label: "Từ chối", tone: "red", icon: X },
  ],
  transfer_WAITING_DECISION: [
    { action: "CANCEL", label: "Huỷ thuyên chuyển", tone: "gray", icon: X },
    { action: "SPAWN_RESIGNATION", label: "Sinh yêu cầu nghỉ việc", tone: "red", icon: ArrowLeftRight },
  ],
};

const ACTION_TONE_CLASS: Record<string, string> = {
  green: "bg-success-tint text-success hover:bg-success/20",
  red: "bg-danger-tint text-danger hover:bg-danger/20",
  amber: "bg-warning-tint text-warning hover:bg-warning/20",
  gray: "bg-surface-hover text-fg-secondary hover:bg-border",
};

// BULK APPROVAL — eligibility is derived from the SAME lookup the single-row action buttons
// already use (STATUS_ACTIONS[`${movementType}_${status}`]), never from any display text. A
// row is bulk-selectable iff it currently exposes the canonical APPROVE_RESIGNATION action
// (resignation, status="PENDING_HR") OR the canonical CONFIRM_ARRIVED action (transfer,
// status="PENDING_HR" or "TRANSFER_RESCHEDULED" — final-project-hardening: bulk transfer
// arrival confirmation, same pattern as bulk resignation, see bulk-approve-transfer/route.ts).
function isEligibleForBulkApproval(m: Movement): boolean {
  return (STATUS_ACTIONS[`${m.movementType}_${m.status}`] ?? []).some(
    (a) => a.action === "APPROVE_RESIGNATION" || a.action === "CONFIRM_ARRIVED",
  );
}

type BulkResultItem = { id: string; outcome: "APPROVED" | "ALREADY_APPROVED" | "NO_LONGER_ELIGIBLE" | "OUT_OF_SCOPE" | "FAILED"; reason?: string };
type BulkResult = {
  bulkOperationId: string;
  requested: number;
  approved: number;
  alreadyApproved: number;
  outOfScope: number;
  noLongerEligible: number;
  failed: number;
  results: BulkResultItem[];
};

const BULK_OUTCOME_LABEL: Record<string, string> = {
  ALREADY_APPROVED: "Đã được duyệt trước đó (bởi thao tác khác)",
  OUT_OF_SCOPE: "Ngoài phạm vi Data Scope",
  NO_LONGER_ELIGIBLE: "Không còn ở trạng thái chờ duyệt",
  FAILED: "Lỗi xử lý",
};

function MovementListSkeleton() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-4">
          <Skeleton className="h-5 w-20 rounded-full" />
          <div className="min-w-[160px] space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function WorkforceMovementsPage() {
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlight");
  const [rows, setRows] = useState<Movement[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<{ movement: Movement; action: string } | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [bulkResultLabels, setBulkResultLabels] = useState<Map<string, string>>(new Map());
  const [bulkResultDetailOpen, setBulkResultDetailOpen] = useState(false);

  const [cccdSearch, setCccdSearch] = useState("");
  const [foundWorker, setFoundWorker] = useState<{ id: string; fullName: string; cccd: string; currentDeptId: string | null } | null>(null);
  const [form, setForm] = useState({ movementType: "resignation" as "resignation" | "transfer", toDeptId: "", effectiveDate: "", reason: "", note: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [movRes, deptRes] = await Promise.all([fetch("/api/workforce-movements"), fetch("/api/departments?scope=all")]);
      if (!movRes.ok || !deptRes.ok) {
        const failed = !movRes.ok ? movRes : deptRes;
        const data = await failed.json().catch(() => ({}));
        toast({ title: data.error ?? "Không tải được danh sách yêu cầu.", variant: "destructive" });
        return;
      }
      const movData = await movRes.json();
      const deptData = await deptRes.json();
      const freshRows: Movement[] = movData.rows ?? [];
      setRows(freshRows);
      setDepts(deptData.rows ?? []);
      // A selection must never keep pointing at a row that is no longer eligible after a
      // refresh (approved by someone else in the meantime, rejected, etc.) — prune it against
      // the freshly loaded canonical eligibility, same rule as isEligibleForBulkApproval.
      const stillEligible = new Set(freshRows.filter(isEligibleForBulkApproval).map((m) => m.id));
      setSelectedIds((prev) => new Set([...prev].filter((id) => stillEligible.has(id))));
    } catch {
      toast({ title: "Không kết nối được tới máy chủ — thử lại.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    Promise.all([
      fetch("/api/workflow-stages?entityType=resignation").then((r) => r.json()),
      fetch("/api/workflow-stages?entityType=transfer").then((r) => r.json()),
    ]).then(([res, trans]) => setStages([...(res.rows ?? []), ...(trans.rows ?? [])]));
  }, []);

  const stageLabel = (key: string) => stages.find((s) => s.stageKey === key)?.label ?? key;
  const stageTone = (key: string) => (stages.find((s) => s.stageKey === key)?.color as "green" | "red" | "amber" | "gray" | "blue" | "gold") ?? "gray";
  const deptName = (id: string | null) => {
    const d = depts.find((x) => x.id === id);
    return d ? `${d.deptName}${d.groupName ? " — " + d.groupName : ""}` : "—";
  };

  const searchWorker = async () => {
    if (!isValidCccd(cccdSearch)) {
      toast({ title: CCCD_ERROR_MESSAGE, variant: "destructive" });
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/worker-profiles/${cccdSearch.trim()}`);
      if (!res.ok) {
        toast({ title: "Không tìm thấy hồ sơ điện tử với CCCD này", variant: "destructive" });
        setFoundWorker(null);
        return;
      }
      const d = await res.json();
      const latestSession = d.sessions?.[0];
      setFoundWorker({ id: d.profile.id, fullName: d.profile.fullName, cccd: d.profile.cccd, currentDeptId: latestSession?.deptId ?? null });
    } finally {
      setSearching(false);
    }
  };

  const submitCreate = async () => {
    if (!foundWorker) {
      toast({ title: "Chưa tìm người tập nghề", variant: "destructive" });
      return;
    }
    if (!form.effectiveDate) {
      toast({ title: "Chưa nhập ngày hiệu lực", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/workforce-movements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          movementType: form.movementType,
          workerId: foundWorker.id,
          fromDeptId: foundWorker.currentDeptId,
          toDeptId: form.movementType === "transfer" ? form.toDeptId : undefined,
          effectiveDate: form.effectiveDate,
          reason: form.reason,
          note: form.note,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Lỗi tạo yêu cầu", variant: "destructive" });
        return;
      }
      toast({ title: "Đã tạo yêu cầu — HR sẽ nhận thông báo" });
      setCreateOpen(false);
      setFoundWorker(null);
      setCccdSearch("");
      setForm({ movementType: "resignation", toDeptId: "", effectiveDate: "", reason: "", note: "" });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const runAction = async () => {
    if (!actionTarget) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/workforce-movements/${actionTarget.movement.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionTarget.action, newEffectiveDate: rescheduleDate || undefined }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Thất bại", variant: "destructive" });
        return;
      }
      toast({ title: "Đã xử lý — người tạo yêu cầu sẽ nhận thông báo" });
      setActionTarget(null);
      setRescheduleDate("");
      await load();
    } finally {
      setSaving(false);
    }
  };

  // BULK APPROVAL (nghỉ việc hàng loạt) — chỉ áp dụng cho các dòng đang lộ nút "Duyệt nghỉ
  // việc" đơn lẻ (xem isEligibleForBulkApproval). Danh sách KHÔNG phân trang (GET
  // /api/workforce-movements trả tối đa 500 dòng trong 1 lần gọi, không có "load more") nên
  // "Chọn tất cả đang chờ duyệt" chọn đúng và đủ mọi dòng hợp lệ ĐANG được tải — không có
  // trang ẩn nào bị bỏ sót phía sau.
  const eligibleIds = rows.filter(isEligibleForBulkApproval).map((m) => m.id);
  const allEligibleSelected = eligibleIds.length > 0 && eligibleIds.every((id) => selectedIds.has(id));
  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => setSelectedIds(allEligibleSelected ? new Set() : new Set(eligibleIds));
  const clearSelection = () => setSelectedIds(new Set());

  const runBulkApprove = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    // Chụp tên lao động TRƯỚC khi load() làm mới danh sách — dùng để hiển thị "Xem chi tiết"
    // dễ đọc hơn id thô, không ảnh hưởng gì tới việc server tự xác định lại toàn bộ (server
    // không nhận tên/trạng thái từ đây, chỉ nhận requestIds).
    setBulkResultLabels(new Map(rows.map((m) => [m.id, m.workerName ?? m.workerCccd ?? m.id])));
    setBulkSaving(true);
    try {
      // Một lô có thể trộn cả Nghỉ việc lẫn Thuyên chuyển — mỗi loại có endpoint riêng
      // (bulk-approve-resignation / bulk-approve-transfer), KHÔNG dùng chung 1 engine.
      // Tách theo movementType của chính dòng đang chọn (không đoán từ id), gọi endpoint
      // nào có ids thì gọi, rồi gộp kết quả thành 1 bản tóm tắt duy nhất cho UI.
      const rowById = new Map(rows.map((m) => [m.id, m]));
      const resignationIds = ids.filter((id) => rowById.get(id)?.movementType === "resignation");
      const transferIds = ids.filter((id) => rowById.get(id)?.movementType === "transfer");

      const calls: Promise<{ endpoint: string; res: Response; d: BulkResult | { error?: string } }>[] = [];
      if (resignationIds.length > 0) {
        calls.push(
          fetch("/api/workforce-movements/bulk-approve-resignation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestIds: resignationIds }),
          }).then(async (res) => ({ endpoint: "resignation", res, d: await res.json() })),
        );
      }
      if (transferIds.length > 0) {
        calls.push(
          fetch("/api/workforce-movements/bulk-approve-transfer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestIds: transferIds }),
          }).then(async (res) => ({ endpoint: "transfer", res, d: await res.json() })),
        );
      }
      const outcomes = await Promise.all(calls);
      const failedCall = outcomes.find((o) => !o.res.ok);
      if (failedCall) {
        toast({ title: (failedCall.d as { error?: string }).error ?? "Không xử lý được hàng loạt.", variant: "destructive" });
        return;
      }
      const merged = outcomes.reduce<BulkResult>(
        (acc, o) => {
          const d = o.d as BulkResult;
          return {
            bulkOperationId: acc.bulkOperationId || d.bulkOperationId,
            requested: acc.requested + d.requested,
            approved: acc.approved + d.approved,
            alreadyApproved: acc.alreadyApproved + d.alreadyApproved,
            outOfScope: acc.outOfScope + d.outOfScope,
            noLongerEligible: acc.noLongerEligible + d.noLongerEligible,
            failed: acc.failed + d.failed,
            results: [...acc.results, ...d.results],
          };
        },
        { bulkOperationId: "", requested: 0, approved: 0, alreadyApproved: 0, outOfScope: 0, noLongerEligible: 0, failed: 0, results: [] },
      );

      setBulkConfirmOpen(false);
      setBulkResult(merged);
      setBulkResultDetailOpen(false);
      setSelectedIds(new Set());
      await load();
    } catch {
      toast({ title: "Không kết nối được tới máy chủ — thử lại.", variant: "destructive" });
    } finally {
      setBulkSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Workforce Movement — Nghỉ việc & Thuyên chuyển"
        description={<>HR xác nhận thuyên chuyển (không phải bộ phận mới xác nhận). Toàn bộ lịch sử lưu ở nút &quot;Lịch sử&quot; mỗi dòng.</>}
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            + Tạo yêu cầu
          </Button>
        }
      />

      <Card className="p-0">
        <CardHeader
          title={`${rows.length} yêu cầu gần nhất`}
          right={
            eligibleIds.length > 0 ? (
              <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium text-fg-secondary">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border-strong"
                  checked={allEligibleSelected}
                  onChange={toggleSelectAll}
                  aria-label="Chọn tất cả đang chờ duyệt"
                />
                Chọn tất cả đang chờ duyệt ({eligibleIds.length})
              </label>
            ) : null
          }
        />
        <CardContent className="p-0">
          {loading ? (
            <MovementListSkeleton />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<ArrowLeftRight className="h-5 w-5" aria-hidden />}
              title="Chưa có yêu cầu nào"
              description="Chưa có yêu cầu nghỉ việc hoặc thuyên chuyển nào được tạo."
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((m) => {
                const actions = STATUS_ACTIONS[`${m.movementType}_${m.status}`] ?? [];
                const eligible = isEligibleForBulkApproval(m);
                return (
                  <li
                    key={m.id}
                    className={cn(
                      "flex flex-wrap items-center gap-3 p-4 transition-colors hover:bg-surface-hover",
                      m.id === highlightId && "bg-primary-tint ring-1 ring-inset ring-primary/30",
                    )}
                  >
                    {/* Checkbox chỉ hiển thị cho dòng ĐANG hợp lệ để duyệt hàng loạt (không
                        suy từ chữ hiển thị) — dòng khác (đã nghỉ việc, đã từ chối, thuyên
                        chuyển, ...) không chọn được, giữ chỗ 20px để các dòng thẳng hàng. */}
                    {eligible ? (
                      <input
                        type="checkbox"
                        className="h-[18px] w-[18px] shrink-0 rounded border-border-strong"
                        checked={selectedIds.has(m.id)}
                        onChange={() => toggleSelected(m.id)}
                        aria-label={`Chọn xử lý hàng loạt cho ${m.workerName ?? m.workerCccd ?? m.id}`}
                      />
                    ) : (
                      <span className="w-[18px] shrink-0" aria-hidden />
                    )}
                    <Badge tone={m.movementType === "resignation" ? "red" : "blue"}>{m.movementType === "resignation" ? "Nghỉ việc" : "Thuyên chuyển"}</Badge>
                    <div className="min-w-[160px]">
                      <p className="font-semibold text-fg">
                        {UUID_RE.test(m.workerId) ? (
                          <Link href={`/admin/worker-profiles/${m.workerId}`} className="hover:underline">
                            {m.workerName ?? m.workerCccd}
                          </Link>
                        ) : (
                          (m.workerName ?? m.workerCccd)
                        )}
                      </p>
                      <p className="text-xs text-fg-muted">{m.workerCccd}</p>
                    </div>
                    <p className="text-xs text-fg-secondary">
                      {deptName(m.fromDeptId)}
                      {m.movementType === "transfer" ? ` → ${deptName(m.toDeptId)}` : ""} · Hiệu lực {m.effectiveDate}
                    </p>
                    <Badge tone={stageTone(m.status)} dot>{stageLabel(m.status)}</Badge>
                    <span className="text-xs text-fg-muted">bởi {m.requestedBy}</span>
                    <div className="ml-auto flex flex-wrap gap-1.5">
                      {actions.map((a) => (
                        <button
                          key={a.action}
                          onClick={() => setActionTarget({ movement: m, action: a.action })}
                          className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${ACTION_TONE_CLASS[a.tone]}`}
                        >
                          <a.icon className="h-3 w-3" aria-hidden /> {a.label}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* BULK ACTION BAR — chỉ khi có >=1 dòng đang chọn. Sticky đáy màn hình để dùng tốt trên
          mobile (không cần cuộn xuống cuối danh sách) và vẫn gọn trên desktop; không tràn
          ngang nhờ flex-wrap + max-width nội dung. */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-3 z-40 flex flex-wrap items-center gap-3 rounded-[14px] border border-border-strong bg-surface-raised p-3 shadow-lg">
          <span className="text-[13px] font-semibold text-fg">Đã chọn: {selectedIds.size}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={clearSelection} disabled={bulkSaving}>
              Bỏ chọn
            </Button>
            <Button variant="primary" size="sm" onClick={() => setBulkConfirmOpen(true)} disabled={bulkSaving}>
              Duyệt đã chọn ({selectedIds.size})
            </Button>
          </div>
        </div>
      )}

      {/* MỘT xác nhận duy nhất cho toàn bộ lô — không hỏi lại từng người. Lô có thể trộn
          Nghỉ việc (Duyệt nghỉ việc) và Thuyên chuyển (Đã nhận việc) — mỗi loại được xử lý
          qua đúng canonical action của nó (xem runBulkApprove). */}
      <ConfirmDialog
        open={bulkConfirmOpen}
        onClose={() => setBulkConfirmOpen(false)}
        onConfirm={runBulkApprove}
        title="Xác nhận xử lý hàng loạt"
        description={
          <>
            Bạn sắp xử lý {selectedIds.size} yêu cầu (Duyệt nghỉ việc và/hoặc Đã nhận việc thuyên chuyển). Sau khi xác nhận, hệ
            thống sẽ xử lý từng hồ sơ theo đúng quy trình hiện tại của loại yêu cầu đó.
          </>
        }
        confirmLabel={`Xác nhận xử lý ${selectedIds.size} yêu cầu`}
        loading={bulkSaving}
      />

      {/* KẾT QUẢ — 1 bản tóm tắt duy nhất, KHÔNG toast riêng cho từng người. */}
      <Modal
        open={!!bulkResult}
        onClose={() => {
          setBulkResult(null);
          setBulkResultDetailOpen(false);
        }}
        title="Xử lý hàng loạt hoàn tất"
        width="max-w-md"
      >
        {bulkResult && (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-2 text-[13px]">
              <div className="rounded-[10px] bg-surface-hover p-3">
                <dt className="text-fg-muted">Đã chọn</dt>
                <dd className="text-lg font-semibold text-fg">{bulkResult.requested}</dd>
              </div>
              <div className="rounded-[10px] bg-success-tint p-3">
                <dt className="text-success">Thành công</dt>
                <dd className="text-lg font-semibold text-success">{bulkResult.approved}</dd>
              </div>
              <div className="rounded-[10px] bg-surface-hover p-3">
                <dt className="text-fg-muted">Bỏ qua</dt>
                <dd className="text-lg font-semibold text-fg-secondary">
                  {bulkResult.alreadyApproved + bulkResult.outOfScope + bulkResult.noLongerEligible}
                </dd>
              </div>
              <div className="rounded-[10px] bg-danger-tint p-3">
                <dt className="text-danger">Lỗi</dt>
                <dd className="text-lg font-semibold text-danger">{bulkResult.failed}</dd>
              </div>
            </dl>
            {bulkResult.results.some((r) => r.outcome !== "APPROVED") && (
              <div>
                <button
                  type="button"
                  className="text-[12.5px] font-semibold text-primary underline underline-offset-2"
                  onClick={() => setBulkResultDetailOpen((v) => !v)}
                >
                  {bulkResultDetailOpen ? "Ẩn chi tiết" : "Xem chi tiết"}
                </button>
                {bulkResultDetailOpen && (
                  <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto rounded-[10px] border border-border p-2.5 text-[12.5px]">
                    {bulkResult.results
                      .filter((r) => r.outcome !== "APPROVED")
                      .map((r) => (
                        <li key={r.id} className="flex flex-col">
                          <span className="font-medium text-fg">{bulkResultLabels.get(r.id) ?? r.id}</span>
                          <span className="text-fg-muted">
                            {BULK_OUTCOME_LABEL[r.outcome] ?? r.outcome}
                            {r.reason ? ` — ${r.reason}` : ""}
                          </span>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Tạo yêu cầu Nghỉ việc / Thuyên chuyển" width="max-w-xl">
        <div className="space-y-4">
          <FormField label="Tìm người tập nghề theo CCCD" required>
            <div className="flex gap-2">
              <Input value={cccdSearch} inputMode="numeric" maxLength={12} onChange={(e) => setCccdSearch(e.target.value.replace(/\D/g, ""))} placeholder="Nhập đúng 12 chữ số CCCD..." />
              <Button onClick={searchWorker} loading={searching}>
                <Search className="h-4 w-4" /> Tìm
              </Button>
            </div>
            {foundWorker && (
              <p className="mt-1.5 flex items-center gap-1.5 rounded-[8px] bg-success-tint p-2 text-xs font-medium text-success">
                <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> {foundWorker.fullName} — {foundWorker.cccd} — Bộ phận hiện tại: {deptName(foundWorker.currentDeptId)}
              </p>
            )}
          </FormField>
          <FormField label="Loại yêu cầu">
            <select value={form.movementType} onChange={(e) => setForm({ ...form, movementType: e.target.value as "resignation" | "transfer" })} className="h-10 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-[14px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15">
              <option value="resignation">Nghỉ việc</option>
              <option value="transfer">Thuyên chuyển</option>
            </select>
          </FormField>
          {form.movementType === "transfer" && (
            <FormField label="Bộ phận mới" required>
              <select value={form.toDeptId} onChange={(e) => setForm({ ...form, toDeptId: e.target.value })} className="h-10 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-[14px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15">
                <option value="">— Chọn bộ phận —</option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.deptName}
                    {d.groupName ? ` — ${d.groupName}` : ""}
                  </option>
                ))}
              </select>
            </FormField>
          )}
          <FormField label="Ngày hiệu lực" required>
            <Input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
          </FormField>
          <FormField label="Lý do">
            <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </FormField>
          <FormField label="Ghi chú">
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </FormField>
          <Button variant="primary" size="lg" className="w-full" loading={saving} onClick={submitCreate}>
            Gửi yêu cầu (chờ HR duyệt)
          </Button>
        </div>
      </Modal>

      <Modal open={!!actionTarget} onClose={() => setActionTarget(null)} title="Xác nhận hành động">
        <div className="space-y-4">
          <p className="text-sm text-fg-secondary">
            {actionTarget?.movement.workerName} — {STATUS_ACTIONS[`${actionTarget?.movement.movementType}_${actionTarget?.movement.status}`]?.find((a) => a.action === actionTarget?.action)?.label}
          </p>
          {actionTarget?.action === "RESCHEDULE" && (
            <FormField label="Ngày chuyển mới" required>
              <Input type="date" value={rescheduleDate} onChange={(e) => setRescheduleDate(e.target.value)} />
            </FormField>
          )}
          <Button variant="primary" className="w-full" loading={saving} onClick={runAction}>
            Xác nhận
          </Button>
        </div>
      </Modal>
    </div>
  );
}
