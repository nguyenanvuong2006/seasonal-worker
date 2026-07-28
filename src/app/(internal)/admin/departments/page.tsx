"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardContent, Input, Label, Modal, toast } from "@/components/ui";
import { Loader2 } from "lucide-react";

type Dept = {
  id: string;
  stt: number | null;
  deptName: string;
  groupName: string;
  vnName: string | null;
  supervisor: string | null;
  supervisorPhone: string | null;
  sheetLink: string | null;
  dailyQuota: number;
  isActive: boolean;
  assignedToday: number;
  totalAssigned: number;
};

export default function DepartmentsAdminPage() {
  const [rows, setRows] = useState<Dept[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [form, setForm] = useState({
    deptName: "",
    groupName: "",
    vnName: "",
    supervisor: "",
    supervisorPhone: "",
    sheetLink: "",
    dailyQuota: 0,
  });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/departments");
    const data = await res.json();
    setRows(data.rows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(
      (r) =>
        r.deptName.toLowerCase().includes(s) ||
        r.groupName.toLowerCase().includes(s) ||
        (r.vnName ?? "").toLowerCase().includes(s) ||
        (r.supervisor ?? "").toLowerCase().includes(s),
    );
  }, [rows, q]);

  const create = async () => {
    const res = await fetch("/api/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const d = await res.json();
    if (!res.ok) {
      toast({ title: d.error ?? "Lỗi tạo bộ phận", variant: "destructive" });
      return;
    }
    toast({ title: "✅ Đã thêm bộ phận — tự động vào dropdown Daily Application" });
    setOpen(false);
    setForm({ deptName: "", groupName: "", vnName: "", supervisor: "", supervisorPhone: "", sheetLink: "", dailyQuota: 0 });
    await load();
  };

  const patch = async (id: string, body: Partial<Dept>) => {
    setRows((p) => p.map((r) => (r.id === id ? { ...r, ...body } : r)));
    const res = await fetch("/api/departments", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    if (!res.ok) {
      toast({ title: "Lưu thất bại", variant: "destructive" });
      await load();
    }
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/departments?id=${id}`, { method: "DELETE" });
    const d = await res.json();
    if (!res.ok) {
      toast({ title: d.error, variant: "destructive" });
      return;
    }
    toast({ title: "Đã xoá bộ phận" });
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="rounded-[20px] bg-white p-6 shadow-sm ring-1 ring-black/5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <span className="rounded-full bg-hasfarm-700 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white">
              Sheet: Department
            </span>
            <h1 className="mt-3 text-[26px] font-black tracking-tight text-hasfarm-900">
              Bộ phận &amp; Nhóm ({rows.length})
            </h1>
            <p className="mt-1 max-w-[75ch] text-sm text-gray-600">
              Cấu trúc <b>Dept. + Group</b> giống hệt sheet gốc. Thêm bộ phận mới ở đây sẽ{" "}
              <b>tự động xuất hiện trong dropdown</b> của Daily Application.
            </p>
          </div>
          <Button variant="gold" onClick={() => setOpen(true)} className="rounded-xl">
            + Thêm bộ phận
          </Button>
        </div>
      </div>

      <Card className="rounded-[18px] p-3">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="🔎 Tìm Dept / Group / Tên tiếng Việt / Người phụ trách..."
          className="h-11 rounded-xl"
        />
      </Card>

      <Card className="overflow-hidden rounded-[18px] border border-black/5 p-0 shadow-sm">
        <div className="flex items-center justify-between border-b bg-hasfarm-50 px-4 py-3">
          <p className="text-[11px] font-black uppercase tracking-widest text-hasfarm-800">
            Danh sách bộ phận
          </p>
          <Badge tone="gold">{filtered.length} dòng</Badge>
        </div>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-12 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
            </div>
          ) : (
            <div className="max-h-[64vh] overflow-auto">
              <table className="grid-sheet w-full text-[13px]">
                <thead className="sticky top-0 bg-[#0F3D23] text-white">
                  <tr>
                    {["STT", "Dept.", "Group", "Tên Tiếng Việt", "Phụ trách", "SĐT", "Quota", "Hôm nay", "Tổng", "TT", ""].map(
                      (h) => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-widest">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.id} className="hover:bg-hasfarm-50/50">
                      <td className="px-3 py-2 text-gray-400">{d.stt}</td>
                      <td className="px-3 py-2 font-black text-hasfarm-900">{d.deptName}</td>
                      <td className="px-3 py-2">
                        {d.groupName ? (
                          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-bold text-sky-800">
                            {d.groupName}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-700">{d.vnName ?? "—"}</td>
                      <td className="px-3 py-2">{d.supervisor ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">{d.supervisorPhone ?? "—"}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          defaultValue={d.dailyQuota}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v !== d.dailyQuota) void patch(d.id, { dailyQuota: v });
                          }}
                          className="w-16 rounded border-2 border-gray-200 px-2 py-1"
                        />
                      </td>
                      <td className="px-3 py-2 text-center font-black text-hasfarm-700">{d.assignedToday}</td>
                      <td className="px-3 py-2 text-center text-gray-500">{d.totalAssigned}</td>
                      <td className="px-3 py-2">
                        <button onClick={() => void patch(d.id, { isActive: !d.isActive })}>
                          <Badge tone={d.isActive ? "green" : "gray"}>{d.isActive ? "Bật" : "Khoá"}</Badge>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => void remove(d.id)}
                          className="text-xs font-bold text-red-600 hover:underline"
                        >
                          Xoá
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Thêm bộ phận mới" width="max-w-xl">
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label>Dept. (tên bộ phận) *</Label>
              <Input
                value={form.deptName}
                onChange={(e) => setForm({ ...form, deptName: e.target.value })}
                placeholder="VD: Chrysanth Spray"
                className="h-11 rounded-xl"
              />
            </div>
            <div>
              <Label>Group (nhóm — có thể để trống)</Label>
              <Input
                value={form.groupName}
                onChange={(e) => setForm({ ...form, groupName: e.target.value })}
                placeholder="VD: Fast H"
                className="h-11 rounded-xl"
              />
            </div>
          </div>
          <div>
            <Label>Tên Tiếng Việt</Label>
            <Input
              value={form.vnName}
              onChange={(e) => setForm({ ...form, vnName: e.target.value })}
              placeholder="VD: Cúc Fast nhóm thu hoạch"
              className="h-11 rounded-xl"
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label>Phụ trách lao động</Label>
              <Input
                value={form.supervisor}
                onChange={(e) => setForm({ ...form, supervisor: e.target.value })}
                className="h-11 rounded-xl"
              />
            </div>
            <div>
              <Label>SĐT phụ trách</Label>
              <Input
                value={form.supervisorPhone}
                onChange={(e) => setForm({ ...form, supervisorPhone: e.target.value })}
                className="h-11 rounded-xl"
              />
            </div>
          </div>
          <div>
            <Label>Link sheet riêng (nếu có)</Label>
            <Input
              value={form.sheetLink}
              onChange={(e) => setForm({ ...form, sheetLink: e.target.value })}
              placeholder="https://docs.google.com/..."
              className="h-11 rounded-xl"
            />
          </div>
          <div>
            <Label>Định mức lao động / ngày</Label>
            <Input
              type="number"
              value={form.dailyQuota}
              onChange={(e) => setForm({ ...form, dailyQuota: Number(e.target.value) })}
              className="h-11 w-32 rounded-xl"
            />
          </div>
          <Button variant="gold" size="lg" className="w-full rounded-xl" onClick={create}>
            Tạo bộ phận
          </Button>
        </div>
      </Modal>
    </div>
  );
}
