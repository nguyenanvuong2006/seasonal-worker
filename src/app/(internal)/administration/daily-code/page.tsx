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
import { BadgeCheck, Calendar, CheckCircle2, Download, RefreshCw, Search, Users } from "lucide-react";

type Row = {
  dailyApplicationId: string;
  cccd: string;
  fullName: string;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  startingDate: string | null;
  dwImportedAt: string | null;
  dwDataId: string;
  code: string | null;
  dailyCodeUpdatedAt: string | null;
  dailyCodeUpdatedBy: string | null;
};

type DeptOption = { id: string; deptName: string; groupName: string | null };
type StatusFilter = "ALL" | "MISSING" | "DONE";

const hasCode = (r: Row) => !!(r.code && r.code.trim());

export default function AdministrationDailyCodePage() {
  const [date, setDate] = useState(todayStr());
  const [deptId, setDeptId] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [depts, setDepts] = useState<DeptOption[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/departments");
        const data = await res.json();
        if (res.ok) setDepts(data.rows ?? []);
      } catch {
        // Bộ lọc bộ phận là tiện ích phụ — lỗi tải không chặn danh sách chính.
      }
    })();
  }, []);

  // Luôn tải TOÀN BỘ (status=ALL, server-authorized theo date/deptId/q) — bộ
  // lọc trạng thái áp dụng ở client trên CÙNG tập dữ liệu, để KPI và danh
  // sách hiển thị luôn nhất quán (bấm 1 thẻ KPI không cần gọi lại API).
  const load = useCallback(async (d: string, dept: string, query: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ date: d, status: "ALL" });
      if (dept) params.set("deptId", dept);
      if (query.trim()) params.set("q", query.trim());
      const res = await fetch(`/api/administration/daily-code?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Không tải được danh sách.");
        setRows(null);
        return;
      }
      setRows(data.rows ?? []);
      setDrafts(Object.fromEntries((data.rows ?? []).map((r: Row) => [r.dailyApplicationId, r.code ?? ""])));
      setSelected({});
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

  const stats = useMemo(() => {
    const total = rows?.length ?? 0;
    const done = rows?.filter(hasCode).length ?? 0;
    return { total, done, missing: total - done };
  }, [rows]);

  const displayRows = useMemo(() => {
    if (!rows) return rows;
    if (status === "MISSING") return rows.filter((r) => !hasCode(r));
    if (status === "DONE") return rows.filter(hasCode);
    return rows;
  }, [rows, status]);

  const selectedIds = Object.keys(selected).filter((k) => selected[k]);

  const exportHref = (() => {
    const params = new URLSearchParams({ date, status });
    if (deptId) params.set("deptId", deptId);
    if (q.trim()) params.set("q", q.trim());
    return `/api/administration/daily-code/export?${params.toString()}`;
  })();

  const submit = async () => {
    if (!displayRows) return;
    const items = selectedIds
      .map((id) => displayRows.find((r) => r.dailyApplicationId === id))
      .filter((r): r is Row => !!r)
      .map((r) => ({ dailyApplicationId: r.dailyApplicationId, dwDataId: r.dwDataId, code: drafts[r.dailyApplicationId] ?? "" }));
    if (items.length === 0) {
      toast({ title: "Chưa chọn dòng nào", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/administration/daily-code", {
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
      await load(date, deptId, q);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Nhập mã công nhật"
        description="Cấp / cập nhật Mã số công nhật cho lao động đã được Recruiter đưa vào DW Data."
      />

      <MetricStrip
        items={[
          <MetricStripItem key="total" icon={<Users className="h-4 w-4" />} value={stats.total} label="Đã nhập DW" context={formatDate(date)} tone="primary" onClick={() => setStatus("ALL")} active={status === "ALL"} />,
          <MetricStripItem key="done" icon={<CheckCircle2 className="h-4 w-4" />} value={stats.done} label="Đã có mã" tone="success" onClick={() => setStatus("DONE")} active={status === "DONE"} />,
          <MetricStripItem key="missing" icon={<BadgeCheck className="h-4 w-4" />} value={stats.missing} label="Chưa có mã" tone="warning" onClick={() => setStatus("MISSING")} active={status === "MISSING"} />,
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
          <div>
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">Lọc</p>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="h-10 rounded-[10px] border border-border-strong bg-surface px-3 text-[13px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            >
              <option value="ALL">Tất cả</option>
              <option value="MISSING">Chưa có mã</option>
              <option value="DONE">Đã có mã</option>
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
            className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-border-strong bg-surface px-4 text-[13px] font-semibold text-fg shadow-sm transition-colors hover:bg-botanical-50"
          >
            <Download className="h-4 w-4" /> Xuất Excel
          </a>
          <Button
            variant="primary"
            className="h-10"
            disabled={busy || selectedIds.length === 0}
            loading={busy}
            onClick={() => void submit()}
          >
            Submit mã công nhật ({selectedIds.length})
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="p-4">
            <SkeletonTable rows={6} cols={7} />
          </div>
        ) : error ? (
          <ErrorState description={error} onRetry={() => void load(date, deptId, q)} />
        ) : !displayRows || displayRows.length === 0 ? (
          <EmptyState
            title="Chưa có lao động nào cần nhập mã công nhật"
            description="Danh sách hiển thị lao động đã được Recruiter đưa vào DW Data, khớp bộ lọc hiện tại."
          />
        ) : (
          <div className="v2-scroll max-h-[65vh] overflow-auto">
            <table className="grid-sheet w-full border-collapse text-[13px]">
              <thead className="sticky top-0 z-10 bg-primary-tint/95 backdrop-blur">
                <tr>
                  <th className="w-10 px-2 py-2.5 text-center text-[10px] font-bold uppercase text-primary">
                    <input
                      type="checkbox"
                      checked={displayRows.length > 0 && selectedIds.length === displayRows.length}
                      onChange={(e) => setSelected(Object.fromEntries(displayRows!.map((r) => [r.dailyApplicationId, e.target.checked])))}
                      className="h-4 w-4 accent-primary"
                    />
                  </th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">STT</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Họ và tên</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">CCCD</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Bộ phận</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Ngày nhận việc</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Trạng thái DW</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Mã số công nhật</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Trạng thái cập nhật</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r, idx) => (
                  <tr key={r.dailyApplicationId} className="border-b border-border/70 bg-surface hover:bg-botanical-50">
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={!!selected[r.dailyApplicationId]}
                        onChange={(e) => setSelected((s) => ({ ...s, [r.dailyApplicationId]: e.target.checked }))}
                        className="h-4 w-4 accent-primary"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-fg-muted">{idx + 1}</td>
                    <td className="px-3 py-1.5 font-semibold text-fg">{r.fullName}</td>
                    <td className="px-3 py-1.5 font-mono">{r.cccd}</td>
                    <td className="px-3 py-1.5 text-[12px] text-fg-secondary">
                      {r.deptName ?? "—"}
                      {r.groupName ? ` — ${r.groupName}` : ""}
                    </td>
                    <td className="px-3 py-1.5 text-[12px]">{r.startingDate ? formatDate(r.startingDate) : "—"}</td>
                    <td className="px-3 py-1.5">
                      <Badge tone="green">Đã nhập DW</Badge>
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        value={drafts[r.dailyApplicationId] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDrafts((d) => ({ ...d, [r.dailyApplicationId]: v }));
                          setSelected((s) => ({ ...s, [r.dailyApplicationId]: true }));
                        }}
                        placeholder="Nhập mã"
                        className="h-8 w-32 font-mono text-[12px]"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-fg-muted">
                      {r.dailyCodeUpdatedAt
                        ? `${new Date(r.dailyCodeUpdatedAt).toLocaleString("vi-VN")} · ${r.dailyCodeUpdatedBy ?? "—"}`
                        : "Chưa cập nhật"}
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
