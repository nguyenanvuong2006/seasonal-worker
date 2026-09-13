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
import { DateRangeFilter } from "@/components/date-range-filter";
import { buildDateRangePreset, type DateRange } from "@/lib/date-range";
import { Calendar, CheckCircle2, Download, RefreshCw, ScanFace, Search } from "lucide-react";

type Classification = "NEW" | "RETURNING" | "TRANSFERRED";

type Row = {
  dailyApplicationId: string;
  cccd: string;
  fullName: string;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  dwDataId: string;
  code: string | null;
  itCode: string | null;
  itCodeUpdatedAt: string | null;
  itCodeUpdatedBy: string | null;
  classification: Classification | null;
};

type DeptOption = { id: string; deptName: string; groupName: string | null };
type ClassificationFilter = "ALL" | Classification;
type ItCodeStatusFilter = "ALL" | "MISSING" | "HAS";

const CLASSIFICATION_LABELS: Record<Classification, string> = {
  NEW: "Công nhật mới",
  RETURNING: "Cũ quay lại",
  TRANSFERRED: "Cũ thuyên chuyển",
};

const hasItCode = (r: Row) => !!(r.itCode && r.itCode.trim());

export default function FingerprintItCodePage() {
  const [range, setRange] = useState<DateRange>(() => buildDateRangePreset("TODAY"));
  const [deptId, setDeptId] = useState("");
  const [q, setQ] = useState("");
  const [classificationFilter, setClassificationFilter] = useState<ClassificationFilter>("ALL");
  const [itCodeStatusFilter, setItCodeStatusFilter] = useState<ItCodeStatusFilter>("MISSING");
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

  // Luôn tải TOÀN BỘ trong khoảng [from,to] (classification=ALL, itCodeStatus=ALL,
  // server-authorized theo deptId/q) — bộ lọc "Loại công nhật" / "Trạng thái IT
  // Code" áp dụng ở client trên CÙNG tập dữ liệu, để KPI và danh sách hiển thị
  // luôn nhất quán (bấm 1 thẻ KPI không cần gọi lại API).
  const load = useCallback(async (r: DateRange, dept: string, query: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: r.from, to: r.to, classification: "ALL", itCodeStatus: "ALL" });
      if (dept) params.set("deptId", dept);
      if (query.trim()) params.set("q", query.trim());
      const res = await fetch(`/api/fingerprint/it-code?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Không tải được danh sách.");
        setRows(null);
        return;
      }
      setRows(data.rows ?? []);
      setDrafts(Object.fromEntries((data.rows ?? []).map((r: Row) => [r.dailyApplicationId, r.itCode ?? ""])));
    } catch {
      setError("Không kết nối được máy chủ.");
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range, deptId, q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, deptId]);

  // Tìm nhanh: debounce để không gọi API theo từng ký tự gõ.
  useEffect(() => {
    const timer = setTimeout(() => void load(range, deptId, q), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const stats = useMemo(() => {
    const total = rows?.length ?? 0;
    const done = rows?.filter(hasItCode).length ?? 0;
    return { total, done, missing: total - done };
  }, [rows]);

  const displayRows = useMemo(() => {
    if (!rows) return rows;
    let filtered = rows;
    if (classificationFilter !== "ALL") filtered = filtered.filter((r) => r.classification === classificationFilter);
    if (itCodeStatusFilter === "MISSING") filtered = filtered.filter((r) => !hasItCode(r));
    else if (itCodeStatusFilter === "HAS") filtered = filtered.filter(hasItCode);
    return filtered;
  }, [rows, classificationFilter, itCodeStatusFilter]);

  // Đổi khoảng ngày / bộ lọc có thể làm một hàng đang chọn biến mất khỏi danh
  // sách hiển thị — KHÔNG được để lựa chọn đó "ẩn nhưng vẫn tồn tại" rồi lỡ
  // submit nhầm (mục 19). Dọn selection ngay khi tập hiển thị đổi.
  useEffect(() => {
    if (!displayRows) return;
    const visibleIds = new Set(displayRows.map((r) => r.dailyApplicationId));
    setSelected((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, checked] of Object.entries(prev)) {
        if (visibleIds.has(id)) next[id] = checked;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [displayRows]);

  const selectedIds = Object.keys(selected).filter((k) => selected[k]);

  const exportHref = (() => {
    const params = new URLSearchParams({ from: range.from, to: range.to, classification: classificationFilter, itCodeStatus: itCodeStatusFilter });
    if (deptId) params.set("deptId", deptId);
    if (q.trim()) params.set("q", q.trim());
    return `/api/fingerprint/it-code/export?${params.toString()}`;
  })();

  const submit = async () => {
    if (!displayRows) return;
    const items = selectedIds
      .map((id) => displayRows.find((r) => r.dailyApplicationId === id))
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
      await load(range, deptId, q);
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
          <MetricStripItem key="total" icon={<ScanFace className="h-4 w-4" />} value={stats.total} label="Tổng công nhật trong khoảng" tone="primary" onClick={() => setItCodeStatusFilter("ALL")} active={itCodeStatusFilter === "ALL"} />,
          <MetricStripItem key="done" icon={<CheckCircle2 className="h-4 w-4" />} value={stats.done} label="Đã có IT Code" tone="success" onClick={() => setItCodeStatusFilter("HAS")} active={itCodeStatusFilter === "HAS"} />,
          <MetricStripItem key="missing" icon={<ScanFace className="h-4 w-4" />} value={stats.missing} label="Chưa có IT Code" tone="warning" onClick={() => setItCodeStatusFilter("MISSING")} active={itCodeStatusFilter === "MISSING"} />,
        ]}
      />

      <Card className="p-3">
        <div className="flex flex-col gap-3">
          <DateRangeFilter value={range} onChange={setRange} />
          <div className="flex flex-wrap items-end gap-2.5">
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
              <p className="mb-1 text-[11px] font-semibold text-fg-muted">Loại công nhật</p>
              <select
                value={classificationFilter}
                onChange={(e) => setClassificationFilter(e.target.value as ClassificationFilter)}
                className="h-10 rounded-[10px] border border-border-strong bg-surface px-3 text-[13px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
              >
                <option value="ALL">Tất cả</option>
                <option value="NEW">Công nhật mới</option>
                <option value="RETURNING">Cũ quay lại</option>
                <option value="TRANSFERRED">Cũ thuyên chuyển</option>
              </select>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold text-fg-muted">Trạng thái IT Code</p>
              <select
                value={itCodeStatusFilter}
                onChange={(e) => setItCodeStatusFilter(e.target.value as ItCodeStatusFilter)}
                className="h-10 rounded-[10px] border border-border-strong bg-surface px-3 text-[13px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
              >
                <option value="ALL">Tất cả</option>
                <option value="MISSING">Chưa có IT CODE</option>
                <option value="HAS">Đã có IT CODE</option>
              </select>
            </div>
            <Button variant="outline" className="h-10" onClick={() => setRange(buildDateRangePreset("TODAY"))}>
              <Calendar className="h-4 w-4" /> Về hôm nay
            </Button>
            <Button variant="outline" className="h-10" onClick={() => void load(range, deptId, q)}>
              <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Tải lại
            </Button>
            <div className="min-w-[180px] flex-1">
              <p className="mb-1 text-[11px] font-semibold text-fg-muted">Tìm nhanh</p>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tên / CCCD / Mã công nhật / IT CODE" className="h-10 pl-9" />
              </div>
            </div>
            <a
              href={exportHref}
              className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-border-strong bg-surface px-4 text-[13px] font-semibold text-fg shadow-sm transition-colors hover:bg-botanical-50"
            >
              <Download className="h-4 w-4" /> Xuất Excel
            </a>
            <Button variant="primary" className="h-10" disabled={busy || selectedIds.length === 0} loading={busy} onClick={() => void submit()}>
              Submit IT CODE ({selectedIds.length})
            </Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="p-4">
            <SkeletonTable rows={6} cols={7} />
          </div>
        ) : error ? (
          <ErrorState description={error} onRetry={() => void load(range, deptId, q)} />
        ) : !displayRows || displayRows.length === 0 ? (
          <EmptyState
            title="Không có lao động nào phù hợp bộ lọc"
            description="Danh sách chỉ gồm lao động đã nhập DW Data VÀ đã có Mã số công nhật, trong khoảng ngày đã chọn."
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
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Mã công nhật</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Họ và tên</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">CCCD</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Bộ phận</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Phân loại</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">IT CODE</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-bold uppercase text-primary">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r) => (
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
                    <td className="px-3 py-1.5 text-[12px]">
                      {r.classification ? (
                        <Badge tone={r.classification === "TRANSFERRED" ? "blue" : r.classification === "RETURNING" ? "amber" : "green"}>
                          {CLASSIFICATION_LABELS[r.classification]}
                        </Badge>
                      ) : (
                        "—"
                      )}
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
