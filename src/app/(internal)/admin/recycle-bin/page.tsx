"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, toast } from "@/components/ui";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";

type Item = { id: string; label: string; sub: string | null; deletedAt: string; deletedBy: string | null };
type Data = { departments: Item[]; dwData: Item[]; dailyApplications: Item[] };

const TABS: { key: keyof Data; table: string; label: string }[] = [
  { key: "dailyApplications", table: "daily_applications", label: "Daily Application" },
  { key: "dwData", table: "dw_data", label: "DW Data" },
  { key: "departments", table: "departments", label: "Department" },
];

export default function RecycleBinPage() {
  const [data, setData] = useState<Data>({ departments: [], dwData: [], dailyApplications: [] });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<keyof Data>("dailyApplications");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/recycle-bin");
    const d = await res.json();
    setData({ departments: d.departments ?? [], dwData: d.dwData ?? [], dailyApplications: d.dailyApplications ?? [] });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (table: string, id: string) => {
    const res = await fetch("/api/admin/recycle-bin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table, id }),
    });
    if (!res.ok) {
      toast({ title: "Khôi phục thất bại", variant: "destructive" });
      return;
    }
    toast({ title: "Đã khôi phục" });
    await load();
  };

  const purge = async (table: string, id: string) => {
    if (!confirm("Xoá VĨNH VIỄN — không thể hoàn tác. Tiếp tục?")) return;
    const res = await fetch(`/api/admin/recycle-bin?table=${table}&id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast({ title: "Xoá thất bại", variant: "destructive" });
      return;
    }
    toast({ title: "Đã xoá vĩnh viễn" });
    await load();
  };

  const active = TABS.find((t) => t.key === tab)!;
  const items = data[tab];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-fg">Thùng rác (Recycle Bin)</h1>
        <p className="text-sm text-fg-secondary">
          Mọi hồ sơ bị “Xoá” trong hệ thống chỉ bị ẩn (xoá mềm) — dữ liệu vẫn còn ở đây và có thể khôi phục bất cứ lúc
          nào. Chỉ “Xoá vĩnh viễn” mới thật sự xoá khỏi database.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-full px-4 py-2 text-sm font-bold transition ${
              tab === t.key ? "bg-primary text-white" : "bg-surface-hover text-fg-secondary hover:bg-border"
            }`}
          >
            {t.label} ({data[t.key].length})
          </button>
        ))}
      </div>

      <Card className="p-0">
        <CardHeader title={active.label} subtitle="Sắp xếp theo thời gian xoá gần nhất" />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <ul className="divide-y">
              {items.length === 0 && <li className="p-8 text-center text-sm text-fg-muted">Thùng rác trống.</li>}
              {items.map((it) => (
                <li key={it.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-[200px] flex-1">
                    <p className="font-bold text-fg">{it.label}</p>
                    <p className="text-xs text-fg-secondary">
                      {it.sub} · Xoá bởi <b>{it.deletedBy ?? "—"}</b> lúc {new Date(it.deletedAt).toLocaleString("vi-VN")}
                    </p>
                  </div>
                  <Badge tone="amber">Đã xoá</Badge>
                  <Button variant="subtle" className="gap-1" onClick={() => restore(active.table, it.id)}>
                    <RotateCcw className="h-4 w-4" /> Khôi phục
                  </Button>
                  <button
                    onClick={() => purge(active.table, it.id)}
                    className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Xoá vĩnh viễn
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
