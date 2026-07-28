"use client";

import * as React from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { Badge, Button, Card, Input, Modal, toast, cn } from "@/components/ui";
import { formatDate, STATUS_META, todayStr } from "@/lib/helpers";
import { Loader2, RefreshCw, ShieldCheck, UserPlus2 } from "lucide-react";

export type AppRow = {
  id: string;
  regDate: string;
  cccd: string;
  fullName: string;
  gender: string | null;
  dob: string | null;
  age: number | null;
  phone: string;
  ethnicity: string | null;
  permanentAddress: string | null;
  residentialAddress: string | null;
  declaredType: string;
  dwMatch: string;
  dwCode: string | null;
  workDuration: string | null;
  referralChannel: string | null;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  vnName: string | null;
  status: string;
  startingDate: string | null;
  appointmentList: string | null;
  noteWorker: string | null;
  isImported: boolean;
  customAnswers: Record<string, string> | null;
};

export type DeptOption = {
  id: string;
  deptName: string;
  groupName: string;
  vnName: string | null;
  dailyQuota: number;
};

const MAX_BULK = 500;

function EditableCell({
  value,
  onCommit,
  className,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = React.useState(value);
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing)
    return (
      <button
        onClick={() => setEditing(true)}
        className={cn(
          "block w-full truncate px-2 py-1.5 text-left text-[13px] hover:bg-gold-50 hover:ring-1 hover:ring-gold-200",
          !value && "text-gray-300",
          className,
        )}
        title="Nhấp để sửa như Google Sheet — Enter để lưu"
      >
        {value || placeholder || "—"}
      </button>
    );

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          setEditing(false);
          if (draft !== value) onCommit(draft);
        }
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
      className="w-full rounded-lg border-2 border-hasfarm-600 bg-white px-2 py-1 text-[13px] shadow outline-none"
    />
  );
}

type HistoryLog = {
  id: string;
  action: string;
  username: string | null;
  createdAt: string;
  details: { before?: Record<string, unknown>; after?: Record<string, unknown>; reason?: string | null } | null;
};

function HistoryPanel({ row, canRestore, onClose, onRestored }: { row: AppRow; canRestore: boolean; onClose: () => void; onRestored: () => void }) {
  const [logs, setLogs] = React.useState<HistoryLog[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch(`/api/admin/history?targetType=daily_applications&id=${row.id}`)
      .then((r) => r.json())
      .then((d) => setLogs(d.rows ?? []));
  }, [row.id]);

  const restore = async (auditLogId: string) => {
    setBusyId(auditLogId);
    try {
      const res = await fetch("/api/admin/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "daily_applications", id: row.id, auditLogId }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Khôi phục thất bại", variant: "destructive" });
        return;
      }
      toast({ title: "✅ Đã khôi phục về phiên bản này" });
      onRestored();
      onClose();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Lịch sử chỉnh sửa: ${row.fullName}`} width="max-w-2xl">
      {logs === null ? (
        <div className="p-6 text-center">
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-hasfarm-600" />
        </div>
      ) : logs.length === 0 ? (
        <p className="p-6 text-center text-sm text-gray-400">Chưa có lịch sử chỉnh sửa nào cho hồ sơ này.</p>
      ) : (
        <ul className="max-h-[60vh] space-y-3 overflow-y-auto">
          {logs.map((l) => {
            const before = l.details?.before ?? {};
            const after = l.details?.after ?? {};
            const changedKeys = Object.keys(after).filter((k) => k !== "updatedAt");
            return (
              <li key={l.id} className="rounded-xl border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[12px] font-bold text-hasfarm-900">
                    {l.action} · {l.username ?? "—"}
                  </p>
                  <p className="text-[11px] text-gray-400">{new Date(l.createdAt).toLocaleString("vi-VN")}</p>
                </div>
                {l.details?.reason && <p className="mt-1 text-[12px] italic text-gray-500">Lý do: {l.details.reason}</p>}
                {changedKeys.length > 0 && (
                  <table className="mt-2 w-full text-[12px]">
                    <tbody>
                      {changedKeys.map((k) => (
                        <tr key={k} className="border-t">
                          <td className="py-1 pr-2 font-mono text-gray-400">{k}</td>
                          <td className="py-1 pr-2 text-red-500 line-through">{String(before[k] ?? "—")}</td>
                          <td className="py-1 text-emerald-700">{String(after[k] ?? "—")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {canRestore && before && Object.keys(before).length > 0 && (
                  <button
                    onClick={() => restore(l.id)}
                    disabled={busyId === l.id}
                    className="mt-2 rounded-full bg-gray-100 px-3 py-1 text-[11px] font-bold text-gray-700 hover:bg-gray-200"
                  >
                    {busyId === l.id ? "Đang khôi phục…" : "↺ Khôi phục về trước lần sửa này"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

export default function RegistrationsGrid({
  departments,
  canEdit,
}: {
  departments: DeptOption[];
  canEdit: boolean;
}) {
  // MẶC ĐỊNH CHỈ HÔM NAY (màn hình tinh gọn)
  const [from, setFrom] = React.useState(todayStr());
  const [to, setTo] = React.useState(todayStr());
  const [rangeMode, setRangeMode] = React.useState(false);
  const [statusFilter, setStatusFilter] = React.useState("ALL");
  const [deptFilter, setDeptFilter] = React.useState("ALL");
  const [matchFilter, setMatchFilter] = React.useState("ALL");
  const [globalFilter, setGlobalFilter] = React.useState("");
  const [limit, setLimit] = React.useState<number>(0);
  const [rows, setRows] = React.useState<AppRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [rowSelection, setRowSelection] = React.useState<Record<string, boolean>>({});
  const [busy, setBusy] = React.useState(false);
  const [detail, setDetail] = React.useState<AppRow | null>(null);
  const [historyRow, setHistoryRow] = React.useState<AppRow | null>(null);
  const [searchableFields, setSearchableFields] = React.useState<string[] | null>(null);
  const [stages, setStages] = React.useState<{ stageKey: string; label: string; color: string }[] | null>(null);
  const [newModalOpen, setNewModalOpen] = React.useState(false);
  const [newSel, setNewSel] = React.useState<Record<string, boolean>>({});
  const [newDept, setNewDept] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({
        from,
        to: rangeMode ? to : from,
        status: statusFilter,
        deptId: deptFilter,
        dwMatch: matchFilter,
      });
      const res = await fetch(`/api/registrations?${p}`);
      const data = await res.json();
      setRows(data.rows ?? []);
      setRowSelection({});
    } finally {
      setLoading(false);
    }
  }, [from, to, rangeMode, statusFilter, deptFilter, matchFilter]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // METADATA ENGINE: cột nào tham gia "Tìm nhanh" do admin cấu hình ở /admin/field-definitions
  // (nhóm daily_application, searchable=true) — không cần sửa code để bật/tắt cột tìm kiếm.
  React.useEffect(() => {
    fetch("/api/admin/field-definitions")
      .then((r) => r.json())
      .then((d: { rows?: { groupName: string; databaseField: string; searchable: boolean }[] }) => {
        const fields = (d.rows ?? [])
          .filter((f) => f.groupName === "daily_application" && f.searchable)
          .map((f) => f.databaseField);
        setSearchableFields(fields.length ? fields : null);
      })
      .catch(() => setSearchableFields(null));
  }, []);

  // WORKFLOW ENGINE (#5): trạng thái/màu đọc từ /admin/workflow thay vì STATUS_META hard-code.
  // Nếu chưa cấu hình được (lỗi mạng, bảng trống) thì dùng STATUS_META làm dự phòng.
  React.useEffect(() => {
    fetch("/api/workflow-stages")
      .then((r) => r.json())
      .then((d: { rows?: { stageKey: string; label: string; color: string }[] }) => {
        setStages(d.rows && d.rows.length ? d.rows : null);
      })
      .catch(() => setStages(null));
  }, []);

  const patchRow = React.useCallback(
    async (id: string, patch: Partial<AppRow>) => {
      const prev = rows;
      setRows((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      try {
        const body: Record<string, unknown> = {};
        (
          ["cccd", "fullName", "gender", "dob", "phone", "ethnicity", "residentialAddress",
           "deptId", "status", "noteWorker", "appointmentList", "workDuration"] as const
        ).forEach((k) => {
          if (k in patch) body[k] = patch[k];
        });
        const res = await fetch(`/api/registrations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const d = await res.json();
          setRows(prev);
          toast({ title: d.error ?? "Lưu thất bại", variant: "destructive" });
        }
      } catch {
        setRows(prev);
        toast({ title: "Mất kết nối — đã hoàn tác", variant: "destructive" });
      }
    },
    [rows],
  );

  const ch = React.useMemo(() => createColumnHelper<AppRow>(), []);

  const statusOptions = React.useMemo(
    () =>
      stages
        ? stages.map((s) => ({ key: s.stageKey, label: s.label, tone: s.color as "gray" | "green" | "amber" | "red" | "gold" | "blue" }))
        : Object.entries(STATUS_META).map(([k, v]) => ({ key: k, label: v.label, tone: v.tone })),
    [stages],
  );
  const stageMeta = React.useCallback(
    (key: string) => statusOptions.find((s) => s.key === key) ?? { key, label: key, tone: "gray" as const },
    [statusOptions],
  );

  const columns = React.useMemo(
    () => [
      ch.display({
        id: "select",
        header: ({ table }) => (
          <div className="pl-6">
            <input
              type="checkbox"
              className="h-4 w-4 accent-gold-500 cursor-pointer"
              checked={table.getIsAllRowsSelected()}
              onChange={table.getToggleAllRowsSelectedHandler()}
            />
          </div>
        ),
        cell: ({ row }) => (
          <div className="pl-6">
            <input
              type="checkbox"
              className="h-4 w-4 accent-gold-500 cursor-pointer"
              checked={row.getIsSelected()}
              onChange={row.getToggleSelectedHandler()}
            />
          </div>
        ),
      }),
      ch.accessor("regDate", {
        header: "Ngày",
        cell: (i) => (
          <span className="block px-2 text-center text-[12px] font-bold text-gray-600">
            {formatDate(i.getValue()).slice(0, 5)}
          </span>
        ),
      }),
      ch.accessor("cccd", {
        header: "CCCD (bắt buộc)",
        cell: (i) =>
          canEdit ? (
            <EditableCell
              value={i.getValue()}
              onCommit={(v) => patchRow(i.row.original.id, { cccd: v })}
              className="font-mono font-bold"
            />
          ) : (
            <span className="px-2 font-mono text-[13px]">{i.getValue()}</span>
          ),
      }),
      ch.accessor("fullName", {
        header: "Họ và tên",
        cell: (i) => (
          <div className="flex items-center gap-1.5">
            {canEdit ? (
              <EditableCell
                value={i.getValue()}
                onCommit={(v) => patchRow(i.row.original.id, { fullName: v })}
                className="font-bold text-hasfarm-900"
              />
            ) : (
              <span className="px-2 text-[13px] font-bold">{i.getValue()}</span>
            )}
          </div>
        ),
      }),
      ch.accessor("dwMatch", {
        header: "DW Data",
        cell: (i) => {
          const matched = i.getValue() === "MATCHED";
          const declared = i.row.original.declaredType;
          const lie = declared === "OLD" && !matched;
          return (
            <span className="flex items-center gap-1 px-1">
              {matched ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-800">
                  <ShieldCheck className="h-3 w-3" /> CŨ
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black text-amber-800">
                  <UserPlus2 className="h-3 w-3" /> MỚI
                </span>
              )}
              {lie && (
                <span title="Tự khai là CŨ nhưng không có trong DW Data" className="text-[13px]">
                  ⚠️
                </span>
              )}
            </span>
          );
        },
      }),
      ch.accessor("phone", {
        header: "SĐT",
        cell: (i) =>
          canEdit ? (
            <EditableCell value={i.getValue() ?? ""} onCommit={(v) => patchRow(i.row.original.id, { phone: v })} />
          ) : (
            <span className="px-2 text-[13px]">{i.getValue()}</span>
          ),
      }),
      ch.accessor("gender", {
        header: "Giới tính",
        cell: (i) => <span className="block px-1 text-center text-[12px]">{i.getValue() ?? "—"}</span>,
      }),
      ch.accessor("age", {
        header: "Tuổi",
        cell: (i) => <span className="block px-1 text-center text-[12px] font-bold">{i.getValue() ?? "—"}</span>,
      }),
      ch.accessor("deptId", {
        header: "Bộ phận + Nhóm",
        cell: (i) =>
          canEdit ? (
            <select
              value={i.getValue() ?? ""}
              onChange={(e) => {
                const d = departments.find((x) => x.id === e.target.value);
                patchRow(i.row.original.id, {
                  deptId: e.target.value || null,
                  deptName: d?.deptName ?? null,
                  groupName: d?.groupName ?? null,
                });
              }}
              className="w-full max-w-[210px] rounded-lg border border-transparent bg-transparent px-1 py-1.5 text-[12px] font-semibold hover:border-gray-300"
            >
              <option value="">— Chưa xếp —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.deptName}
                  {d.groupName ? ` — ${d.groupName}` : ""}
                </option>
              ))}
            </select>
          ) : (
            <span className="px-2 text-[12px]">
              {i.row.original.deptName ?? "—"}
              {i.row.original.groupName ? ` — ${i.row.original.groupName}` : ""}
            </span>
          ),
      }),
      ch.accessor("status", {
        header: "Trạng thái",
        cell: (i) =>
          canEdit ? (
            <select
              value={i.getValue()}
              onChange={(e) => patchRow(i.row.original.id, { status: e.target.value })}
              className={cn(
                "w-full rounded-full border px-2 py-1.5 text-[11px] font-black",
                i.getValue() === "APPROVED"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : i.getValue() === "REJECTED"
                    ? "border-red-300 bg-red-50 text-red-700"
                    : "border-amber-300 bg-amber-50 text-amber-800",
              )}
            >
              {statusOptions.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          ) : (
            <Badge tone={stageMeta(i.getValue()).tone}>{stageMeta(i.getValue()).label}</Badge>
          ),
      }),
      ch.accessor("noteWorker", {
        header: "Ghi chú",
        cell: (i) =>
          canEdit ? (
            <EditableCell
              value={i.getValue() ?? ""}
              placeholder="Ghi chú"
              onCommit={(v) => patchRow(i.row.original.id, { noteWorker: v })}
            />
          ) : (
            <span className="px-2 text-[13px]">{i.getValue()}</span>
          ),
      }),
      ch.display({
        id: "act",
        header: "",
        cell: ({ row }) => (
          <div className="flex gap-1">
            <button
              onClick={() => setDetail(row.original)}
              className="rounded-full bg-hasfarm-50 px-2 py-1 text-[11px] font-bold text-hasfarm-700 hover:bg-hasfarm-100"
            >
              Chi tiết
            </button>
            <button
              onClick={() => setHistoryRow(row.original)}
              className="rounded-full bg-gray-100 px-2 py-1 text-[11px] font-bold text-gray-600 hover:bg-gray-200"
              title="Xem lịch sử chỉnh sửa"
            >
              Lịch sử
            </button>
          </div>
        ),
      }),
    ],
    [canEdit, ch, departments, patchRow, statusOptions, stageMeta],
  );

  const displayData = React.useMemo(() => {
    return limit === 0 ? rows : rows.slice(0, limit);
  }, [rows, limit]);

  const table = useReactTable({
    data: displayData,
    columns,
    state: { sorting, globalFilter, rowSelection },
    getRowId: (r) => r.id,
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    globalFilterFn: (row, _c, f) => {
      const q = String(f).toLowerCase();
      const r = row.original;
      // Bản đồ database_field (khai báo ở /admin/field-definitions) -> cách lấy text tương ứng trên AppRow.
      const TEXT_BY_FIELD: Record<string, () => string> = {
        full_name: () => r.fullName,
        cccd: () => r.cccd,
        phone: () => r.phone ?? "",
        ethnicity: () => r.ethnicity ?? "",
        residential_address: () => `${r.residentialAddress ?? ""} ${r.permanentAddress ?? ""}`,
        permanent_address: () => r.permanentAddress ?? "",
        dept_id: () => `${r.deptName ?? ""} ${r.groupName ?? ""}`,
        status: () => STATUS_META[r.status]?.label ?? r.status,
      };
      const activeFields = (searchableFields ?? ["full_name", "cccd", "phone"]).filter((k) => k in TEXT_BY_FIELD);
      const fields = activeFields.length ? activeFields : ["full_name", "cccd", "phone"];
      return fields.some((k) => TEXT_BY_FIELD[k]().toLowerCase().includes(q));
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const selIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const selRows = displayData.filter((r) => selIds.includes(r.id));
  const newInSel = selRows.filter((r) => r.dwMatch === "NEW").length;
  const newApplicants = React.useMemo(() => displayData.filter((r) => r.dwMatch === "NEW"), [displayData]);
  const newSelIds = Object.keys(newSel).filter((k) => newSel[k]);
  const [bulkResult, setBulkResult] = React.useState<{
    imported: number;
    newToDw: number;
    skipped: number;
    results: { id: string; cccd: string | null; fullName: string | null; ok: boolean; reason: string }[];
  } | null>(null);

  const runBulk = async (ids: string[], status: "APPROVED" | "REJECTED", deptId?: string) => {
    if (ids.length === 0) {
      toast({ title: "Chưa chọn hồ sơ nào", variant: "destructive" });
      return;
    }
    if (ids.length > MAX_BULK) {
      toast({ title: `Vượt quá ${MAX_BULK} hồ sơ/lần!`, variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, departmentId: deptId || null, status }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Thất bại", variant: "destructive" });
        return;
      }
      toast({
        title:
          status === "APPROVED"
            ? `✅ Đã duyệt ${d.imported} • Thêm mới ${d.newToDw} vào DW Data${d.skipped ? ` • Không thành công ${d.skipped}` : ""}`
            : `Đã từ chối ${d.imported} hồ sơ${d.skipped ? ` • Không thành công ${d.skipped}` : ""}`,
      });
      setBulkResult(d); // luôn hiển thị breakdown chi tiết (kể cả khi skipped=0) để người dùng luôn thấy rõ kết quả
      setNewModalOpen(false);
      setNewSel({});
      setNewDept("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const stats = React.useMemo(
    () => ({
      total: rows.length,
      approved: rows.filter((r) => r.status === "APPROVED").length,
      pending: rows.filter((r) => r.status === "PENDING").length,
      fresh: rows.filter((r) => r.dwMatch === "NEW").length,
      mismatch: rows.filter((r) => r.declaredType === "OLD" && r.dwMatch === "NEW").length,
    }),
    [rows],
  );

  const exportUrl = `/api/export?from=${from}&to=${rangeMode ? to : from}&deptId=${deptFilter}`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { l: "Tổng đơn", v: stats.total, s: rangeMode ? "Khoảng ngày" : "Hôm nay", c: "bg-[#0F3D23] text-white" },
          { l: "Đã xếp việc", v: stats.approved, s: "Đã duyệt", c: "bg-emerald-600 text-white" },
          { l: "Chờ xếp", v: stats.pending, s: "Cần xử lý", c: "bg-amber-500 text-amber-950" },
          { l: "Chưa có DW", v: stats.fresh, s: "Người mới", c: "bg-gold-500 text-hasfarm-900" },
          { l: "Khai sai", v: stats.mismatch, s: "Nói cũ nhưng mới", c: "bg-rose-600 text-white" },
        ].map((k) => (
          <div key={k.l} className={`rounded-[18px] p-4 shadow ${k.c}`}>
            <p className="text-[10px] font-black uppercase tracking-widest opacity-70">{k.l}</p>
            <p className="mt-1 text-[26px] font-black leading-none">{k.v}</p>
            <p className="mt-1 text-[10px] opacity-70">{k.s}</p>
          </div>
        ))}
      </div>

      {/* BOX CHỌN NGÀY */}
      <Card className="rounded-[18px] border border-black/5 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-end gap-2">
          <div className="rounded-xl bg-hasfarm-50 p-2 ring-1 ring-hasfarm-100">
            <label className="flex cursor-pointer items-center gap-2 text-[12px] font-black text-hasfarm-800">
              <input
                type="checkbox"
                checked={rangeMode}
                onChange={(e) => {
                  setRangeMode(e.target.checked);
                  if (!e.target.checked) setTo(from);
                }}
                className="h-4 w-4 accent-hasfarm-700"
              />
              Xem khoảng ngày (tham khảo lịch sử)
            </label>
          </div>
          <div>
            <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-gray-400">
              {rangeMode ? "Từ ngày" : "Ngày"}
            </p>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-10 w-40 rounded-xl font-bold" />
          </div>
          {rangeMode && (
            <div>
              <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-gray-400">Đến ngày</p>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-10 w-40 rounded-xl font-bold" />
            </div>
          )}
          {!rangeMode && (
            <Button
              variant="subtle"
              className="h-10 rounded-xl"
              onClick={() => {
                setFrom(todayStr());
                setTo(todayStr());
              }}
            >
              📅 Về hôm nay
            </Button>
          )}
          <div>
            <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-gray-400">Trạng thái</p>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 rounded-xl border-2 border-gray-200 bg-white px-3 text-[13px] font-bold"
            >
              <option value="ALL">Tất cả</option>
              {statusOptions.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-gray-400">DW Data</p>
            <select
              value={matchFilter}
              onChange={(e) => setMatchFilter(e.target.value)}
              className="h-10 rounded-xl border-2 border-gray-200 bg-white px-3 text-[13px] font-bold"
            >
              <option value="ALL">Tất cả</option>
              <option value="MATCHED">Lao động CŨ</option>
              <option value="NEW">Lao động MỚI</option>
            </select>
          </div>
          <div>
            <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-gray-400">Bộ phận</p>
            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              className="h-10 max-w-[220px] rounded-xl border-2 border-gray-200 bg-white px-3 text-[13px] font-bold"
            >
              <option value="ALL">Tất cả bộ phận</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.deptName}
                  {d.groupName ? ` — ${d.groupName}` : ""}
                </option>
              ))}
            </select>
          </div>
          
          <div>
            <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-gray-400">Hiển thị</p>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="h-10 rounded-xl border-2 border-gray-200 bg-white px-3 text-[13px] font-bold"
            >
              <option value={0}>Tất cả</option>
              <option value={100}>100 hồ sơ đầu tiên</option>
              <option value={200}>200 hồ sơ đầu tiên</option>
              <option value={500}>500 hồ sơ đầu tiên</option>
            </select>
          </div>

          <div className="min-w-[180px] flex-1">
            <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-gray-400">Tìm nhanh</p>
            <Input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder="Tên / CCCD / SĐT"
              className="h-10 rounded-xl"
            />
          </div>
          <Button variant="outline" onClick={() => void load()} className="h-10 rounded-xl">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Tải lại
          </Button>
          <a
            href={exportUrl}
            className="inline-flex h-10 items-center rounded-xl bg-[#0F3D23] px-4 text-[13px] font-black text-white shadow hover:bg-hasfarm-800"
          >
            📊 Xuất Excel
          </a>
          {canEdit && (
            <Button
              variant="gold"
              disabled={newApplicants.length === 0}
              onClick={() => {
                setNewSel(Object.fromEntries(newApplicants.map((r) => [r.id, true])));
                setNewModalOpen(true);
              }}
              className="h-10 rounded-xl shadow-[0_6px_16px_rgba(217,163,39,0.4)]"
            >
              ⚡ Duyệt Người Mới → DW Data ({newApplicants.length})
            </Button>
          )}
        </div>
      </Card>

      {canEdit && selIds.length > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-[18px] border-2 border-gold-400 bg-gradient-to-r from-gold-50 to-white p-3 shadow-lg">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-hasfarm-800 text-sm font-black text-white">
            {selIds.length}
          </span>
          <span className="text-[13px] font-black text-hasfarm-900">
            Đã chọn {selIds.length} (mới: {newInSel}, cũ: {selIds.length - newInSel})
          </span>
          <Button variant="gold" onClick={() => runBulk(selIds, "APPROVED")} disabled={busy} className="rounded-full">
            ✅ Duyệt & Nhập DW Data
          </Button>
          <Button variant="destructive" onClick={() => runBulk(selIds, "REJECTED")} disabled={busy} className="rounded-full">
            ✕ Từ chối
          </Button>
          <Button variant="ghost" onClick={() => setRowSelection({})} className="rounded-full">
            Bỏ chọn
          </Button>
        </div>
      )}

      <Card className="overflow-hidden rounded-[18px] border border-black/5 bg-white p-0 shadow-sm">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-[12px] font-black uppercase tracking-widest text-hasfarm-800">
            Daily Application — sửa trực tiếp như Google Sheet
          </p>
          <Badge tone="gold">{displayData.length} đơn</Badge>
        </div>
        <div className="max-h-[62vh] overflow-auto">
          <table className="grid-sheet w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-[#0F3D23] text-white">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th
                      key={h.id}
                      onClick={h.column.getToggleSortingHandler()}
                      className="cursor-pointer whitespace-nowrap px-2 py-3 text-left text-[10px] font-black uppercase tracking-widest"
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? ""}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={columns.length} className="p-12 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
                  </td>
                </tr>
              )}
              {!loading && table.getRowModel().rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="p-12 text-center text-sm text-gray-400">
                    Chưa có đơn nào {rangeMode ? "trong khoảng ngày này" : `ngày ${formatDate(from)}`}.
                  </td>
                </tr>
              )}
              {!loading &&
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className={cn("hover:bg-gold-50/60", row.getIsSelected() && "bg-gold-50")}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-1 py-1 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* MODAL DUYỆT NGƯỜI MỚI */}
      <Modal open={newModalOpen} onClose={() => setNewModalOpen(false)} title="⚡ Duyệt Người Mới & Thêm vào DW Data" width="max-w-3xl">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-gold-50 p-3 ring-1 ring-gold-200">
            <p className="text-sm font-bold text-hasfarm-900">
              {newApplicants.length} người chưa có trong DW Data — tick chọn để import 1 lần.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setNewSel(Object.fromEntries(newApplicants.map((r) => [r.id, true])))}
                className="rounded-full bg-hasfarm-700 px-3 py-1.5 text-[11px] font-black text-white"
              >
                Chọn tất cả
              </button>
              <button onClick={() => setNewSel({})} className="rounded-full bg-gray-200 px-3 py-1.5 text-[11px] font-black text-gray-700">
                Bỏ chọn
              </button>
            </div>
          </div>

          <div className="max-h-[44vh] overflow-y-auto rounded-2xl border">
            <table className="grid-sheet w-full text-[13px]">
              <thead className="sticky top-0 bg-[#0F3D23] text-white">
                <tr>
                  <th className="w-10 px-2 py-2.5 text-center text-[10px] font-black">
                    <div className="pl-6">✓</div>
                  </th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-black uppercase">CCCD</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-black uppercase">Họ và tên</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-black uppercase">SĐT</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-black uppercase">Tự khai</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-black uppercase">Bộ phận</th>
                </tr>
              </thead>
              <tbody>
                {newApplicants.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-gray-400">
                      🎉 Không còn người mới nào chờ duyệt.
                    </td>
                  </tr>
                )}
                {newApplicants.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setNewSel((s) => ({ ...s, [r.id]: !s[r.id] }))}
                    className={cn("cursor-pointer hover:bg-gold-50", newSel[r.id] && "bg-gold-50")}
                  >
                    <td className="px-2 py-2 text-center">
                      <div className="pl-6">
                        <input
                          type="checkbox"
                          checked={!!newSel[r.id]}
                          onChange={() => setNewSel((s) => ({ ...s, [r.id]: !s[r.id] }))}
                          onClick={(e) => e.stopPropagation()}
                          className="h-4 w-4 accent-gold-500 cursor-pointer"
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono font-bold">{r.cccd}</td>
                    <td className="px-3 py-2 font-bold text-hasfarm-900">{r.fullName}</td>
                    <td className="px-3 py-2">{r.phone}</td>
                    <td className="px-3 py-2">
                      {r.declaredType === "OLD" ? (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-black text-rose-700">
                          Khai CŨ ⚠️
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600">Khai MỚI</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[12px]">
                      {r.deptName ?? <span className="font-bold text-amber-600">Chưa xếp</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <p className="mb-1 text-[11px] font-black uppercase tracking-widest text-gray-500">
              Xếp cả nhóm vào bộ phận (tuỳ chọn)
            </p>
            <select
              value={newDept}
              onChange={(e) => setNewDept(e.target.value)}
              className="h-12 w-full rounded-xl border-2 border-gray-200 bg-white px-3 text-sm font-bold"
            >
              <option value="">— Giữ nguyên bộ phận từng người —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.deptName}
                  {d.groupName ? ` — ${d.groupName}` : ""} {d.vnName ? `(${d.vnName})` : ""}
                </option>
              ))}
            </select>
          </div>

          <Button
            variant="gold"
            size="xl"
            className="w-full rounded-[14px]"
            disabled={busy || newSelIds.length === 0}
            onClick={() => runBulk(newSelIds, "APPROVED", newDept)}
          >
            {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : `✓ Xác nhận Import (${newSelIds.length} người) vào DW Data`}
          </Button>
        </div>
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={`Hồ sơ: ${detail?.fullName ?? ""}`} width="max-w-2xl">
        {detail && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ["CCCD", detail.cccd],
                ["Mã DW", detail.dwCode ?? "Chưa có"],
                ["SĐT", detail.phone],
                ["Giới tính", detail.gender ?? "—"],
                ["Ngày sinh", detail.dob ?? "—"],
                ["Dân tộc", detail.ethnicity ?? "—"],
                ["Thời gian ĐK làm", detail.workDuration ?? "—"],
                ["Kênh giới thiệu", detail.referralChannel ?? "—"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-gray-50 p-3">
                  <p className="text-[10px] font-bold uppercase text-gray-400">{k}</p>
                  <p className="font-bold">{v}</p>
                </div>
              ))}
              <div className="col-span-2 rounded-xl bg-gray-50 p-3">
                <p className="text-[10px] font-bold uppercase text-gray-400">Địa chỉ hiện tại</p>
                <p className="text-sm">{detail.residentialAddress ?? detail.permanentAddress ?? "—"}</p>
              </div>
            </div>
            <div
              className={cn(
                "rounded-xl p-3 text-sm ring-1",
                detail.dwMatch === "MATCHED"
                  ? "bg-emerald-50 text-emerald-900 ring-emerald-200"
                  : "bg-amber-50 text-amber-900 ring-amber-200",
              )}
            >
              <b>Đối chiếu DW Data:</b>{" "}
              {detail.dwMatch === "MATCHED"
                ? `Lao động CŨ — đã có hồ sơ trong DW Data (${detail.dwCode ?? "no code"})`
                : "Lao động MỚI — chưa có trong DW Data, cần duyệt để thêm vào"}
              {detail.declaredType === "OLD" && detail.dwMatch === "NEW" && (
                <p className="mt-1 font-bold">⚠️ Người này TỰ KHAI là đã từng làm nhưng không tìm thấy trong DW Data.</p>
              )}
            </div>
            {Object.entries(detail.customAnswers ?? {}).length > 0 && (
              <div className="rounded-2xl border bg-white p-4">
                <p className="mb-2 text-[11px] font-black uppercase tracking-widest text-hasfarm-700">Câu hỏi khảo sát</p>
                <ul className="space-y-1.5">
                  {Object.entries(detail.customAnswers ?? {}).map(([k, v]) => (
                    <li key={k} className="flex gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm">
                      <b className="shrink-0 text-hasfarm-800">{k}:</b>
                      <span>{v}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>

      {historyRow && (
        <HistoryPanel
          row={historyRow}
          canRestore={canEdit}
          onClose={() => setHistoryRow(null)}
          onRestored={() => void load()}
        />
      )}

      {bulkResult && (
        <Modal open onClose={() => setBulkResult(null)} title="Kết quả xử lý" width="max-w-xl">
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-emerald-50 p-3">
                <p className="text-2xl font-black text-emerald-700">{bulkResult.imported}</p>
                <p className="text-[11px] font-bold uppercase text-emerald-700">Đã duyệt</p>
              </div>
              <div className="rounded-xl bg-hasfarm-50 p-3">
                <p className="text-2xl font-black text-hasfarm-800">{bulkResult.newToDw}</p>
                <p className="text-[11px] font-bold uppercase text-hasfarm-800">Đã thêm (DW Data)</p>
              </div>
              <div className={cn("rounded-xl p-3", bulkResult.skipped > 0 ? "bg-red-50" : "bg-gray-50")}>
                <p className={cn("text-2xl font-black", bulkResult.skipped > 0 ? "text-red-600" : "text-gray-400")}>
                  {bulkResult.skipped}
                </p>
                <p className={cn("text-[11px] font-bold uppercase", bulkResult.skipped > 0 ? "text-red-600" : "text-gray-400")}>
                  Không thành công
                </p>
              </div>
            </div>

            {bulkResult.skipped > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-black uppercase tracking-widest text-gray-400">Nguyên nhân</p>
                <ul className="max-h-64 space-y-1 overflow-y-auto rounded-xl border p-2">
                  {bulkResult.results
                    .filter((r) => !r.ok)
                    .map((r) => (
                      <li key={r.id} className="rounded-lg bg-red-50 px-2 py-1.5 text-xs">
                        <span className="font-bold">{r.fullName ?? r.cccd ?? r.id}</span>
                        {r.cccd ? ` (${r.cccd})` : ""} — {r.reason}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            <Button variant="gold" className="w-full" onClick={() => setBulkResult(null)}>
              Đóng
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
