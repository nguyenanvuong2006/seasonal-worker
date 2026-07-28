"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, Input, Label, Modal, toast } from "@/components/ui";
import { Loader2 } from "lucide-react";

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
    toast({ title: "✅ Đã tạo kế hoạch" });
    setCreateOpen(false);
    const created = d.row as Period;
    setForm({ departmentId: "", startDate: "", endDate: "", targetCount: 0, note: "", activateNow: true });
    await load(statusFilter);
    if (created.status === "ACTIVE") {
      await openAllocate(created);
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
    toast({ title: "✅ Đã kích hoạt kế hoạch" });
    await load(statusFilter);
  };

  const submitRevise = async () => {
    if (!reviseTarget) return;
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
    toast({ title: "✅ Đã lưu — tạo phiên bản mới, giữ nguyên lịch sử bản cũ" });
    setReviseTarget(null);
    await load(statusFilter);
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
    toast({ title: `✅ Đã phân bổ ${ids.length} lao động vào kế hoạch` });
    setAllocateTarget(null);
    await load(statusFilter);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-hasfarm-900">Planning — Kế hoạch theo giai đoạn</h1>
          <p className="text-sm text-gray-500">
            Thay cho định mức/ngày cố định — quản lý theo khoảng ngày, không cho chồng lấn, giữ lịch sử khi sửa.
          </p>
        </div>
        <Button variant="gold" onClick={() => setCreateOpen(true)}>
          + Tạo kế hoạch
        </Button>
      </div>

      <div className="flex gap-2">
        {["ACTIVE", "DRAFT", "EXPIRED"].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-full px-4 py-2 text-sm font-bold ${statusFilter === s ? "bg-hasfarm-800 text-white" : "bg-gray-100 text-gray-600"}`}
          >
            {s === "ACTIVE" ? "Đang áp dụng" : s === "DRAFT" ? "Nháp" : "Đã hết hạn"}
          </button>
        ))}
      </div>

      <Card className="p-0">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
            </div>
          ) : (
            <ul className="divide-y">
              {rows.length === 0 && <li className="p-8 text-center text-sm text-gray-400">Không có kế hoạch nào.</li>}
              {rows.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-[160px]">
                    <p className="font-bold text-hasfarm-900">
                      {p.deptName} {p.section ? `— ${p.section}` : ""}
                    </p>
                    <p className="text-xs text-gray-500">
                      {p.startDate} → {p.endDate} · v{p.version}
                    </p>
                  </div>
                  <Badge tone={p.status === "ACTIVE" ? "green" : p.status === "DRAFT" ? "amber" : "gray"}>
                    {p.status === "ACTIVE" ? "Đang áp dụng" : p.status === "DRAFT" ? "Nháp" : "Đã hết hạn"}
                  </Badge>
                  {p.fillRate && (
                    <span className="text-xs font-bold text-hasfarm-700">
                      {p.fillRate.active}/{p.fillRate.demand} ({p.fillRate.percent}%){p.fillRate.missing > 0 ? ` · thiếu ${p.fillRate.missing}` : ""}
                    </span>
                  )}
                  {!p.fillRate && <span className="text-xs text-gray-400">Nhu cầu: {p.targetCount ?? 0}</span>}
                  <div className="ml-auto flex gap-1">
                    {p.status === "DRAFT" && (
                      <button onClick={() => activate(p)} className="rounded-full bg-emerald-100 px-3 py-1.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-200">
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
                          className="rounded-full bg-hasfarm-50 px-3 py-1.5 text-[11px] font-bold text-hasfarm-700 hover:bg-hasfarm-100"
                        >
                          Sửa (tạo version mới)
                        </button>
                        <button onClick={() => openAllocate(p)} className="rounded-full bg-gray-100 px-3 py-1.5 text-[11px] font-bold text-gray-600 hover:bg-gray-200">
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
        <div className="space-y-3">
          <div>
            <Label>Bộ phận *</Label>
            <select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} className="h-11 w-full rounded-xl border-2 border-gray-200 px-2 font-semibold">
              <option value="">— Chọn bộ phận —</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.deptName}
                  {d.groupName ? ` — ${d.groupName}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Từ ngày *</Label>
              <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="h-11" />
            </div>
            <div>
              <Label>Đến ngày *</Label>
              <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="h-11" />
            </div>
          </div>
          <div>
            <Label>Nhu cầu (số lượng) *</Label>
            <Input type="number" value={form.targetCount} onChange={(e) => setForm({ ...form, targetCount: Number(e.target.value) })} className="h-11" />
          </div>
          <div>
            <Label>Ghi chú</Label>
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="h-11" />
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={form.activateNow} onChange={(e) => setForm({ ...form, activateNow: e.target.checked })} />
            Kích hoạt ngay (bỏ tick = lưu Nháp)
          </label>
          <Button variant="gold" size="lg" className="w-full" onClick={submitCreate}>
            Lưu kế hoạch
          </Button>
        </div>
      </Modal>

      <Modal open={!!reviseTarget} onClose={() => setReviseTarget(null)} title="Sửa kế hoạch (tạo phiên bản mới)">
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Bản cũ sẽ chuyển sang lịch sử (Đã hết hạn), không bị xoá.</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Từ ngày</Label>
              <Input type="date" value={reviseForm.startDate} onChange={(e) => setReviseForm({ ...reviseForm, startDate: e.target.value })} className="h-11" />
            </div>
            <div>
              <Label>Đến ngày</Label>
              <Input type="date" value={reviseForm.endDate} onChange={(e) => setReviseForm({ ...reviseForm, endDate: e.target.value })} className="h-11" />
            </div>
          </div>
          <div>
            <Label>Nhu cầu (số lượng)</Label>
            <Input type="number" value={reviseForm.targetCount} onChange={(e) => setReviseForm({ ...reviseForm, targetCount: Number(e.target.value) })} className="h-11" />
          </div>
          <Button variant="gold" className="w-full" onClick={submitRevise}>
            Lưu phiên bản mới
          </Button>
        </div>
      </Modal>

      <Modal open={!!allocateTarget} onClose={() => setAllocateTarget(null)} title="Phân bổ lao động chưa có kế hoạch">
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            Lao động đang làm ở {allocateTarget?.deptName} nhưng chưa thuộc kế hoạch ACTIVE nào (Unplanned).
          </p>
          {unplanned.length === 0 ? (
            <p className="rounded-xl bg-gray-50 p-4 text-center text-sm text-gray-400">Không có lao động Unplanned nào ở bộ phận này.</p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {unplanned.map((u) => (
                <li key={u.id} className="flex items-center gap-2 rounded-lg bg-gray-50 px-2 py-1.5 text-sm">
                  <input type="checkbox" checked={!!unplannedSel[u.id]} onChange={(e) => setUnplannedSel({ ...unplannedSel, [u.id]: e.target.checked })} />
                  <span>
                    {u.workerName} <span className="text-xs text-gray-400">({u.workerCccd})</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Button variant="gold" className="w-full" onClick={submitAllocate}>
            {unplanned.length === 0 ? "Đóng" : "Phân bổ đã chọn"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
