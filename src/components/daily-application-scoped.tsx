"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  toast,
} from "@/components/ui";
import { ClipboardList, Loader2 } from "lucide-react";
import { formatDate, todayStr } from "@/lib/helpers";

type Dept = { id: string; deptName: string; groupName: string | null };

type AppRow = {
  id: string;
  regDate: string;
  cccd: string;
  fullName: string;
  gender: string | null;
  phone: string;
  dwCode: string | null;
  deptName: string | null;
  groupName: string | null;
  status: string;
};

/**
 * Daily Application cho người dùng CÓ Data Scope (Quản lý bộ phận):
 * - bộ lọc bộ phận CHỈ gồm bộ phận được phân quyền (server đã trả sẵn danh sách);
 * - chọn bộ phận nào thì bảng chỉ hiện đúng bộ phận đó (API giao filter với scope);
 * - bảng chỉ hiện 6 cột tối giản: Code | Ngày | Họ và tên | SĐT | Giới tính | Bộ phận + Nhóm
 *   (không hiện đầy đủ cột + không inline edit như giao diện Recruiter/Admin).
 */
export default function DailyApplicationScoped({
  departments,
  initialFrom,
}: {
  departments: Dept[];
  initialFrom?: string;
}) {
  const [from, setFrom] = useState(() => initialFrom ?? todayStr());
  const [to, setTo] = useState(() => initialFrom ?? todayStr());
  const [deptFilter, setDeptFilter] = useState("ALL");
  const [rows, setRows] = useState<AppRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to, deptId: deptFilter });
      const res = await fetch(`/api/registrations?${p}`);
      if (!res.ok) {
        toast({ title: "Không thể tải dữ liệu", variant: "destructive" });
        return;
      }
      const data = await res.json();
      setRows(data.rows ?? []);
    } catch {
      toast({ title: "Lỗi kết nối", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [from, to, deptFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      {/* Filter toolbar */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <p className="mb-1 text-[11px] font-semibold text-fg-muted">Từ ngày</p>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 rounded-[8px] border border-border bg-surface px-2.5 text-xs font-medium text-fg outline-none focus:border-primary"
              />
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold text-fg-muted">Đến ngày</p>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 rounded-[8px] border border-border bg-surface px-2.5 text-xs font-medium text-fg outline-none focus:border-primary"
              />
            </div>
            <Button variant="primary" size="sm" onClick={load} className="h-9">
              Xem
            </Button>

            {/* Bộ lọc bộ phận — chỉ gồm bộ phận được phân quyền */}
            <div>
              <p className="mb-1 text-[11px] font-semibold text-fg-muted">Bộ phận (được phân quyền)</p>
              <select
                value={deptFilter}
                onChange={(e) => setDeptFilter(e.target.value)}
                className="h-9 max-w-[260px] rounded-[8px] border border-border bg-surface px-2.5 text-xs font-medium text-fg outline-none focus:border-primary"
              >
                <option value="ALL">Tất cả bộ phận của tôi ({departments.length})</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.deptName}
                    {d.groupName ? ` — ${d.groupName}` : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span>
              Hiển thị: <b>{rows.length}</b> DW
            </span>
          </div>
        </div>
      </Card>

      {/* Minimal table */}
      <Card className="overflow-hidden p-0">
        <CardHeader
          title={`Daily Application (${formatDate(from)}${from !== to ? " → " + formatDate(to) : ""})`}
        />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
              <p className="mt-2 text-xs text-fg-muted">Đang tải danh sách...</p>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<ClipboardList className="h-5 w-5" aria-hidden />}
              title="Không có DW nào"
              description="Không có người tập nghề nào trong bộ phận được phân quyền cho khoảng ngày đã chọn."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-sheet w-full text-[13px]">
                <thead className="bg-primary text-white">
                  <tr>
                    <th className="w-12 px-3 py-2.5 text-center text-[10.5px] uppercase">#</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Code</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Ngày</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Họ và tên</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">SĐT</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Giới tính</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Bộ phận + Nhóm</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r, i) => (
                    <tr key={r.id} className="transition-colors hover:bg-surface-hover">
                      <td className="px-3 py-2.5 text-center text-xs text-fg-muted">{i + 1}</td>
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-fg-secondary">
                        {r.dwCode || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-fg-secondary">{formatDate(r.regDate)}</td>
                      <td className="px-3 py-2.5 font-bold text-fg">{r.fullName}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg-secondary">{r.phone || "—"}</td>
                      <td className="px-3 py-2.5 text-center">
                        <Badge tone={r.gender === "Nữ" ? "purple" : "blue"}>{r.gender ?? "—"}</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-fg font-semibold">
                        {r.deptName || "—"}
                        {r.groupName ? (
                          <span className="text-fg-secondary font-normal"> — {r.groupName}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
