"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { Badge, Button, Card, Input, MetricStrip, MetricStripItem, Modal, toast, cn } from "@/components/ui";
import { formatDate, STATUS_META, todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { CCCD_ERROR_MESSAGE, isValidCccd, normalizeCccd } from "@/lib/validators";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  History,
  Loader2,
  RefreshCw,
  ShieldCheck,
  UserPlus2,
  X,
  Zap,
} from "lucide-react";

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
  itCode: string | null;
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
  inputMode,
  maxLength,
  transformInput,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
  inputMode?: React.ComponentProps<"input">["inputMode"];
  maxLength?: number;
  transformInput?: (value: string) => string;
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
          "block w-full truncate rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-primary-tint hover:ring-1 hover:ring-primary/25",
          !value && "text-fg-muted",
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
      inputMode={inputMode}
      maxLength={maxLength}
      onChange={(e) => setDraft(transformInput ? transformInput(e.target.value) : e.target.value)}
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
      className="w-full rounded-[6px] border-2 border-primary bg-surface px-2 py-1 text-[13px] shadow-sm outline-none"
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
      toast({ title: "Đã khôi phục về phiên bản này" });
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
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
        </div>
      ) : logs.length === 0 ? (
        <p className="p-6 text-center text-sm text-fg-muted">Chưa có lịch sử chỉnh sửa nào cho hồ sơ này.</p>
      ) : (
        <ul className="max-h-[60vh] space-y-3 overflow-y-auto">
          {logs.map((l) => {
            const before = l.details?.before ?? {};
            const after = l.details?.after ?? {};
            const changedKeys = Object.keys(after).filter((k) => k !== "updatedAt");
            return (
              <li key={l.id} className="rounded-[10px] border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[12px] font-semibold text-fg">
                    {l.action} · {l.username ?? "—"}
                  </p>
                  <p className="text-[11px] text-fg-muted">{new Date(l.createdAt).toLocaleString("vi-VN")}</p>
                </div>
                {l.details?.reason && <p className="mt-1 text-[12px] italic text-fg-secondary">Lý do: {l.details.reason}</p>}
                {changedKeys.length > 0 && (
                  <table className="mt-2 w-full text-[12px]">
                    <tbody>
                      {changedKeys.map((k) => {
                        const rawBefore = String(before[k] ?? "—");
                        const rawAfter = String(after[k] ?? "—");
                        // Chuẩn hoá khi hiển thị trường fullName (dữ liệu legacy có thể chưa chuẩn).
                        const displayBefore = k === "fullName" ? normalizePersonName(rawBefore) : rawBefore;
                        const displayAfter = k === "fullName" ? normalizePersonName(rawAfter) : rawAfter;
                        return (
                          <tr key={k} className="border-t border-border">
                            <td className="py-1 pr-2 font-mono text-fg-muted">{k}</td>
                            <td className="py-1 pr-2 text-danger line-through">{displayBefore}</td>
                            <td className="py-1 text-success">{displayAfter}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {canRestore && before && Object.keys(before).length > 0 && (
                  <button
                    onClick={() => restore(l.id)}
                    disabled={busyId === l.id}
                    className="mt-2 rounded-full bg-surface-hover px-3 py-1 text-[11px] font-semibold text-fg-secondary hover:bg-border disabled:opacity-50"
                  >
                    {busyId === l.id ? "Đang khôi phục…" : "Khôi phục về trước lần sửa này"}
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
  // MẶC ĐỊNH CHỈ HÔM NAY (màn hình tinh gọn) — trừ khi đến từ Tìm kiếm toàn hệ thống
  // (?q=&from=&to=&rangeMode=1), lúc đó mở đúng khoảng ngày + từ khoá của kết quả đã bấm.
  const searchParams = useSearchParams();
  const [from, setFrom] = React.useState(() => searchParams.get("from") || todayStr());
  const [to, setTo] = React.useState(() => searchParams.get("to") || todayStr());
  const [rangeMode, setRangeMode] = React.useState(() => searchParams.get("rangeMode") === "1");
  const [statusFilter, setStatusFilter] = React.useState("ALL");
  const [deptFilter, setDeptFilter] = React.useState("ALL");
  const [matchFilter, setMatchFilter] = React.useState("ALL");
  const [globalFilter, setGlobalFilter] = React.useState(() => searchParams.get("q") ?? "");
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
  // Xác nhận đồng bộ IT CODE sang DW Data trước khi ghi (chỉ áp dụng cho lao động ĐÃ có DW Data).
  const [itCodeConfirm, setItCodeConfirm] = React.useState<{ id: string; value: string; workerName: string } | null>(null);

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
      if (patch.cccd !== undefined) {
        const cccd = normalizeCccd(patch.cccd);
        if (!isValidCccd(cccd)) {
          toast({ title: CCCD_ERROR_MESSAGE, variant: "destructive" });
          return;
        }
        patch = { ...patch, cccd };
      }

      const prev = rows;
      setRows((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      try {
        const body: Record<string, unknown> = {};
        (
          ["cccd", "fullName", "gender", "dob", "phone", "ethnicity", "residentialAddress",
           "deptId", "status", "noteWorker", "appointmentList", "workDuration", "itCode"] as const
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
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={table.getIsAllRowsSelected()}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      }),
      ch.accessor("regDate", {
        header: "Ngày",
        cell: (i) => (
          <span className="block px-2 text-center text-[12px] font-semibold text-fg-secondary">
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
              inputMode="numeric"
              maxLength={12}
              transformInput={(value) => value.replace(/\D/g, "").slice(0, 12)}
              className="font-mono font-semibold"
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
                onCommit={(v) => patchRow(i.row.original.id, { fullName: normalizePersonName(v) })}
                className="font-semibold text-fg"
              />
            ) : (
              <span className="px-2 text-[13px] font-semibold text-fg">{i.getValue()}</span>
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
                <Badge tone="green">
                  <ShieldCheck className="h-3 w-3" /> CŨ
                </Badge>
              ) : (
                <Badge tone="amber">
                  <UserPlus2 className="h-3 w-3" /> MỚI
                </Badge>
              )}
              {lie && (
                <span title="Tự khai là CŨ nhưng không có trong DW Data" className="text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                </span>
              )}
            </span>
          );
        },
      }),
      ch.accessor("itCode", {
        header: "IT CODE",
        cell: (i) => {
          const val = i.getValue() ?? "";
          if (!canEdit) return <span className="px-2 font-mono text-[12px]">{val || "—"}</span>;
          return (
            <EditableCell
              value={val}
              placeholder="Nhập IT CODE"
              className="font-mono text-[12px]"
              onCommit={(v) => {
                const itCode = v.trim();
                if (i.row.original.dwMatch === "MATCHED") {
                  // Lao động CŨ đã có DW Data -> cảnh báo đồng bộ trước khi ghi.
                  setItCodeConfirm({ id: i.row.original.id, value: itCode, workerName: i.row.original.fullName });
                } else {
                  void patchRow(i.row.original.id, { itCode: itCode || null });
                }
              }}
            />
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
        cell: (i) => <span className="block px-1 text-center text-[12px] text-fg-secondary">{i.getValue() ?? "—"}</span>,
      }),
      ch.accessor("age", {
        header: "Tuổi",
        cell: (i) => <span className="block px-1 text-center text-[12px] font-semibold text-fg-secondary">{i.getValue() ?? "—"}</span>,
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
              className="w-full max-w-[210px] rounded-[6px] border border-transparent bg-transparent px-1 py-1.5 text-[12px] font-semibold text-fg hover:border-border-strong"
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
            <span className="px-2 text-[12px] text-fg-secondary">
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
                "w-full rounded-full border px-2 py-1.5 text-[11px] font-semibold",
                i.getValue() === "APPROVED"
                  ? "border-success/25 bg-success-tint text-success"
                  : i.getValue() === "REJECTED"
                    ? "border-danger/25 bg-danger-tint text-danger"
                    : "border-warning/25 bg-warning-tint text-warning",
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
              className="rounded-full bg-primary-tint px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary/15"
            >
              Chi tiết
            </button>
            <button
              onClick={() => setHistoryRow(row.original)}
              className="flex items-center gap-1 rounded-full bg-surface-hover px-2 py-1 text-[11px] font-semibold text-fg-secondary hover:bg-border"
              title="Xem lịch sử chỉnh sửa"
            >
              <History className="h-3 w-3" /> Lịch sử
            </button>
          </div>
        ),
      }),
    ],
    [canEdit, ch, departments, patchRow, statusOptions, stageMeta],
  );

  const table = useReactTable({
    data: rows,
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
  const selRows = rows.filter((r) => selIds.includes(r.id));
  const newInSel = selRows.filter((r) => r.dwMatch === "NEW").length;
  const newApplicants = React.useMemo(() => rows.filter((r) => r.dwMatch === "NEW"), [rows]);
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
      <MetricStrip
        items={[
          <MetricStripItem key="total" icon={<FileText className="h-4 w-4" />} value={stats.total} label="Tổng đơn" context={rangeMode ? "Khoảng ngày" : "Hôm nay"} tone="primary" />,
          <MetricStripItem key="approved" icon={<CheckCircle2 className="h-4 w-4" />} value={stats.approved} label="Đã xếp việc" context="Đã duyệt" tone="success" />,
          <MetricStripItem key="pending" icon={<Clock className="h-4 w-4" />} value={stats.pending} label="Chờ xếp" context="Cần xử lý" tone="warning" />,
          <MetricStripItem key="fresh" icon={<UserPlus2 className="h-4 w-4" />} value={stats.fresh} label="Chưa có DW" context="Người mới" tone="accent" />,
          <MetricStripItem key="mismatch" icon={<AlertTriangle className="h-4 w-4" />} value={stats.mismatch} label="Khai sai" context="Nói cũ nhưng mới" tone="danger" />,
        ]}
      />

      {/* BOX CHỌN NGÀY */}
      <Card className="p-3 shadow-[0_1px_2px_rgba(23,32,18,0.04),0_8px_24px_rgba(23,32,18,0.05)]">
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="rounded-[10px] bg-primary-tint px-3 py-2">
            <label className="flex cursor-pointer items-center gap-2 text-[12px] font-semibold text-primary">
              <input
                type="checkbox"
                checked={rangeMode}
                onChange={(e) => {
                  setRangeMode(e.target.checked);
                  if (!e.target.checked) setTo(from);
                }}
                className="h-4 w-4 accent-primary"
              />
              Xem khoảng ngày (tham khảo lịch sử)
            </label>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">
              {rangeMode ? "Từ ngày" : "Ngày"}
            </p>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-10 w-40" />
          </div>
          {rangeMode && (
            <div>
              <p className="mb-1 text-[11px] font-semibold text-fg-muted">Đến ngày</p>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-10 w-40" />
            </div>
          )}
          {!rangeMode && (
            <Button
              variant="outline"
              className="h-10"
              onClick={() => {
                setFrom(todayStr());
                setTo(todayStr());
              }}
            >
              <Calendar className="h-4 w-4" /> Về hôm nay
            </Button>
          )}
          <div>
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">Trạng thái</p>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 rounded-[10px] border border-border-strong bg-surface px-3 text-[13px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
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
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">DW Data</p>
            <select
              value={matchFilter}
              onChange={(e) => setMatchFilter(e.target.value)}
              className="h-10 rounded-[10px] border border-border-strong bg-surface px-3 text-[13px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            >
              <option value="ALL">Tất cả</option>
              <option value="MATCHED">Người tập nghề CŨ</option>
              <option value="NEW">Người tập nghề MỚI</option>
            </select>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">Bộ phận</p>
            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              className="h-10 max-w-[220px] rounded-[10px] border border-border-strong bg-surface px-3 text-[13px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
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
          <div className="min-w-[180px] flex-1">
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">Tìm nhanh</p>
            <Input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder="Tên / CCCD / SĐT"
              className="h-10"
            />
          </div>
          <Button variant="outline" onClick={() => void load()} className="h-10">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Tải lại
          </Button>
          <a
            href={exportUrl}
            className="inline-flex h-10 items-center gap-1.5 rounded-[10px] bg-primary px-4 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover"
          >
            <Download className="h-4 w-4" /> Xuất Excel
          </a>
          {canEdit && (
            <Button
              variant="primary"
              disabled={newApplicants.length === 0}
              onClick={() => {
                setNewSel(Object.fromEntries(newApplicants.map((r) => [r.id, true])));
                setNewModalOpen(true);
              }}
              className="h-10"
            >
              <Zap className="h-4 w-4" /> Duyệt Người Mới → DW Data ({newApplicants.length})
            </Button>
          )}
        </div>
      </Card>

      {canEdit && selIds.length > 0 && (
        <div className="animate-slide-up sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-[14px] border border-primary/30 bg-primary p-3 shadow-[0_10px_24px_rgba(15,68,36,0.35)]">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-bold text-white shadow-[0_0_0_3px_rgba(226,109,28,0.25)]">
            {selIds.length}
          </span>
          <span className="text-[13px] font-semibold text-white/90">
            Đã chọn {selIds.length} (mới: {newInSel}, cũ: {selIds.length - newInSel})
          </span>
          <Button variant="primary" onClick={() => runBulk(selIds, "APPROVED")} disabled={busy} loading={busy} size="sm">
            Duyệt &amp; Nhập DW Data
          </Button>
          <Button variant="destructive" onClick={() => runBulk(selIds, "REJECTED")} disabled={busy} size="sm">
            <X className="h-3.5 w-3.5" /> Từ chối
          </Button>
          <Button variant="ghost" onClick={() => setRowSelection({})} size="sm" className="text-white/80 hover:bg-white/10 hover:text-white">
            Bỏ chọn
          </Button>
        </div>
      )}

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-[13px] font-semibold text-fg">
            Daily Application — sửa trực tiếp như Google Sheet
          </p>
          <Badge tone="gray">{rows.length} đơn</Badge>
        </div>
        <div className="v2-scroll max-h-[62vh] overflow-auto">
          <table className="grid-sheet w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-primary-tint/95 shadow-[inset_0_-1px_0_var(--color-border)] backdrop-blur">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th
                      key={h.id}
                      onClick={h.column.getToggleSortingHandler()}
                      className="cursor-pointer whitespace-nowrap px-2 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary"
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
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
                  </td>
                </tr>
              )}
              {!loading && table.getRowModel().rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="p-12 text-center text-sm text-fg-muted">
                    Chưa có đơn nào {rangeMode ? "trong khoảng ngày này" : `ngày ${formatDate(from)}`}.
                  </td>
                </tr>
              )}
              {!loading &&
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={cn(
                      "border-b border-border/70 bg-surface transition-colors hover:bg-botanical-50",
                      row.getIsSelected() && "bg-accent-tint shadow-[inset_3px_0_0_0_#e26d1c] hover:bg-accent-tint",
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={cn(
                          "px-1 py-1 align-middle",
                          ["dwMatch", "phone", "deptId"].includes(cell.column.id) && "hidden md:table-cell",
                          ["gender", "age", "noteWorker"].includes(cell.column.id) && "hidden lg:table-cell",
                        )}
                      >
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
      <Modal open={newModalOpen} onClose={() => setNewModalOpen(false)} title="Duyệt Người Mới & Thêm vào DW Data" width="max-w-3xl">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-primary-tint p-3">
            <p className="text-sm font-semibold text-fg">
              {newApplicants.length} người chưa có trong DW Data — tick chọn để import 1 lần.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setNewSel(Object.fromEntries(newApplicants.map((r) => [r.id, true])))}
                className="rounded-full bg-primary px-3 py-1.5 text-[11px] font-semibold text-white"
              >
                Chọn tất cả
              </button>
              <button onClick={() => setNewSel({})} className="rounded-full bg-surface-hover px-3 py-1.5 text-[11px] font-semibold text-fg-secondary">
                Bỏ chọn
              </button>
            </div>
          </div>

          <div className="max-h-[44vh] overflow-y-auto rounded-[12px] border border-border">
            <table className="grid-sheet w-full text-[13px]">
              <thead className="sticky top-0 bg-primary-tint text-primary">
                <tr>
                  <th className="w-10 px-2 py-2.5 text-center text-[10px] font-semibold">✓</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase">CCCD</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase">Họ và tên</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase">SĐT</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase">Tự khai</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase">Bộ phận</th>
                </tr>
              </thead>
              <tbody>
                {newApplicants.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-fg-muted">
                      Không còn người mới nào chờ duyệt.
                    </td>
                  </tr>
                )}
                {newApplicants.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setNewSel((s) => ({ ...s, [r.id]: !s[r.id] }))}
                    className={cn("cursor-pointer border-t border-border hover:bg-surface-hover", newSel[r.id] && "bg-primary-tint")}
                  >
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={!!newSel[r.id]}
                        onChange={() => setNewSel((s) => ({ ...s, [r.id]: !s[r.id] }))}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 accent-primary"
                      />
                    </td>
                    <td className="px-3 py-2 font-mono font-semibold">{r.cccd}</td>
                    <td className="px-3 py-2 font-semibold text-fg">{r.fullName}</td>
                    <td className="px-3 py-2">{r.phone}</td>
                    <td className="px-3 py-2">
                      {r.declaredType === "OLD" ? (
                        <Badge tone="red" dot>Khai CŨ</Badge>
                      ) : (
                        <Badge tone="gray">Khai MỚI</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[12px]">
                      {r.deptName ?? <span className="font-semibold text-warning">Chưa xếp</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <p className="mb-1 text-[11px] font-semibold text-fg-muted">
              Xếp cả nhóm vào bộ phận (tuỳ chọn)
            </p>
            <select
              value={newDept}
              onChange={(e) => setNewDept(e.target.value)}
              className="h-12 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-sm font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
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
            variant="primary"
            size="xl"
            className="w-full"
            disabled={busy || newSelIds.length === 0}
            loading={busy}
            onClick={() => runBulk(newSelIds, "APPROVED", newDept)}
          >
            Xác nhận Import ({newSelIds.length} người) vào DW Data
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
                ["IT CODE", detail.itCode ?? "—"],
                ["SĐT", detail.phone],
                ["Giới tính", detail.gender ?? "—"],
                ["Ngày sinh", detail.dob ?? "—"],
                ["Dân tộc", detail.ethnicity ?? "—"],
                ["Thời gian ĐK làm", detail.workDuration ?? "—"],
                ["Kênh giới thiệu", detail.referralChannel ?? "—"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-[10px] bg-surface-hover p-3">
                  <p className="text-[10px] font-semibold uppercase text-fg-muted">{k}</p>
                  <p className="font-semibold text-fg">{v}</p>
                </div>
              ))}
              <div className="col-span-2 rounded-[10px] bg-surface-hover p-3">
                <p className="text-[10px] font-semibold uppercase text-fg-muted">Địa chỉ hiện tại</p>
                <p className="text-sm text-fg">{detail.residentialAddress ?? detail.permanentAddress ?? "—"}</p>
              </div>
            </div>
            <div
              className={cn(
                "rounded-[10px] p-3 text-sm ring-1",
                detail.dwMatch === "MATCHED"
                  ? "bg-success-tint text-success ring-success/20"
                  : "bg-warning-tint text-warning ring-warning/20",
              )}
            >
              <b>Đối chiếu DW Data:</b>{" "}
              {detail.dwMatch === "MATCHED"
                ? `Người tập nghề CŨ — đã có hồ sơ trong DW Data (${detail.dwCode ?? "no code"})`
                : "Người tập nghề MỚI — chưa có trong DW Data, cần duyệt để thêm vào"}
              {detail.declaredType === "OLD" && detail.dwMatch === "NEW" && (
                <p className="mt-1 flex items-center gap-1.5 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> Người này TỰ KHAI là đã từng làm nhưng không tìm thấy trong DW Data.
                </p>
              )}
            </div>
            {Object.entries(detail.customAnswers ?? {}).length > 0 && (
              <div className="rounded-[14px] border border-border bg-surface p-4">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-secondary">Câu hỏi khảo sát</p>
                <ul className="space-y-1.5">
                  {Object.entries(detail.customAnswers ?? {}).map(([k, v]) => (
                    <li key={k} className="flex gap-2 rounded-[8px] bg-surface-hover px-3 py-2 text-sm">
                      <b className="shrink-0 text-fg">{k}:</b>
                      <span className="text-fg-secondary">{v}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>

      {itCodeConfirm && (
        <Modal open onClose={() => setItCodeConfirm(null)} title="Cập nhật IT CODE đồng bộ DW Data" width="max-w-md">
          <div className="space-y-4">
            <div className="rounded-[12px] border border-warning/30 bg-warning-tint p-3 text-[13px] leading-6 text-fg-secondary">
              Lao động <b className="text-fg">{itCodeConfirm.workerName}</b> đã có hồ sơ trong DW Data.
              Giá trị <b className="text-fg">IT CODE</b> sẽ được cập nhật <b className="text-fg">đồng thời</b> vào:
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Daily Application (<span className="font-mono text-[11px]">daily_applications.it_code</span>)</li>
                <li>Hồ sơ Tập nghề — mã vân tay (<span className="font-mono text-[11px]">worker_profiles.fingerprint_code</span>)</li>
                <li>DW Data (<span className="font-mono text-[11px]">dw_data.it_code</span>)</li>
              </ul>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setItCodeConfirm(null)}>Hủy</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const { id, value } = itCodeConfirm;
                  setItCodeConfirm(null);
                  void patchRow(id, { itCode: value || null });
                }}
              >
                Xác nhận & cập nhật
              </Button>
            </div>
          </div>
        </Modal>
      )}

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
              <div className="rounded-[10px] bg-success-tint p-3">
                <p className="text-2xl font-bold text-success">{bulkResult.imported}</p>
                <p className="text-[11px] font-semibold uppercase text-success">Đã duyệt</p>
              </div>
              <div className="rounded-[10px] bg-primary-tint p-3">
                <p className="text-2xl font-bold text-primary">{bulkResult.newToDw}</p>
                <p className="text-[11px] font-semibold uppercase text-primary">Đã thêm (DW Data)</p>
              </div>
              <div className={cn("rounded-[10px] p-3", bulkResult.skipped > 0 ? "bg-danger-tint" : "bg-surface-hover")}>
                <p className={cn("text-2xl font-bold", bulkResult.skipped > 0 ? "text-danger" : "text-fg-muted")}>
                  {bulkResult.skipped}
                </p>
                <p className={cn("text-[11px] font-semibold uppercase", bulkResult.skipped > 0 ? "text-danger" : "text-fg-muted")}>
                  Không thành công
                </p>
              </div>
            </div>

            {bulkResult.skipped > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Nguyên nhân</p>
                <ul className="max-h-64 space-y-1 overflow-y-auto rounded-[10px] border border-border p-2">
                  {bulkResult.results
                    .filter((r) => !r.ok)
                    .map((r) => (
                      <li key={r.id} className="rounded-[8px] bg-danger-tint px-2 py-1.5 text-xs text-danger">
                        <span className="font-semibold">{r.fullName ?? r.cccd ?? r.id}</span>
                        {r.cccd ? ` (${r.cccd})` : ""} — {r.reason}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            <Button variant="primary" className="w-full" onClick={() => setBulkResult(null)}>
              Đóng
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
