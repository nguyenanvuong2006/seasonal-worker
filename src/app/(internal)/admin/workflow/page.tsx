"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, Input, Label, Modal, toast } from "@/components/ui";
import { Loader2 } from "lucide-react";

type Stage = {
  id: string;
  entityType: string;
  stageKey: string;
  label: string;
  color: string;
  sortOrder: number;
  isStart: boolean;
  isEnd: boolean;
  allowedRoles: string[];
  isActive: boolean;
};

const COLORS = ["gray", "green", "amber", "red", "blue", "gold"];
const ROLES = ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"];
const ENTITIES: { key: string; label: string }[] = [
  { key: "daily_application", label: "Daily Application (Đăng ký hằng ngày)" },
  { key: "resignation", label: "Workforce Movement — Nghỉ việc" },
  { key: "transfer", label: "Workforce Movement — Thuyên chuyển" },
];

export default function WorkflowPage() {
  const [rows, setRows] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [entity, setEntity] = useState(ENTITIES[0].key);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ stageKey: "", label: "", color: "gray", sortOrder: 10 });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/workflow");
    const data = await res.json();
    setRows(data.rows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (id: string, body: Partial<Stage>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...body } : r)));
    const res = await fetch("/api/admin/workflow", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    if (!res.ok) {
      toast({ title: "Lưu thất bại", variant: "destructive" });
      await load();
    }
  };

  const create = async () => {
    const res = await fetch("/api/admin/workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, entityType: entity }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast({ title: data.error ?? "Lỗi tạo bước", variant: "destructive" });
      return;
    }
    toast({ title: "✅ Đã thêm bước quy trình" });
    setOpen(false);
    setForm({ stageKey: "", label: "", color: "gray", sortOrder: 10 });
    await load();
  };

  const remove = async (id: string) => {
    if (!confirm("Xoá bước này? Hồ sơ đang ở trạng thái này sẽ không hiển thị đúng tên/màu nữa.")) return;
    const res = await fetch(`/api/admin/workflow?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json();
      toast({ title: d.error, variant: "destructive" });
      return;
    }
    toast({ title: "Đã xoá bước" });
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-hasfarm-900">Quy trình xử lý hồ sơ (Workflow Engine)</h1>
          <p className="text-sm text-gray-500">
            Chọn quy trình bên dưới rồi cấu hình các bước hợp lệ (trạng thái/màu/thứ tự/vai trò được xử lý) — dùng
            chung 1 Workflow Engine cho mọi luồng, không viết state machine riêng cho từng module.
          </p>
        </div>
        <Button variant="gold" onClick={() => setOpen(true)}>
          + Thêm bước
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {ENTITIES.map((e) => (
          <button
            key={e.key}
            onClick={() => setEntity(e.key)}
            className={`rounded-full px-4 py-2 text-sm font-bold transition ${
              entity === e.key ? "bg-hasfarm-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {e.label}
          </button>
        ))}
      </div>

      <Card className="p-0">
        <CardHeader title="Các bước hiện có" subtitle="Kéo số Thứ tự để đổi vị trí hiển thị" />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
            </div>
          ) : (
            <ul className="divide-y">
              {rows.filter((s) => s.entityType === entity).length === 0 && (
                <li className="p-8 text-center text-sm text-gray-400">Chưa có bước nào cho quy trình này.</li>
              )}
              {rows
                .filter((s) => s.entityType === entity)
                .map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-3 p-4">
                  <Badge tone={s.color as "gray" | "green" | "amber" | "red" | "gold" | "blue"}>{s.label}</Badge>
                  <span className="font-mono text-xs text-gray-400">{s.stageKey}</span>
                  <select
                    value={s.color}
                    onChange={(e) => patch(s.id, { color: e.target.value })}
                    className="rounded border-2 border-gray-200 px-2 py-1 text-xs"
                  >
                    {COLORS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => patch(s.id, { isStart: !s.isStart })}>
                    <Badge tone={s.isStart ? "green" : "gray"}>Bước bắt đầu</Badge>
                  </button>
                  <button onClick={() => patch(s.id, { isEnd: !s.isEnd })}>
                    <Badge tone={s.isEnd ? "green" : "gray"}>Bước kết thúc</Badge>
                  </button>
                  <div className="flex flex-wrap gap-1">
                    {ROLES.map((r) => (
                      <button
                        key={r}
                        onClick={() => {
                          const has = s.allowedRoles.includes(r);
                          patch(s.id, { allowedRoles: has ? s.allowedRoles.filter((x) => x !== r) : [...s.allowedRoles, r] });
                        }}
                        className={`rounded-full px-2 py-1 text-[10px] font-bold ${
                          s.allowedRoles.includes(r) ? "bg-hasfarm-700 text-white" : "bg-gray-100 text-gray-400"
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    defaultValue={s.sortOrder}
                    title="Thứ tự"
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== s.sortOrder) patch(s.id, { sortOrder: v });
                    }}
                    className="w-16 rounded border-2 border-gray-200 px-2 py-1 text-sm"
                  />
                  <button onClick={() => remove(s.id)} className="text-xs font-bold text-red-600 hover:underline">
                    Xoá
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Thêm bước quy trình mới">
        <div className="space-y-3">
          <div>
            <Label>Mã bước (lưu vào cột status) *</Label>
            <Input value={form.stageKey} onChange={(e) => setForm({ ...form, stageKey: e.target.value })} placeholder="vd: INTERVIEW" className="h-11 font-mono" />
          </div>
          <div>
            <Label>Tên hiển thị *</Label>
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="vd: Phỏng vấn" className="h-11" />
          </div>
          <div>
            <Label>Màu</Label>
            <select value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="h-11 w-full rounded-xl border-2 border-gray-200 px-2 font-semibold">
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <Button variant="gold" size="lg" className="w-full" onClick={create}>
            Lưu bước
          </Button>
        </div>
      </Modal>
    </div>
  );
}
