"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Input, MetricStrip, MetricStripItem, PageHeader, SkeletonTable } from "@/components/ui";
import { formatDate, todayStr } from "@/lib/helpers";
import { Calendar, Download, RefreshCw, Search, UtensilsCrossed } from "lucide-react";

type Row = {
  dailyApplicationId: string;
  cccd: string;
  fullName: string;
  phone: string;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  startingDate: string | null;
  code: string | null;
};

type DeptOption = { id: string; deptName: string; groupName: string | null };

export default function MealExportPage() {
  const [date, setDate] = useState(todayStr());
  const [deptId, setDeptId] = useState("");
  const [q, setQ] = useState("");
  const [depts, setDepts] = useState<DeptOption[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/departments");
        const data = await res.json();
        if (res.ok) setDepts(data.rows ?? []);
      } catch {
        // Bộ lọc bộ phận là tiện ích phụ — lỗi tải không chặn danh sách báo cơm chính.
      }
    })();
  }, []);

  const load = useCallback(async (d: string, dept: string, query: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ date: d });
      if (dept) params.set("deptId", dept);
      if (query.trim()) params.set("q", query.trim());
      const res = await fetch(`/api/meal?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Không tải được danh sách.");
        setRows(null);
        return;
      }
      setRows(data.rows ?? []);
    } catch {
      setError("Không kết nối được máy chủ.");
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date, deptId, q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, deptId]);

  // Tìm nhanh: debounce để không gọi API theo từng ký tự gõ.
  useEffect(() => {
    const timer = setTimeout(() => void load(date, deptId, q), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const exportHref = (() => {
    const params = new URLSearchParams({ date });
    if (deptId) params.set("deptId", deptId);
    if (q.trim()) params.set("q", q.trim());
    return `/api/meal/export?${params.toString()}`;
  })();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Báo cơm"
        description="Danh sách lao động đủ điều kiện báo cơm: đã nhập DW Data VÀ đã có Mã số công nhật. Không yêu cầu IT CODE."
      />

      <MetricStrip
        items={[
          <MetricStripItem key="total" icon={<UtensilsCrossed className="h-4 w-4" />} value={rows?.length ?? 0} label="Đủ điều kiện báo cơm" context={formatDate(date)} tone="primary" />,
        ]}
      />

      <Card className="p-3">
        <div className="flex flex-wrap items-end gap-2.5">
          <div>
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">Ngày</p>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-10 w-40" />
          </div>
          <div>
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">Bộ phận</p>
            <select
              value={deptId}
              onChange={(e) => setDeptId(e.target.value)}
              className="h-10 rounded-[10px] border border-border-strong bg-surface px-3 text-[13px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            >
              <option value="">Tất cả bộ phận</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.deptName}
                  {d.groupName ? ` — ${d.groupName}` : ""}
                </option>
              ))}
            </select>
          </div>
          <Button variant="outline" className="h-10" onClick={() => setDate(todayStr())}>
            <Calendar className="h-4 w-4" /> Về hôm nay
          </Button>
          <Button variant="outline" className="h-10" onClick={() => void load(date, deptId, q)}>
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Tải lại
          </Button>
          <div className="min-w-[180px] flex-1">
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">Tìm nhanh</p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tên / CCCD / Mã công nhật" className="h-10 pl-9" />
            </div>
          </div>
          <a
            href={exportHref}
            className="inline-flex h-10 items-center gap-1.5 rounded-[10px] bg-primary px-4 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover"
          >
            <Download className="h-4 w-4" /> Xuất danh sách báo cơm
          </a>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="p-4">
            <SkeletonTable rows={6} cols={6} />
          </div>
        ) : error ? (
          <ErrorState description={error} onRetry={() => void load(date, deptId, q)} />
        ) : !rows || rows.length === 0 ? (
          <EmptyState
            title="Chưa có lao động nào đủ điều kiện báo cơm"
            description="Danh sách chỉ gồm lao động đã nhập DW Data và đã có Mã số công nhật trong ngày đã chọn."
          />
        ) : (
          <div className="v2-scroll max-h-[65vh] overflow-auto">
            <table className="grid-sheet w-full border-collapse text-[13px]">
              <thead className="sticky top-0 z-10 bg-primary-tint/95 backdrop-blur">
                <tr>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">STT</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Mã số công nhật</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Họ và tên</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">CCCD</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Bộ phận</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Ngày nhận việc</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={r.dailyApplicationId} className="border-b border-border/70 bg-surface hover:bg-botanical-50">
                    <td className="px-3 py-1.5 text-fg-muted">{idx + 1}</td>
                    <td className="px-3 py-1.5">
                      <Badge tone="green">{r.code}</Badge>
                    </td>
                    <td className="px-3 py-1.5 font-semibold text-fg">{r.fullName}</td>
                    <td className="px-3 py-1.5 font-mono">{r.cccd}</td>
                    <td className="px-3 py-1.5 text-[12px] text-fg-secondary">
                      {r.deptName ?? "—"}
                      {r.groupName ? ` — ${r.groupName}` : ""}
                    </td>
                    <td className="px-3 py-1.5 text-[12px]">{r.startingDate ? formatDate(r.startingDate) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
