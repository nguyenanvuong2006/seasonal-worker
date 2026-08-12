"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  FormField,
  Input,
  Modal,
  Skeleton,
  toast,
} from "@/components/ui";
import { LayoutGrid, Plus, Trash2 } from "lucide-react";

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

function WidgetSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-[14px] border border-border bg-surface p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-9 w-16" />
        </div>
      ))}
    </div>
  );
}

export default function DashboardWidgets() {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
    try {
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
      toast({ title: "Đã thêm widget" });
      setOpen(false);
      setForm({ title: "", widgetType: "KPI", metric: "today_registrations" });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/admin/dashboard?id=${id}`, { method: "DELETE" });
    toast({ title: "Đã xoá widget" });
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Thêm widget
        </Button>
      </div>

      {loading ? (
        <WidgetSkeleton />
      ) : widgets.length === 0 ? (
        <Card>
          <EmptyState
            icon={<LayoutGrid className="h-5 w-5" aria-hidden />}
            title="Chưa có widget nào"
            description="Thêm widget KPI hoặc Table để theo dõi số liệu bạn quan tâm."
            action={
              <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
                <Plus className="h-4 w-4" /> Thêm widget
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {widgets.map((w) => (
            <Card key={w.id} className={w.widgetType === "TABLE" ? "lg:col-span-3" : ""}>
              <CardHeader
                title={
                  <span className="flex items-center justify-between">
                    {w.title}
                    <button
                      onClick={() => remove(w.id)}
                      aria-label={`Xoá widget ${w.title}`}
                      className="text-fg-muted transition-colors hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                }
              />
              <CardContent>
                {w.widgetType === "KPI" ? (
                  <p className="text-[32px] font-bold leading-none tabular-nums text-fg">{w.value ?? 0}</p>
                ) : (
                  w.table && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr>
                            {w.table.headers.map((h) => (
                              <th key={h} className="border-b border-border px-2 py-1.5 text-left font-semibold text-fg-muted">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {w.table.rows.map((row, i) => (
                            <tr key={i} className="border-b border-border last:border-0">
                              {row.map((c, j) => (
                                <td key={j} className="px-2 py-1.5 text-fg-secondary">
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
        <div className="space-y-4">
          <FormField label="Tiêu đề" required>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </FormField>
          <FormField label="Loại widget">
            <select
              value={form.widgetType}
              onChange={(e) => setForm({ ...form, widgetType: e.target.value as "KPI" | "TABLE" })}
              className="h-10 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-[14px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            >
              <option value="KPI">KPI (số đếm)</option>
              <option value="TABLE">Table (bảng gần nhất)</option>
            </select>
          </FormField>
          {form.widgetType === "KPI" && (
            <FormField label="Chỉ số">
              <select
                value={form.metric}
                onChange={(e) => setForm({ ...form, metric: e.target.value })}
                className="h-10 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-[14px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
              >
                {METRICS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </FormField>
          )}
          <Button variant="primary" size="lg" className="w-full" loading={saving} disabled={!form.title.trim()} onClick={create}>
            Lưu widget
          </Button>
        </div>
      </Modal>
    </div>
  );
}
