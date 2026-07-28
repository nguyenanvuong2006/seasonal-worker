"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardContent, CardHeader, Input, Label, Modal, toast } from "@/components/ui";
import { Loader2 } from "lucide-react";

type Widget = {
  id: string;
  title: string;
  widgetType: "KPI" | "TABLE";
  config: { metric?: string };
  value?: number;
  table?: { headers: string[]; rows: string[][] };
};

const METRICS = [
  { key: "today_registrations", label: "Đăng ký hôm nay" },
  { key: "pending_count", label: "Đang chờ duyệt" },
  { key: "approved_count", label: "Đã duyệt (tổng)" },
  { key: "dw_data_total", label: "Tổng lao động trong DW Data" },
];

export default function DashboardPage() {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", widgetType: "KPI" as "KPI" | "TABLE", metric: "today_registrations" });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/dashboard");
    const data = await res.json();
    setWidgets(data.rows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const res = await fetch("/api/admin/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title,
        widgetType: form.widgetType,
        config: form.widgetType === "KPI" ? { metric: form.metric } : {},
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast({ title: data.error ?? "Lỗi tạo widget", variant: "destructive" });
      return;
    }
    toast({ title: "✅ Đã thêm widget" });
    setOpen(false);
    setForm({ title: "", widgetType: "KPI", metric: "today_registrations" });
    await load();
  };

  const remove = async (id: string) => {
    await fetch(`/api/admin/dashboard?id=${id}`, { method: "DELETE" });
    toast({ title: "Đã xoá widget" });
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-hasfarm-900">Dashboard (nền tảng)</h1>
          <p className="text-sm text-gray-500">
            Widget KPI/Table đọc dữ liệu qua Metadata Engine — thêm cột ở /admin/field-definitions sẽ tự có trên
            widget Table. Chưa có trình kéo-thả biểu đồ — đây là phiên bản nền tảng.
          </p>
        </div>
        <Button variant="gold" onClick={() => setOpen(true)}>
          + Thêm widget
        </Button>
      </div>

      {loading ? (
        <div className="p-10 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {widgets.map((w) => (
            <Card key={w.id} className={w.widgetType === "TABLE" ? "lg:col-span-3" : ""}>
              <CardHeader
                title={
                  <span className="flex items-center justify-between">
                    {w.title}
                    <button onClick={() => remove(w.id)} className="text-xs font-bold text-red-500 hover:underline">
                      Xoá
                    </button>
                  </span>
                }
              />
              <CardContent>
                {w.widgetType === "KPI" ? (
                  <p className="text-4xl font-black text-hasfarm-900">{w.value ?? 0}</p>
                ) : (
                  w.table && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr>
                            {w.table.headers.map((h) => (
                              <th key={h} className="border-b px-2 py-1 text-left font-bold text-gray-500">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {w.table.rows.map((row, i) => (
                            <tr key={i} className="border-b last:border-0">
                              {row.map((c, j) => (
                                <td key={j} className="px-2 py-1">
                                  {c}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Thêm widget">
        <div className="space-y-3">
          <div>
            <Label>Tiêu đề *</Label>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="h-11" />
          </div>
          <div>
            <Label>Loại widget</Label>
            <select
              value={form.widgetType}
              onChange={(e) => setForm({ ...form, widgetType: e.target.value as "KPI" | "TABLE" })}
              className="h-11 w-full rounded-xl border-2 border-gray-200 px-2 font-semibold"
            >
              <option value="KPI">KPI (số đếm)</option>
              <option value="TABLE">Table (bảng gần nhất)</option>
            </select>
          </div>
          {form.widgetType === "KPI" && (
            <div>
              <Label>Chỉ số</Label>
              <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })} className="h-11 w-full rounded-xl border-2 border-gray-200 px-2 font-semibold">
                {METRICS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button variant="gold" size="lg" className="w-full" onClick={create}>
            Lưu widget
          </Button>
        </div>
      </Modal>
    </div>
  );
}
