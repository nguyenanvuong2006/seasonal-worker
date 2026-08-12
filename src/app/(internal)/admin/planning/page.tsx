"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  FormField,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  toast,
} from "@/components/ui";
import { CalendarRange, Plus, Users } from "lucide-react";

type Period = {
  id: string;
  departmentId: string;
  deptName: string | null;
  section: string | null;
  startDate: string;
  endDate: string;
  status: "DRAFT" | "ACTIVE" | "EXPIRED";
  version: number;
  supersededBy: string | null;
  createdBy: string;
  targetCount: number | null;
  fillRate: { demand: number; active: number; missing: number; percent: number } | null;
};
type Dept = { id: string; deptName: string; groupName: string | null };
type Unplanned = { id: string; workerName: string | null; workerCccd: string | null; deptName: string | null };

const STATUS_TABS = [
  { key: "ACTIVE", label: "Đang áp dụng" },
  { key: "DRAFT", label: "Nháp" },
  { key: "EXPIRED", label: "Đã hết hạn" },
];

function PlanningListSkeleton() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-4">
          <div className="min-w-[160px] space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export default function PlanningPage() {
  const [rows, setRows] = useState<Period[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [createOpen, setCreateOpen] = useState(false);
  const [reviseTarget, setReviseTarget] = useState<Period | null>(null);
  const [allocateTarget, setAllocateTarget] = useState<Period | null>(null);
  const [unplanned, setUnplanned] = useState<Unplanned[]>([]);
  const [unplannedSel, setUnplannedSel] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({ departmentId: "", startDate: "", endDate: "", targetCount: 0, note: "", activateNow: true });
  const [reviseForm, setReviseForm] = useState({ startDate: "", endDate: "", targetCount: 0, note: "" });

  const load = useCallback(async (status = statusFilter) => {
    setLoading(true);
    const [pRes, dRes] = await Promise.all([fetch(`/api/planning?status=${status}`), fetch("/api/departments")]);
    const pData = await pRes.json();
    const dData = await dRes.json();
    setRows(pData.rows ?? []);
    setDepts(dData.rows ?? []);
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => {
    void load(statusFilter);
  }, [statusFilter, load]);

  const selectedDept = depts.find((d) => d.id === form.departmentId);

  const submitCreate = async () => {
    if (!form.departmentId || !form.startDate || !form.endDate) {
      toast({ title: "Thiếu bộ phận hoặc ngày", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/planning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, section: selectedDept?.groupName ?? null }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Lỗi tạo kế hoạch", variant: "destructive" });
        return;
      }
      toast({ title: "Đã tạo kế hoạch" });
      setCreateOpen(false);
      const created = d.row as Period;
      setForm({ departmentId: "", startDate: "", endDate: "", targetCount: 0, note: "", activateNow: true });
      await load(statusFilter);
      if (created.status === "ACTIVE") {
        await openAllocate(created);
      }
    } finally {
      setSaving(false);
    }
  };

  const activate = async (p: Period) => {
    const res = await fetch(`/api/planning/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "activate" }),
    });
    const d = await res.json();
    if (!res.ok) {
      toast({ title: d.error ?? "Lỗi kích hoạt", variant: "destructive" });
      return;
    }
    toast({ title: "Đã kích hoạt kế hoạch" });
    await load(statusFilter);
  };

  const submitRevise = async () => {
    if (!reviseTarget) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/planning/${reviseTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revise", ...reviseForm }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Lỗi sửa kế hoạch", variant: "destructive" });
        return;
      }
      toast({ title: "Đã lưu — tạo phiên bản mới, giữ nguyên lịch sử bản cũ" });
      setReviseTarget(null);
      await load(statusFilter);
    } finally {
      setSaving(false);
    }
  };

  const openAllocate = async (p: Period) => {
    setAllocateTarget(p);
    setUnplannedSel({});
    const res = await fetch(`/api/planning/unplanned?departmentId=${p.departmentId}`);
    const d = await res.json();
    setUnplanned(d.rows ?? []);
  };

  const submitAllocate = async () => {
    if (!allocateTarget) return;
    const ids = Object.keys(unplannedSel).filter((k) => unplannedSel[k]);
    if (ids.length === 0) {
      setAllocateTarget(null);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/planning/${allocateTarget.id}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employmentSessionIds: ids }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Lỗi phân bổ", variant: "destructive" });
        return;
      }
      toast({ title: `Đã phân bổ ${ids.length} lao động vào kế hoạch` });
      setAllocateTarget(null);
      await load(statusFilter);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Planning — Kế hoạch theo giai đoạn"
        description="Thay cho định mức/ngày cố định — quản lý theo khoảng ngày, không cho chồng lấn, giữ lịch sử khi sửa."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> Tạo kế hoạch
          </Button>
        }
      />

      <div className="flex gap-1.5 rounded-[10px] bg-surface-hover p-1 w-fit">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatusFilter(t.key)}
            className={`rounded-[8px] px-4 py-1.5 text-[13px] font-semibold transition-colors ${
              statusFilter === t.key ? "bg-surface text-primary shadow-sm" : "text-fg-secondary hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card className="p-0">
        <CardContent className="p-0">
          {loading ? (
            <PlanningListSkeleton />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<CalendarRange className="h-5 w-5" aria-hidden />}
              title="Không có kế hoạch nào"
              description="Chưa có kế hoạch nào ở trạng thái này. Tạo kế hoạch mới để bắt đầu."
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 p-4 transition-colors hover:bg-surface-hover">
                  <div className="min-w-[160px]">
                    <p className="font-semibold text-fg">
                      {p.deptName} {p.section ? `— ${p.section}` : ""}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {p.startDate} → {p.endDate} · v{p.version}
                    </p>
                  </div>
                  <Badge tone={p.status === "ACTIVE" ? "green" : p.status === "DRAFT" ? "amber" : "gray"} dot>
                    {p.status === "ACTIVE" ? "Đang áp dụng" : p.status === "DRAFT" ? "Nháp" : "Đã hết hạn"}
                  </Badge>
                  {p.fillRate && (
                    <span className="text-xs font-semibold text-primary">
                      {p.fillRate.active}/{p.fillRate.demand} ({p.fillRate.percent}%){p.fillRate.missing > 0 ? ` · thiếu ${p.fillRate.missing}` : ""}
                    </span>
                  )}
                  {!p.fillRate && <span className="text-xs text-fg-muted">Nhu cầu: {p.targetCount ?? 0}</span>}
                  <div className="ml-auto flex gap-1.5">
                    {p.status === "DRAFT" && (
                      <button onClick={() => activate(p)} className="rounded-full bg-success-tint px-3 py-1.5 text-[11px] font-semibold text-success hover:bg-success/20">
                        Kích hoạt
                      </button>
                    )}
                    {p.status === "ACTIVE" && (
                      <>
                        <button
                          onClick={() => {
                            setReviseTarget(p);
                            setReviseForm({ startDate: p.startDate, endDate: p.endDate, targetCount: p.targetCount ?? 0, note: "" });
                          }}
                          className="rounded-full bg-primary-tint px-3 py-1.5 text-[11px] font-semibold text-primary hover:bg-primary/15"
                        >
                          Sửa (tạo version mới)
                        </button>
                        <button onClick={() => openAllocate(p)} className="rounded-full bg-surface-hover px-3 py-1.5 text-[11px] font-semibold text-fg-secondary hover:bg-border">
                          Phân bổ lao động
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Tạo kế hoạch mới">
        <div className="space-y-4">
          <FormField label="Bộ phận" required>
            <select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} className="h-10 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-[14px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15">
              <option value="">— Chọn bộ phận —</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.deptName}
                  {d.groupName ? ` — ${d.groupName}` : ""}
                </option>
              ))}
            </select>
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Từ ngày" required>
              <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </FormField>
            <FormField label="Đến ngày" required>
              <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </FormField>
          </div>
          <FormField label="Nhu cầu (số lượng)" required>
            <Input type="number" value={form.targetCount} onChange={(e) => setForm({ ...form, targetCount: Number(e.target.value) })} />
          </FormField>
          <FormField label="Ghi chú">
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </FormField>
          <label className="flex items-center gap-2 text-sm font-medium text-fg">
            <input type="checkbox" checked={form.activateNow} onChange={(e) => setForm({ ...form, activateNow: e.target.checked })} className="h-4 w-4 accent-primary" />
            Kích hoạt ngay (bỏ tick = lưu Nháp)
          </label>
          <Button variant="primary" size="lg" className="w-full" loading={saving} onClick={submitCreate}>
            Lưu kế hoạch
          </Button>
        </div>
      </Modal>

      <Modal open={!!reviseTarget} onClose={() => setReviseTarget(null)} title="Sửa kế hoạch (tạo phiên bản mới)">
        <div className="space-y-4">
          <p className="text-xs text-fg-muted">Bản cũ sẽ chuyển sang lịch sử (Đã hết hạn), không bị xoá.</p>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Từ ngày">
              <Input type="date" value={reviseForm.startDate} onChange={(e) => setReviseForm({ ...reviseForm, startDate: e.target.value })} />
            </FormField>
            <FormField label="Đến ngày">
              <Input type="date" value={reviseForm.endDate} onChange={(e) => setReviseForm({ ...reviseForm, endDate: e.target.value })} />
            </FormField>
          </div>
          <FormField label="Nhu cầu (số lượng)">
            <Input type="number" value={reviseForm.targetCount} onChange={(e) => setReviseForm({ ...reviseForm, targetCount: Number(e.target.value) })} />
          </FormField>
          <Button variant="primary" className="w-full" loading={saving} onClick={submitRevise}>
            Lưu phiên bản mới
          </Button>
        </div>
      </Modal>

      <Modal open={!!allocateTarget} onClose={() => setAllocateTarget(null)} title="Phân bổ lao động chưa có kế hoạch">
        <div className="space-y-4">
          <p className="text-xs text-fg-muted">
            Lao động đang làm ở {allocateTarget?.deptName} nhưng chưa thuộc kế hoạch ACTIVE nào (Unplanned).
          </p>
          {unplanned.length === 0 ? (
            <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title="Không có lao động Unplanned" description="Tất cả lao động ở bộ phận này đã có kế hoạch." />
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {unplanned.map((u) => (
                <li key={u.id} className="flex items-center gap-2 rounded-[8px] bg-surface-hover px-2 py-1.5 text-sm">
                  <input type="checkbox" checked={!!unplannedSel[u.id]} onChange={(e) => setUnplannedSel({ ...unplannedSel, [u.id]: e.target.checked })} className="h-4 w-4 accent-primary" />
                  <span className="text-fg">
                    {u.workerName} <span className="text-xs text-fg-muted">({u.workerCccd})</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Button variant="primary" className="w-full" loading={saving} onClick={submitAllocate}>
            {unplanned.length === 0 ? "Đóng" : "Phân bổ đã chọn"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
