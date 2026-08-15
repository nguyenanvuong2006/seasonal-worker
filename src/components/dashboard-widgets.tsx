"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  EmptyState,
  FormField,
  Input,
  Modal,
  NumberTile,
  Skeleton,
  toast,
} from "@/components/ui";
import {
  BarChart3,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  LayoutGrid,
  Plus,
  Trash2,
  UserPlus2,
} from "lucide-react";

type Widget = {
  id: string;
  title: string;
  widgetType: "KPI" | "TABLE";
  config: { metric?: string };
  value?: number | null;
  table?: { headers: string[]; rows: string[][] };
};

const METRICS = [
  { key: "today_registrations", label: "Đăng ký hôm nay" },
  { key: "pending_count", label: "Đang chờ duyệt" },
  { key: "approved_count", label: "Đã duyệt (tổng)" },
  { key: "dw_data_total", label: "Tổng lao động trong DW Data" },
];

const METRIC_META: Record<string, { icon: React.ReactNode; tone: "primary" | "success" | "warning" | "info" | "accent" }> = {
  today_registrations: { icon: <FileText className="h-4 w-4" aria-hidden />, tone: "primary" },
  pending_count: { icon: <Clock className="h-4 w-4" aria-hidden />, tone: "warning" },
  approved_count: { icon: <CheckCircle2 className="h-4 w-4" aria-hidden />, tone: "success" },
  dw_data_total: { icon: <Database className="h-4 w-4" aria-hidden />, tone: "info" },
};

const TONE_CYCLE: ("primary" | "success" | "warning" | "info" | "accent")[] = ["primary", "success", "warning", "info", "accent"];

function WidgetSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-[16px] border border-border bg-surface p-5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="mt-4 h-8 w-14" />
          <Skeleton className="mt-2 h-3 w-28" />
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
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12.5px] text-fg-muted">
          Widget KPI/Table đọc dữ liệu qua Metadata Engine — thêm cột ở /admin/field-definitions sẽ tự có trên widget Table.
        </p>
        <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
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
        <div className="space-y-4">
          {/* KPI widgets → number tiles (only the user-configured ones) */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {widgets
              .filter((w) => w.widgetType === "KPI")
              .map((w, i) => {
                const meta = METRIC_META[String(w.config?.metric ?? "")] ?? { icon: <BarChart3 className="h-4 w-4" aria-hidden />, tone: TONE_CYCLE[i % TONE_CYCLE.length] };
                const metricLabel = METRICS.find((m) => m.key === w.config?.metric)?.label;
                return (
                  <div key={w.id} className="group relative">
                    <NumberTile
                      icon={meta.icon}
                      label={w.title}
                      value={w.value === null || w.value === undefined ? "—" : w.value.toLocaleString("vi-VN")}
                      context={metricLabel ? `Chỉ số: ${metricLabel}` : undefined}
                      tone={meta.tone}
                    />
                    <button
                      onClick={() => remove(w.id)}
                      aria-label={`Xoá widget ${w.title}`}
                      className="absolute right-2 top-2 rounded-full bg-surface-hover p-1.5 text-fg-muted opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
          </div>

          {/* TABLE widgets → full-width operational table */}
          {widgets
            .filter((w) => w.widgetType === "TABLE")
            .map((w) => (
              <Card key={w.id} className="overflow-hidden p-0">
                <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
                  <p className="text-[13.5px] font-bold text-fg">{w.title}</p>
                  <button
                    onClick={() => remove(w.id)}
                    aria-label={`Xoá widget ${w.title}`}
                    className="rounded-full p-1.5 text-fg-muted transition-colors hover:bg-danger-tint hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {w.table && w.table.headers.length > 0 ? (
                  <div className="v2-scroll max-h-[360px] overflow-auto">
                    <table className="grid-sheet w-full text-[13px]">
                      <thead className="sticky top-0 z-10 bg-primary-tint/90 backdrop-blur">
                        <tr>
                          {w.table.headers.map((h) => (
                            <th key={h} className="whitespace-nowrap px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {w.table.rows.map((row, i) => (
                          <tr key={i} className="border-b border-border bg-surface transition-colors last:border-0 hover:bg-botanical-50">
                            {row.map((c, j) => (
                              <td key={j} className="px-3 py-2 text-fg-secondary">
                                {c}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-5 py-6 text-[13px] text-fg-muted">
                    <UserPlus2 className="h-4 w-4" aria-hidden /> Chưa có dữ liệu cho bảng này.
                  </div>
                )}
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
              className="h-10 w-full rounded-[10px] border border-border-strong bg-surface-raised px-3 text-[14px] font-medium text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
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
                className="h-10 w-full rounded-[10px] border border-border-strong bg-surface-raised px-3 text-[14px] font-medium text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
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
