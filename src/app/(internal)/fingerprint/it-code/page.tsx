"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  MetricStrip,
  MetricStripItem,
  PageHeader,
  SkeletonTable,
  toast,
} from "@/components/ui";
import { formatDate, todayStr } from "@/lib/helpers";
import { Calendar, CheckCircle2, RefreshCw, ScanFace } from "lucide-react";

type Row = {
  dailyApplicationId: string;
  cccd: string;
  fullName: string;
  deptName: string | null;
  groupName: string | null;
  dwDataId: string;
  code: string | null;
  itCode: string | null;
  itCodeUpdatedAt: string | null;
  itCodeUpdatedBy: string | null;
};

type FilterMode = "ALL" | "MISSING" | "DONE";

export default function FingerprintItCodePage() {
  const [date, setDate] = useState(todayStr());
  const [filterMode, setFilterMode] = useState<FilterMode>("MISSING");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (d: string, f: FilterMode) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/fingerprint/it-code?date=${d}&filter=${f}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Không tải được danh sách.");
        setRows(null);
        return;
      }
      setRows(data.rows ?? []);
      setDrafts(Object.fromEntries((data.rows ?? []).map((r: Row) => [r.dailyApplicationId, r.itCode ?? ""])));
      setSelected({});
    } catch {
      setError("Không kết nối được máy chủ.");
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date, filterMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, filterMode]);

  const stats = useMemo(() => {
    const total = rows?.length ?? 0;
    const done = rows?.filter((r) => r.itCode && r.itCode.trim()).length ?? 0;
    return { total, done, missing: total - done };
  }, [rows]);

  const selectedIds = Object.keys(selected).filter((k) => selected[k]);

  const submit = async () => {
    if (!rows) return;
    const items = selectedIds
      .map((id) => rows.find((r) => r.dailyApplicationId === id))
      .filter((r): r is Row => !!r)
      .map((r) => ({ dailyApplicationId: r.dailyApplicationId, dwDataId: r.dwDataId, itCode: drafts[r.dailyApplicationId] ?? "" }));
    if (items.length === 0) {
      toast({ title: "Chưa chọn dòng nào", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/fingerprint/it-code", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Thất bại", variant: "destructive" });
        return;
      }
      toast({ title: `✅ Đã cập nhật ${d.updated}${d.skipped ? ` • Không thành công ${d.skipped}` : ""}` });
      await load(date, filterMode);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="IT Code / Vân tay"
        description="Nhập / cập nhật IT CODE cho lao động đã có Mã số công nhật. IT CODE không ảnh hưởng tới Báo cơm hay Employment."
      />

      <MetricStrip
        items={[
          <MetricStripItem key="total" icon={<ScanFace className="h-4 w-4" />} value={stats.total} label="Đã có mã công nhật" context={formatDate(date)} tone="primary" />,
          <MetricStripItem key="done" icon={<CheckCircle2 className="h-4 w-4" />} value={stats.done} label="Đã có IT CODE" tone="success" />,
          <MetricStripItem key="missing" icon={<ScanFace className="h-4 w-4" />} value={stats.missing} label="Chưa có IT CODE" tone="warning" />,
        ]}
      />

      <Card className="p-3">
        <div className="flex flex-wrap items-end gap-2.5">
          <div>
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">Ngày</p>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-10 w-40" />
          </div>
          <Button variant="outline" className="h-10" onClick={() => setDate(todayStr())}>
            <Calendar className="h-4 w-4" /> Về hôm nay
          </Button>
          <div>
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">Lọc</p>
            <select
              value={filterMode}
              onChange={(e) => setFilterMode(e.target.value as FilterMode)}
              className="h-10 rounded-[10px] border border-border-strong bg-surface px-3 text-[13px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            >
              <option value="ALL">Tất cả</option>
              <option value="MISSING">Chưa có IT CODE</option>
              <option value="DONE">Đã có IT CODE</option>
            </select>
          </div>
          <Button variant="outline" className="h-10" onClick={() => void load(date, filterMode)}>
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Tải lại
          </Button>
          <div className="flex-1" />
          <Button variant="primary" className="h-10" disabled={busy || selectedIds.length === 0} loading={busy} onClick={() => void submit()}>
            Submit IT CODE ({selectedIds.length})
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="p-4">
            <SkeletonTable rows={6} cols={6} />
          </div>
        ) : error ? (
          <ErrorState description={error} onRetry={() => void load(date, filterMode)} />
        ) : !rows || rows.length === 0 ? (
          <EmptyState
            title="Không có lao động nào phù hợp bộ lọc"
            description="Danh sách chỉ gồm lao động đã nhập DW Data VÀ đã có Mã số công nhật."
          />
        ) : (
          <div className="v2-scroll max-h-[65vh] overflow-auto">
            <table className="grid-sheet w-full border-collapse text-[13px]">
              <thead className="sticky top-0 z-10 bg-primary-tint/95 backdrop-blur">
                <tr>
                  <th className="w-10 px-2 py-2.5 text-center text-[10px] font-bold uppercase text-primary">
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && selectedIds.length === rows.length}
                      onChange={(e) => setSelected(Object.fromEntries(rows.map((r) => [r.dailyApplicationId, e.target.checked])))}
                      className="h-4 w-4 accent-primary"
                    />
                  </th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Mã công nhật</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Họ và tên</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">CCCD</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Bộ phận</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">IT CODE</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.dailyApplicationId} className="border-b border-border/70 bg-surface hover:bg-botanical-50">
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={!!selected[r.dailyApplicationId]}
                        onChange={(e) => setSelected((s) => ({ ...s, [r.dailyApplicationId]: e.target.checked }))}
                        className="h-4 w-4 accent-primary"
                      />
                    </td>
                    <td className="px-3 py-1.5 font-mono font-semibold">{r.code}</td>
                    <td className="px-3 py-1.5 font-semibold text-fg">{r.fullName}</td>
                    <td className="px-3 py-1.5 font-mono">{r.cccd}</td>
                    <td className="px-3 py-1.5 text-[12px] text-fg-secondary">
                      {r.deptName ?? "—"}
                      {r.groupName ? ` — ${r.groupName}` : ""}
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        value={drafts[r.dailyApplicationId] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDrafts((d) => ({ ...d, [r.dailyApplicationId]: v }));
                          setSelected((s) => ({ ...s, [r.dailyApplicationId]: true }));
                        }}
                        placeholder="Nhập IT CODE"
                        className="h-8 w-32 font-mono text-[12px]"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      {r.itCode ? <Badge tone="green">Đã cấp</Badge> : <Badge tone="amber">Chưa cấp</Badge>}
                    </td>
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
