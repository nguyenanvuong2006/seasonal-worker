"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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
  location: string | null;
  division: string | null;
  deptName: string;
  section: string | null;
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
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<Dept[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [form, setForm] = useState({
    location: "",
    division: "",
    deptName: "",
    section: "",
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
        (r.location ?? "").toLowerCase().includes(s) ||
        (r.division ?? "").toLowerCase().includes(s) ||
        (r.section ?? "").toLowerCase().includes(s) ||
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
      toast({ title: "Đã thêm bộ phận — tự động cập nhật cơ cấu tổ chức" });
      setOpen(false);
      setForm({
        location: "",
        division: "",
        deptName: "",
        section: "",
        groupName: "",
        vnName: "",
        supervisor: "",
        supervisorPhone: "",
        sheetLink: "",
        dailyQuota: 0,
      });
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
        title={`Cơ cấu tổ chức — Bộ phận (${rows.length})`}
        description={
          <>
            Chuẩn hóa cơ cấu tổ chức Dalat Hasfarm: <b>Location → Division → Department → Section → Group</b>.
            Bộ phận tạo ở đây sẽ tự động hiển thị trong dropdown tiếp nhận Tập nghề và Data Scope.
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Thêm bộ phận
          </Button>
        }
      />

      <SearchBar value={q} onChange={setQ} placeholder="Tìm Location / Division / Dept / Section / Group / Tên tiếng Việt..." className="max-w-md" />

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-[13px] font-semibold text-fg">Danh sách cơ cấu bộ phận</p>
          <Badge tone="gray">{filtered.length} dòng</Badge>
        </div>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4">
              <SkeletonTable rows={6} cols={9} />
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
                    {["STT", "Location", "Division", "Department", "Section", "Group", "Tên Tiếng Việt", "Phụ trách", "SĐT", "Nhu cầu/ngày", "Hôm nay", "Tổng", "TT", ""].map(
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
                      <td className="px-3 py-2 text-xs text-fg-secondary">{d.location || "—"}</td>
                      <td className="px-3 py-2 text-xs text-fg-secondary">{d.division || "—"}</td>
                      <td className="px-3 py-2 font-semibold text-fg">{d.deptName}</td>
                      <td className="px-3 py-2 text-xs text-fg-secondary">{d.section || d.groupName || "—"}</td>
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

      <Modal open={open} onClose={() => setOpen(false)} title="Thêm bộ phận mới vào cơ cấu tổ chức" width="max-w-xl">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="Location (Trại / Vùng / Địa điểm)">
              <Input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="VD: Trại Đa Quý, VP Đà Lạt..."
              />
            </FormField>
            <FormField label="Division (Khối)">
              <Input
                value={form.division}
                onChange={(e) => setForm({ ...form, division: e.target.value })}
                placeholder="VD: Khối Sản Xuất, Khối Hậu Cần..."
              />
            </FormField>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="Department (Tên bộ phận)" required>
              <Input
                value={form.deptName}
                onChange={(e) => setForm({ ...form, deptName: e.target.value })}
                placeholder="VD: Chrysanth Spray"
              />
            </FormField>
            <FormField label="Section (Phân xưởng / Mảng)">
              <Input
                value={form.section}
                onChange={(e) => setForm({ ...form, section: e.target.value })}
                placeholder="VD: Thu hoạch, Đóng gói..."
              />
            </FormField>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="Group (Tổ / Nhóm)">
              <Input
                value={form.groupName}
                onChange={(e) => setForm({ ...form, groupName: e.target.value })}
                placeholder="VD: Fast H"
              />
            </FormField>
            <FormField label="Tên Tiếng Việt">
              <Input
                value={form.vnName}
                onChange={(e) => setForm({ ...form, vnName: e.target.value })}
                placeholder="VD: Cúc Fast nhóm thu hoạch"
              />
            </FormField>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="Phụ trách tiếp nhận">
              <Input value={form.supervisor} onChange={(e) => setForm({ ...form, supervisor: e.target.value })} />
            </FormField>
            <FormField label="SĐT phụ trách">
              <Input value={form.supervisorPhone} onChange={(e) => setForm({ ...form, supervisorPhone: e.target.value })} />
            </FormField>
          </div>
          <FormField label="Nhu cầu nhân lực dự kiến / ngày">
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
