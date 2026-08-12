"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  SearchBar,
  SkeletonTable,
  toast,
} from "@/components/ui";
import { Building2, Plus } from "lucide-react";

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
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
    try {
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
      toast({ title: "Đã thêm bộ phận — tự động vào dropdown Daily Application" });
      setOpen(false);
      setForm({ deptName: "", groupName: "", vnName: "", supervisor: "", supervisorPhone: "", sheetLink: "", dailyQuota: 0 });
      await load();
    } finally {
      setSaving(false);
    }
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
      <PageHeader
        title={`Bộ phận & Nhóm (${rows.length})`}
        description={
          <>
            Cấu trúc <b>Dept. + Group</b> giống hệt sheet gốc. Thêm bộ phận mới ở đây sẽ <b>tự động xuất hiện trong dropdown</b>{" "}
            của Daily Application.
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Thêm bộ phận
          </Button>
        }
      />

      <SearchBar value={q} onChange={setQ} placeholder="Tìm Dept / Group / Tên tiếng Việt / Người phụ trách..." className="max-w-md" />

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-[13px] font-semibold text-fg">Danh sách bộ phận</p>
          <Badge tone="gray">{filtered.length} dòng</Badge>
        </div>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4">
              <SkeletonTable rows={6} cols={8} />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Building2 className="h-5 w-5" aria-hidden />}
              title="Không có bộ phận nào"
              description={q ? `Không tìm thấy kết quả khớp với "${q}".` : "Chưa có bộ phận nào được tạo."}
            />
          ) : (
            <div className="max-h-[64vh] overflow-auto">
              <table className="grid-sheet w-full text-[13px]">
                <thead className="sticky top-0 bg-primary text-white">
                  <tr>
                    {["STT", "Dept.", "Group", "Tên Tiếng Việt", "Phụ trách", "SĐT", "Quota", "Hôm nay", "Tổng", "TT", ""].map(
                      (h) => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.id} className="border-b border-border transition-colors hover:bg-surface-hover">
                      <td className="px-3 py-2 text-fg-muted">{d.stt}</td>
                      <td className="px-3 py-2 font-semibold text-fg">{d.deptName}</td>
                      <td className="px-3 py-2">{d.groupName ? <Badge tone="blue">{d.groupName}</Badge> : <span className="text-fg-muted">—</span>}</td>
                      <td className="px-3 py-2 text-fg-secondary">{d.vnName ?? "—"}</td>
                      <td className="px-3 py-2 text-fg-secondary">{d.supervisor ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-fg-secondary">{d.supervisorPhone ?? "—"}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          defaultValue={d.dailyQuota}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v !== d.dailyQuota) void patch(d.id, { dailyQuota: v });
                          }}
                          className="w-16 rounded-[6px] border border-border-strong bg-surface px-2 py-1 text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                        />
                      </td>
                      <td className="px-3 py-2 text-center font-semibold text-primary">{d.assignedToday}</td>
                      <td className="px-3 py-2 text-center text-fg-secondary">{d.totalAssigned}</td>
                      <td className="px-3 py-2">
                        <button onClick={() => void patch(d.id, { isActive: !d.isActive })}>
                          <Badge tone={d.isActive ? "green" : "gray"} dot>{d.isActive ? "Bật" : "Khoá"}</Badge>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => void remove(d.id)}
                          className="text-xs font-semibold text-danger hover:underline"
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
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Dept. (tên bộ phận)" required>
              <Input
                value={form.deptName}
                onChange={(e) => setForm({ ...form, deptName: e.target.value })}
                placeholder="VD: Chrysanth Spray"
              />
            </FormField>
            <FormField label="Group (nhóm — có thể để trống)">
              <Input
                value={form.groupName}
                onChange={(e) => setForm({ ...form, groupName: e.target.value })}
                placeholder="VD: Fast H"
              />
            </FormField>
          </div>
          <FormField label="Tên Tiếng Việt">
            <Input
              value={form.vnName}
              onChange={(e) => setForm({ ...form, vnName: e.target.value })}
              placeholder="VD: Cúc Fast nhóm thu hoạch"
            />
          </FormField>
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Phụ trách lao động">
              <Input value={form.supervisor} onChange={(e) => setForm({ ...form, supervisor: e.target.value })} />
            </FormField>
            <FormField label="SĐT phụ trách">
              <Input value={form.supervisorPhone} onChange={(e) => setForm({ ...form, supervisorPhone: e.target.value })} />
            </FormField>
          </div>
          <FormField label="Link sheet riêng (nếu có)">
            <Input
              value={form.sheetLink}
              onChange={(e) => setForm({ ...form, sheetLink: e.target.value })}
              placeholder="https://docs.google.com/..."
            />
          </FormField>
          <FormField label="Định mức lao động / ngày">
            <Input
              type="number"
              value={form.dailyQuota}
              onChange={(e) => setForm({ ...form, dailyQuota: Number(e.target.value) })}
              className="w-32"
            />
          </FormField>
          <Button variant="primary" size="lg" className="w-full" loading={saving} disabled={!form.deptName.trim()} onClick={create}>
            Tạo bộ phận
          </Button>
        </div>
      </Modal>
    </div>
  );
}
