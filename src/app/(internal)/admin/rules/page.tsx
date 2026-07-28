"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, Input, Label, Modal, toast } from "@/components/ui";
import { Loader2 } from "lucide-react";

type Condition = { field: string; op: string; value: string };
type Action = { type: string; value: string };
type RuleRow = {
  id: string;
  name: string;
  trigger: string;
  conditions: Condition[];
  actions: Action[];
  sortOrder: number;
  isActive: boolean;
};

const FIELDS = [
  { key: "age", label: "Tuổi" },
  { key: "gender", label: "Giới tính" },
  { key: "ethnicity", label: "Dân tộc" },
  { key: "dwMatch", label: "Cũ/Mới (đối chiếu DW)" },
  { key: "declaredType", label: "Cũ/Mới (tự khai)" },
  { key: "deptName", label: "Bộ phận" },
];
const OPS = [
  { key: "eq", label: "=" },
  { key: "neq", label: "≠" },
  { key: "gt", label: ">" },
  { key: "gte", label: "≥" },
  { key: "lt", label: "<" },
  { key: "lte", label: "≤" },
  { key: "contains", label: "chứa" },
];
const ACTIONS = [
  { key: "SET_STATUS", label: "Đặt trạng thái" },
  { key: "FLAG_NOTE", label: "Thêm ghi chú cảnh báo" },
];
const TRIGGERS = [
  { key: "ON_REGISTER", label: "Khi lao động đăng ký (public form)" },
  { key: "ON_APPROVE", label: "Khi HR duyệt hồ sơ" },
];

export default function RulesPage() {
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    trigger: "ON_REGISTER",
    conditions: [{ field: "age", op: "gt", value: "60" }] as Condition[],
    actions: [{ type: "SET_STATUS", value: "WAITLIST" }] as Action[],
  });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/rules");
    const data = await res.json();
    setRows(data.rows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (id: string, isActive: boolean) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, isActive } : r)));
    await fetch("/api/admin/rules", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, isActive }),
    });
  };

  const remove = async (id: string) => {
    if (!confirm("Xoá rule này?")) return;
    await fetch(`/api/admin/rules?id=${id}`, { method: "DELETE" });
    toast({ title: "Đã xoá rule" });
    await load();
  };

  const create = async () => {
    const res = await fetch("/api/admin/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) {
      toast({ title: data.error ?? "Lỗi tạo rule", variant: "destructive" });
      return;
    }
    toast({ title: "✅ Đã thêm rule" });
    setOpen(false);
    setForm({ name: "", trigger: "ON_REGISTER", conditions: [{ field: "age", op: "gt", value: "60" }], actions: [{ type: "SET_STATUS", value: "WAITLIST" }] });
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-hasfarm-900">Rule Engine (IF → THEN)</h1>
          <p className="text-sm text-gray-500">
            1 rule = nhiều điều kiện nối bằng AND. Cần hiệu ứng OR → tạo nhiều rule riêng cùng “Thời điểm áp dụng”.
            Chạy khi lao động đăng ký hoặc khi HR duyệt — không cần sửa code.
          </p>
        </div>
        <Button variant="gold" onClick={() => setOpen(true)}>
          + Thêm rule
        </Button>
      </div>

      <Card className="p-0">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
            </div>
          ) : (
            <ul className="divide-y">
              {rows.length === 0 && <li className="p-8 text-center text-sm text-gray-400">Chưa có rule nào.</li>}
              {rows.map((r) => (
                <li key={r.id} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold text-hasfarm-900">{r.name}</p>
                    <Badge tone="gray">{TRIGGERS.find((t) => t.key === r.trigger)?.label ?? r.trigger}</Badge>
                    <button onClick={() => toggle(r.id, !r.isActive)}>
                      <Badge tone={r.isActive ? "green" : "gray"}>{r.isActive ? "Đang bật" : "Đã tắt"}</Badge>
                    </button>
                    <button onClick={() => remove(r.id)} className="text-xs font-bold text-red-600 hover:underline">
                      Xoá
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    NẾU {r.conditions.map((c) => `${FIELDS.find((f) => f.key === c.field)?.label ?? c.field} ${OPS.find((o) => o.key === c.op)?.label ?? c.op} "${c.value}"`).join(" VÀ ")}
                    {" → "}
                    {r.actions.map((a) => `${ACTIONS.find((x) => x.key === a.type)?.label ?? a.type} = "${a.value}"`).join(", ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Thêm rule mới" width="max-w-2xl">
        <div className="space-y-3">
          <div>
            <Label>Tên rule *</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="vd: Cảnh báo lao động lớn tuổi" className="h-11" />
          </div>
          <div>
            <Label>Thời điểm áp dụng</Label>
            <select value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })} className="h-11 w-full rounded-xl border-2 border-gray-200 px-2 font-semibold">
              {TRIGGERS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label>Điều kiện (tất cả phải đúng)</Label>
            {form.conditions.map((c, i) => (
              <div key={i} className="mb-2 flex gap-2">
                <select
                  value={c.field}
                  onChange={(e) => {
                    const next = [...form.conditions];
                    next[i] = { ...c, field: e.target.value };
                    setForm({ ...form, conditions: next });
                  }}
                  className="h-10 flex-1 rounded-lg border-2 border-gray-200 px-2 text-sm"
                >
                  {FIELDS.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <select
                  value={c.op}
                  onChange={(e) => {
                    const next = [...form.conditions];
                    next[i] = { ...c, op: e.target.value };
                    setForm({ ...form, conditions: next });
                  }}
                  className="h-10 w-20 rounded-lg border-2 border-gray-200 px-2 text-sm"
                >
                  {OPS.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  value={c.value}
                  onChange={(e) => {
                    const next = [...form.conditions];
                    next[i] = { ...c, value: e.target.value };
                    setForm({ ...form, conditions: next });
                  }}
                  className="h-10 flex-1 rounded-lg border-2 border-gray-200 px-2 text-sm"
                />
                <button
                  onClick={() => setForm({ ...form, conditions: form.conditions.filter((_, idx) => idx !== i) })}
                  className="text-red-500"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={() => setForm({ ...form, conditions: [...form.conditions, { field: "age", op: "eq", value: "" }] })}
              className="text-xs font-bold text-hasfarm-700 hover:underline"
            >
              + Thêm điều kiện
            </button>
          </div>

          <div>
            <Label>Hành động</Label>
            {form.actions.map((a, i) => (
              <div key={i} className="mb-2 flex gap-2">
                <select
                  value={a.type}
                  onChange={(e) => {
                    const next = [...form.actions];
                    next[i] = { ...a, type: e.target.value };
                    setForm({ ...form, actions: next });
                  }}
                  className="h-10 flex-1 rounded-lg border-2 border-gray-200 px-2 text-sm"
                >
                  {ACTIONS.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <input
                  value={a.value}
                  onChange={(e) => {
                    const next = [...form.actions];
                    next[i] = { ...a, value: e.target.value };
                    setForm({ ...form, actions: next });
                  }}
                  placeholder="giá trị"
                  className="h-10 flex-1 rounded-lg border-2 border-gray-200 px-2 text-sm"
                />
                <button
                  onClick={() => setForm({ ...form, actions: form.actions.filter((_, idx) => idx !== i) })}
                  className="text-red-500"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={() => setForm({ ...form, actions: [...form.actions, { type: "SET_STATUS", value: "" }] })}
              className="text-xs font-bold text-hasfarm-700 hover:underline"
            >
              + Thêm hành động
            </button>
          </div>

          <Button variant="gold" size="lg" className="w-full" onClick={create}>
            Lưu rule
          </Button>
        </div>
      </Modal>
    </div>
  );
}
