"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
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

  const [cccdSearch, setCccdSearch] = useState("");
  const [foundWorker, setFoundWorker] = useState<{ id: string; fullName: string; cccd: string; currentDeptId: string | null } | null>(null);
  const [form, setForm] = useState({ movementType: "resignation" as "resignation" | "transfer", toDeptId: "", effectiveDate: "", reason: "", note: "" });

  const load = useCallback(async () => {
    setLoading(true);
    const [movRes, deptRes] = await Promise.all([fetch("/api/workforce-movements"), fetch("/api/departments")]);
    const movData = await movRes.json();
    const deptData = await deptRes.json();
    setRows(movData.rows ?? []);
    setDepts(deptData.rows ?? []);
    setLoading(false);
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
    if (!cccdSearch.trim()) return;
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
        <CardHeader title={`${rows.length} yêu cầu gần nhất`} />
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
                return (
                  <li
                    key={m.id}
                    className={cn(
                      "flex flex-wrap items-center gap-3 p-4 transition-colors hover:bg-surface-hover",
                      m.id === highlightId && "bg-primary-tint ring-1 ring-inset ring-primary/30",
                    )}
                  >
                    <Badge tone={m.movementType === "resignation" ? "red" : "blue"}>{m.movementType === "resignation" ? "Nghỉ việc" : "Thuyên chuyển"}</Badge>
                    <div className="min-w-[160px]">
                      <p className="font-semibold text-fg">{m.workerName ?? m.workerCccd}</p>
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

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Tạo yêu cầu Nghỉ việc / Thuyên chuyển" width="max-w-xl">
        <div className="space-y-4">
          <FormField label="Tìm người tập nghề theo CCCD" required>
            <div className="flex gap-2">
              <Input value={cccdSearch} onChange={(e) => setCccdSearch(e.target.value.replace(/\D/g, ""))} placeholder="Nhập số CCCD..." />
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
