"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, Input, Label, Modal, toast } from "@/components/ui";
import { Loader2, Search } from "lucide-react";

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

const STATUS_ACTIONS: Record<string, { action: string; label: string; tone: "green" | "red" | "amber" | "gray" }[]> = {
  resignation_PENDING_HR: [
    { action: "APPROVE_RESIGNATION", label: "✓ Duyệt nghỉ việc", tone: "green" },
    { action: "REJECT", label: "✗ Từ chối", tone: "red" },
  ],
  transfer_PENDING_HR: [
    { action: "CONFIRM_ARRIVED", label: "✓ Đã nhận việc", tone: "green" },
    { action: "RESCHEDULE", label: "⏱ Hoãn", tone: "amber" },
    { action: "NOT_ARRIVED", label: "⚠ Không đến", tone: "amber" },
    { action: "REJECT", label: "✗ Từ chối", tone: "red" },
  ],
  transfer_TRANSFER_RESCHEDULED: [
    { action: "CONFIRM_ARRIVED", label: "✓ Đã nhận việc", tone: "green" },
    { action: "RESCHEDULE", label: "⏱ Hoãn tiếp", tone: "amber" },
    { action: "NOT_ARRIVED", label: "⚠ Không đến", tone: "amber" },
    { action: "REJECT", label: "✗ Từ chối", tone: "red" },
  ],
  transfer_WAITING_DECISION: [
    { action: "CANCEL", label: "Huỷ thuyên chuyển", tone: "gray" },
    { action: "SPAWN_RESIGNATION", label: "→ Sinh yêu cầu nghỉ việc", tone: "red" },
  ],
};

export default function WorkforceMovementsPage() {
  const [rows, setRows] = useState<Movement[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<{ movement: Movement; action: string } | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");

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
    const res = await fetch(`/api/worker-profiles/${cccdSearch.trim()}`);
    if (!res.ok) {
      toast({ title: "Không tìm thấy hồ sơ điện tử với CCCD này", variant: "destructive" });
      setFoundWorker(null);
      return;
    }
    const d = await res.json();
    const latestSession = d.sessions?.[0];
    setFoundWorker({ id: d.profile.id, fullName: d.profile.fullName, cccd: d.profile.cccd, currentDeptId: latestSession?.deptId ?? null });
  };

  const submitCreate = async () => {
    if (!foundWorker) {
      toast({ title: "Chưa tìm lao động", variant: "destructive" });
      return;
    }
    if (!form.effectiveDate) {
      toast({ title: "Chưa nhập ngày hiệu lực", variant: "destructive" });
      return;
    }
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
    toast({ title: "✅ Đã tạo yêu cầu — HR sẽ nhận thông báo" });
    setCreateOpen(false);
    setFoundWorker(null);
    setCccdSearch("");
    setForm({ movementType: "resignation", toDeptId: "", effectiveDate: "", reason: "", note: "" });
    await load();
  };

  const runAction = async () => {
    if (!actionTarget) return;
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
    toast({ title: "✅ Đã xử lý — người tạo yêu cầu sẽ nhận thông báo" });
    setActionTarget(null);
    setRescheduleDate("");
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-hasfarm-900">Workforce Movement — Nghỉ việc & Thuyên chuyển</h1>
          <p className="text-sm text-gray-500">HR xác nhận thuyên chuyển (không phải bộ phận mới xác nhận). Toàn bộ lịch sử lưu ở nút &quot;Lịch sử&quot; mỗi dòng.</p>
        </div>
        <Button variant="gold" onClick={() => setCreateOpen(true)}>
          + Tạo yêu cầu
        </Button>
      </div>

      <Card className="p-0">
        <CardHeader title={`${rows.length} yêu cầu gần nhất`} />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
            </div>
          ) : (
            <ul className="divide-y">
              {rows.length === 0 && <li className="p-8 text-center text-sm text-gray-400">Chưa có yêu cầu nào.</li>}
              {rows.map((m) => {
                const actions = STATUS_ACTIONS[`${m.movementType}_${m.status}`] ?? [];
                return (
                  <li key={m.id} className="flex flex-wrap items-center gap-3 p-4">
                    <Badge tone={m.movementType === "resignation" ? "red" : "blue"}>{m.movementType === "resignation" ? "Nghỉ việc" : "Thuyên chuyển"}</Badge>
                    <div className="min-w-[160px]">
                      <p className="font-bold text-hasfarm-900">{m.workerName ?? m.workerCccd}</p>
                      <p className="text-xs text-gray-500">{m.workerCccd}</p>
                    </div>
                    <p className="text-xs text-gray-500">
                      {deptName(m.fromDeptId)}
                      {m.movementType === "transfer" ? ` → ${deptName(m.toDeptId)}` : ""} · Hiệu lực {m.effectiveDate}
                    </p>
                    <Badge tone={stageTone(m.status)}>{stageLabel(m.status)}</Badge>
                    <span className="text-xs text-gray-400">bởi {m.requestedBy}</span>
                    <div className="ml-auto flex flex-wrap gap-1">
                      {actions.map((a) => (
                        <button
                          key={a.action}
                          onClick={() => setActionTarget({ movement: m, action: a.action })}
                          className={`rounded-full px-3 py-1.5 text-[11px] font-bold ${
                            a.tone === "green"
                              ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                              : a.tone === "red"
                                ? "bg-red-100 text-red-700 hover:bg-red-200"
                                : a.tone === "amber"
                                  ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                          }`}
                        >
                          {a.label}
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
        <div className="space-y-3">
          <div>
            <Label>Tìm lao động theo CCCD *</Label>
            <div className="flex gap-2">
              <Input value={cccdSearch} onChange={(e) => setCccdSearch(e.target.value.replace(/\D/g, ""))} className="h-11" placeholder="Nhập số CCCD" />
              <Button onClick={searchWorker} className="gap-2">
                <Search className="h-4 w-4" /> Tìm
              </Button>
            </div>
            {foundWorker && (
              <p className="mt-1 rounded-lg bg-emerald-50 p-2 text-xs text-emerald-800">
                ✓ {foundWorker.fullName} — {foundWorker.cccd} — Bộ phận hiện tại: {deptName(foundWorker.currentDeptId)}
              </p>
            )}
          </div>
          <div>
            <Label>Loại yêu cầu</Label>
            <select value={form.movementType} onChange={(e) => setForm({ ...form, movementType: e.target.value as "resignation" | "transfer" })} className="h-11 w-full rounded-xl border-2 border-gray-200 px-2 font-semibold">
              <option value="resignation">Nghỉ việc</option>
              <option value="transfer">Thuyên chuyển</option>
            </select>
          </div>
          {form.movementType === "transfer" && (
            <div>
              <Label>Bộ phận mới *</Label>
              <select value={form.toDeptId} onChange={(e) => setForm({ ...form, toDeptId: e.target.value })} className="h-11 w-full rounded-xl border-2 border-gray-200 px-2 font-semibold">
                <option value="">— Chọn bộ phận —</option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.deptName}
                    {d.groupName ? ` — ${d.groupName}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <Label>Ngày hiệu lực *</Label>
            <Input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} className="h-11" />
          </div>
          <div>
            <Label>Lý do</Label>
            <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="h-11" />
          </div>
          <div>
            <Label>Ghi chú</Label>
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="h-11" />
          </div>
          <Button variant="gold" size="lg" className="w-full" onClick={submitCreate}>
            Gửi yêu cầu (chờ HR duyệt)
          </Button>
        </div>
      </Modal>

      <Modal open={!!actionTarget} onClose={() => setActionTarget(null)} title="Xác nhận hành động">
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            {actionTarget?.movement.workerName} — {STATUS_ACTIONS[`${actionTarget?.movement.movementType}_${actionTarget?.movement.status}`]?.find((a) => a.action === actionTarget?.action)?.label}
          </p>
          {actionTarget?.action === "RESCHEDULE" && (
            <div>
              <Label>Ngày chuyển mới *</Label>
              <Input type="date" value={rescheduleDate} onChange={(e) => setRescheduleDate(e.target.value)} className="h-11" />
            </div>
          )}
          <Button variant="gold" className="w-full" onClick={runAction}>
            Xác nhận
          </Button>
        </div>
      </Modal>
    </div>
  );
}
