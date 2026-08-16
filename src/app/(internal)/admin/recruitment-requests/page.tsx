"use client";

/* ============================================================
   WORKFORCE RECRUITMENT REQUEST — BẢNG KẾ HOẠCH NHU CẦU
   ------------------------------------------------------------
   Yêu cầu #2  : KHÔNG hardcode danh sách cột. Toàn bộ cột đến từ
                 /api/planning/column-config (catalog + cấu hình DB
                 theo vai trò và theo thiết bị).
   Yêu cầu #3  : nút Import / Sửa / Chuyển phân bổ chỉ hiện khi có
                 quyền tương ứng (server vẫn kiểm tra lại).
   Yêu cầu #5  : mặc định sắp xếp theo Ngày cần nhân lực, nhóm
                 "Quá hạn / Cần xử lý" lên đầu.
   Yêu cầu #12 : bộ lọc đầy đủ, Column Chooser, cột ghim, chế độ
                 thẻ + ngăn chi tiết cho điện thoại.
   ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  FormField,
  Modal,
  PageHeader,
  SectionLabel,
  StatusBadge,
  cn,
  toast,
} from "@/components/ui";
import { fetchJsonWithTimeout, type ApiResult } from "@/lib/api-client";
import { ColumnChooser } from "@/components/planning/column-chooser";
import { ReallocationPanel } from "@/components/planning/reallocation-panel";
import {
  bucketLabel,
  expectedDateBucket,
  SORT_BUCKET_OVERDUE,
} from "@/lib/planning-recruitment-core";
import type { ResolvedColumn } from "@/lib/recruitment-request-columns";
import {
  ClipboardPaste,
  Search,
  CheckSquare,
  Square,
  Trash2,
  Play,
  XCircle,
  FileSpreadsheet,
  Eye,
  AlertTriangle,
  FileUp,
  FileDown,
  Columns3,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Loader2,
  Shuffle,
  X,
} from "lucide-react";

/* ============================================================
   TYPES
   ============================================================ */
type RecruitmentRequest = {
  id: string;
  requestCode: string;
  requester: string;
  status: string;
  totalBalance: number;
  expectedDate: string | null;
  [key: string]: unknown;
};

type Capabilities = {
  canImport: boolean;
  canEdit: boolean;
  canReallocate: boolean;
  canManageColumns: boolean;
  canComment: boolean;
  canRequest: boolean;
};

type ImportPreviewRow = {
  rowIndex: number;
  requestCode: string;
  mapped: Record<string, string>;
  unknownHeaders: string[];
  valid: boolean;
  errors: { field: string; message: string }[];
  warnings: { field: string; message: string }[];
};

type ImportPreviewData = {
  totalRows: number;
  validCount: number;
  errorCount: number;
  unknownHeaders: string[];
  hasHeaderRow: boolean;
  preview: ImportPreviewRow[];
  previewFull: ImportPreviewRow[];
};

const EMPTY_CAPS: Capabilities = {
  canImport: false,
  canEdit: false,
  canReallocate: false,
  canManageColumns: false,
  canComment: false,
  canRequest: false,
};

/* ============================================================
   PARSER (Client-side TSV — dán trực tiếp từ Excel/Google Sheets)
   ============================================================ */
function parseClipboardTable(text: string): string[][] {
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  if (!input) return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; }
      else { cell += char; }
      continue;
    }
    if (char === '"' && cell.length === 0) { quoted = true; }
    else if (char === "\t") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else { cell += char; }
  }
  row.push(cell.replace(/\r$/, ""));
  rows.push(row);
  while (rows.length > 0 && rows[rows.length - 1].every((v) => v === "")) rows.pop();
  return rows;
}

function tsvToRecords(rows: string[][]): Record<string, string>[] {
  if (rows.length < 1) return [];
  const headers = rows[0].map((h) => h.trim());
  const records: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) record[headers[j]] = row[j]?.trim() ?? "";
    records.push(record);
  }
  return records;
}

/* ============================================================
   HIỂN THỊ Ô THEO KIỂU CỘT
   ============================================================ */
function formatDate(d?: string | null) {
  if (!d) return "—";
  const [y, m, day] = String(d).split("-");
  if (!day) return String(d);
  return `${day}/${m}/${y}`;
}

function renderCellValue(col: ResolvedColumn, row: RecruitmentRequest) {
  const raw = row[col.key];
  if (col.type === "status") return <StatusBadge status={String(raw ?? "")} />;
  if (raw === null || raw === undefined || raw === "") return <span className="text-fg-muted">—</span>;

  switch (col.type) {
    case "date":
      return formatDate(String(raw));
    case "percent":
      return `${Number(raw)}%`;
    case "money":
      return Number(raw).toLocaleString("vi-VN");
    case "days": {
      const n = Number(raw);
      return <span className={n > 0 ? "text-warning" : "text-success"}>{n > 0 ? `+${n}` : n} ngày</span>;
    }
    case "number":
      return <span className="tabular-nums">{Number(raw)}</span>;
    case "longtext":
      return (
        <span className="line-clamp-2 text-[12px]" title={String(raw)}>
          {String(raw)}
        </span>
      );
    default:
      return String(raw);
  }
}

const ALIGN_RIGHT = new Set(["number", "money", "percent", "days"]);

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ============================================================
   TRANG
   ============================================================ */
export default function RecruitmentRequestsPage() {
  const searchParams = useSearchParams();

  const [rows, setRows] = useState<RecruitmentRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  // --- Cấu hình cột (Yêu cầu #2) --------------------------------------
  const [columns, setColumns] = useState<ResolvedColumn[]>([]);
  const [caps, setCaps] = useState<Capabilities>(EMPTY_CAPS);
  const [role, setRole] = useState("");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [columnsLoading, setColumnsLoading] = useState(true);
  const [chooserOpen, setChooserOpen] = useState(false);

  // --- Sắp xếp (Yêu cầu #5) -------------------------------------------
  const [sortBy, setSortBy] = useState("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // --- Bộ lọc (Yêu cầu #12) -------------------------------------------
  const [monthFilter, setMonthFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [divisionFilter, setDivisionFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [sectionFilter, setSectionFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [requesterFilter, setRequesterFilter] = useState("");
  const [reasonFilter, setReasonFilter] = useState("");
  const [fulfillmentFilter, setFulfillmentFilter] = useState("");
  const [requestedFrom, setRequestedFrom] = useState("");
  const [requestedTo, setRequestedTo] = useState("");
  const [expectedFrom, setExpectedFrom] = useState("");
  const [expectedTo, setExpectedTo] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [distinct, setDistinct] = useState<Record<string, string[]>>({});

  // --- Import ---------------------------------------------------------
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreviewData | null>(null);
  const [importing, setImporting] = useState(false);
  const [importSkipDup, setImportSkipDup] = useState(false);
  const [importUpdateDup, setImportUpdateDup] = useState(true);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // --- Chuyển phân bổ (Yêu cầu #7, #8) --------------------------------
  const [reallocFrom, setReallocFrom] = useState<{ id: string; code: string } | null>(null);

  // --- Chi tiết (mobile drawer) ---------------------------------------
  const [detailRow, setDetailRow] = useState<RecruitmentRequest | null>(null);

  const [batchLoading, setBatchLoading] = useState(false);

  /* ---------- phát hiện thiết bị ---------- */
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setDevice(mq.matches ? "mobile" : "desktop");
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  /* ---------- tải cấu hình cột ---------- */
  const loadColumns = useCallback(async () => {
    setColumnsLoading(true);
    try {
      const res = await fetch(`/api/planning/column-config?device=${device}`);
      const data = await res.json();
      if (res.ok) {
        setColumns(data.columns ?? []);
        setCaps({ ...EMPTY_CAPS, ...(data.capabilities ?? {}) });
        setRole(data.role ?? "");
      } else {
        toast({ title: data.error ?? "Không tải được cấu hình cột.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Lỗi kết nối khi tải cấu hình cột.", variant: "destructive" });
    } finally {
      setColumnsLoading(false);
    }
  }, [device]);

  useEffect(() => { void loadColumns(); }, [loadColumns]);

  /* ---------- tải dữ liệu ---------- */
  const queryParams = useCallback(() => {
    const params = new URLSearchParams();
    if (monthFilter) params.set("month", monthFilter);
    if (locationFilter) params.set("location", locationFilter);
    if (divisionFilter) params.set("division", divisionFilter);
    if (departmentFilter) params.set("department", departmentFilter);
    if (sectionFilter) params.set("section", sectionFilter);
    if (groupFilter) params.set("group", groupFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (requesterFilter) params.set("requester", requesterFilter);
    if (reasonFilter) params.set("reason", reasonFilter);
    if (fulfillmentFilter) params.set("fulfillment", fulfillmentFilter);
    if (requestedFrom) params.set("requestedFrom", requestedFrom);
    if (requestedTo) params.set("requestedTo", requestedTo);
    if (expectedFrom) params.set("expectedFrom", expectedFrom);
    if (expectedTo) params.set("expectedTo", expectedTo);
    if (searchQuery) params.set("q", searchQuery);
    // Bỏ trống sortBy = để server áp dụng thứ tự mặc định theo Ngày cần nhân lực.
    if (sortBy) { params.set("sortBy", sortBy); params.set("sortDir", sortDir); }
    return params;
  }, [
    monthFilter, locationFilter, divisionFilter, departmentFilter, sectionFilter, groupFilter,
    statusFilter, requesterFilter, reasonFilter, fulfillmentFilter, requestedFrom, requestedTo,
    expectedFrom, expectedTo, searchQuery, sortBy, sortDir,
  ]);

  const [dataError, setDataError] = useState<{ code: string; message: string } | null>(null);
  const loadData = useCallback(async () => {
    setLoading(true);
    setDataError(null);
    const params = queryParams();
    // PHASE 5: cap initial list ở 100 bản ghi / trang — không tải toàn bộ dataset.
    // Distinct values lấy từ /api/recruitment-requests/facets (chỉ DISTINCT, không rows).
    params.set("limit", "100");
    const result: ApiResult<{ rows?: RecruitmentRequest[]; total?: number }> =
      await fetchJsonWithTimeout(`/api/recruitment-requests?${params}`, {
        timeoutMs: 12_000,
        label: "recruitment-requests.list",
      });
    if (result.ok) {
      setRows(result.data.rows ?? []);
      setTotal(result.data.total ?? 0);
    } else {
      setRows([]);
      setTotal(0);
      setDataError({ code: result.code, message: result.message });
    }
    setLoading(false);
  }, [queryParams]);

  const loadDistinct = useCallback(async () => {
    // PHASE 5: dùng endpoint /facets chuyên dụng — chỉ trả DISTINCT values,
    // không load rows. Tránh được việc phải tải 5000 bản ghi chỉ để dựng dropdown.
    const result: ApiResult<{ facets?: Record<string, string[]> }> = await fetchJsonWithTimeout(
      "/api/recruitment-requests/facets",
      { timeoutMs: 12_000, label: "recruitment-requests.facets" },
    );
    if (result.ok) {
      const f = result.data.facets ?? {};
      setDistinct({
        month: f.month ?? [],
        location: f.location ?? [],
        division: f.division ?? [],
        department: f.department ?? [],
        section: f.section ?? [],
        groupName: f.group_name ?? [],
        requester: f.requester ?? [],
        reason: f.reason ?? [],
        status: f.status ?? [],
      });
    }
    // Failure của facets không blocking — bộ lọc vẫn dùng được ở dạng trống.
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => { void loadDistinct(); }, [loadDistinct]);

  /* ---------- mở sẵn màn hình chuyển phân bổ từ Task Center ---------- */
  const reallocateFromParam = searchParams.get("reallocateFrom");
  const handledParam = useRef<string | null>(null);
  useEffect(() => {
    if (!reallocateFromParam || rows.length === 0) return;
    if (handledParam.current === reallocateFromParam) return;
    handledParam.current = reallocateFromParam;
    const match = rows.find((r) => r.id === reallocateFromParam);
    setReallocFrom({ id: reallocateFromParam, code: match?.requestCode ?? "" });
  }, [reallocateFromParam, rows]);

  /* ---------- lựa chọn ---------- */
  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const toggleSelect = (id: string) => setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  const toggleSelectAll = () => {
    if (allSelected) { setSelected({}); return; }
    const all: Record<string, boolean> = {};
    rows.forEach((r) => { all[r.id] = true; });
    setSelected(all);
  };

  /* ---------- cột hiển thị + cột ghim ---------- */
  const shown = useMemo(() => columns.filter((c) => c.visible), [columns]);
  const stickyOffsets = useMemo(() => {
    // Cột ghim nằm liền nhau ở mép trái; offset cộng dồn theo width gợi ý.
    const offsets: Record<string, number> = {};
    let acc = 40; // chừa chỗ cho ô checkbox
    for (const col of shown) {
      if (!col.sticky) continue;
      offsets[col.key] = acc;
      acc += col.width ?? 140;
    }
    return offsets;
  }, [shown]);

  const toggleSort = (key: string, sortable?: boolean) => {
    if (!sortable) return;
    if (sortBy !== key) { setSortBy(key); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    // Nhấn lần thứ ba = quay lại thứ tự mặc định theo Ngày cần nhân lực.
    setSortBy("");
    setSortDir("asc");
  };

  /* ---------- nhóm theo bucket khi dùng thứ tự mặc định ---------- */
  const today = todayISO();
  const grouped = useMemo(() => {
    if (sortBy) return null; // người dùng đã tự chọn cột sắp xếp → không nhóm.
    const buckets = new Map<number, RecruitmentRequest[]>();
    for (const r of rows) {
      const b = expectedDateBucket(
        { expectedDate: r.expectedDate, status: r.status, totalBalance: r.totalBalance, requestCode: r.requestCode },
        today,
      );
      const list = buckets.get(b) ?? [];
      list.push(r);
      buckets.set(b, list);
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  }, [rows, sortBy, today]);

  const overdueCount = useMemo(
    () =>
      rows.filter(
        (r) =>
          expectedDateBucket(
            { expectedDate: r.expectedDate, status: r.status, totalBalance: r.totalBalance, requestCode: r.requestCode },
            today,
          ) === SORT_BUCKET_OVERDUE,
      ).length,
    [rows, today],
  );

  /* ---------- IMPORT ---------- */
  const previewData = async (records: Record<string, string>[]) => {
    try {
      setImporting(true);
      const res = await fetch("/api/recruitment-requests/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawData: records, action: "preview" }),
      });
      const data = await res.json();
      if (res.ok) setImportPreview(data);
      else toast({ title: data.error ?? "Lỗi preview", variant: "destructive" });
    } catch {
      toast({ title: "Lỗi kết nối", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  const handlePaste = () => {
    const text = importText.trim();
    if (!text) { toast({ title: "Vui lòng paste dữ liệu từ Excel/Google Sheets", variant: "destructive" }); return; }
    const cells = parseClipboardTable(text);
    if (cells.length < 2) {
      toast({ title: "Cần ít nhất 1 hàng tiêu đề và 1 hàng dữ liệu.", variant: "destructive" });
      return;
    }
    const records = tsvToRecords(cells);
    if (records.length === 0) { toast({ title: "Không thể parse dữ liệu TSV.", variant: "destructive" }); return; }
    void previewData(records);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      const base64 = dataUrl.split(",")[1] || dataUrl;
      try {
        setImporting(true);
        const res = await fetch("/api/recruitment-requests/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileData: base64, fileName: file.name, action: "preview" }),
        });
        const data = await res.json();
        if (res.ok) setImportPreview(data);
        else toast({ title: data.error ?? "Lỗi preview file", variant: "destructive" });
      } catch {
        toast({ title: "Lỗi đọc file", variant: "destructive" });
      } finally {
        setImporting(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleImport = async () => {
    if (!importPreview) return;
    const validRows = importPreview.previewFull.filter((p) => p.valid).map((p) => p.mapped);
    if (validRows.length === 0) { toast({ title: "Không có dòng hợp lệ để import.", variant: "destructive" }); return; }
    try {
      setImporting(true);
      const res = await fetch("/api/recruitment-requests/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rawData: validRows,
          action: "import",
          options: { skipDuplicates: importSkipDup, updateDuplicates: importUpdateDup },
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const n = (s: string) => (data.results ?? []).filter((r: { status: string }) => r.status === s).length;
        toast({ title: `Đã import: ${n("INSERTED")} thêm mới, ${n("UPDATED")} cập nhật, ${n("SKIPPED")} bỏ qua.` });
        setImportOpen(false);
        setImportPreview(null);
        setImportText("");
        await loadData();
      } else {
        toast({ title: data.error ?? "Lỗi import", variant: "destructive" });
      }
    } catch {
      toast({ title: "Lỗi kết nối", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  /* ---------- BATCH ---------- */
  const batchAction = async (action: string, status?: string, ids: string[] = selectedIds) => {
    if (ids.length === 0) { toast({ title: "Chưa chọn yêu cầu nào.", variant: "destructive" }); return; }
    setBatchLoading(true);
    try {
      const res = await fetch("/api/recruitment-requests/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids, status }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: `Đã xử lý ${data.count} yêu cầu.` });
        setSelected({});
        await loadData();
      } else {
        toast({ title: data.error ?? "Lỗi thao tác", variant: "destructive" });
      }
    } catch {
      toast({ title: "Lỗi kết nối", variant: "destructive" });
    } finally {
      setBatchLoading(false);
    }
  };

  const handleExport = () => window.open(`/api/recruitment-requests/export?${queryParams()}`, "_blank");

  const resetFilters = () => {
    setMonthFilter(""); setLocationFilter(""); setDivisionFilter(""); setDepartmentFilter("");
    setSectionFilter(""); setGroupFilter(""); setStatusFilter(""); setRequesterFilter("");
    setReasonFilter(""); setFulfillmentFilter(""); setRequestedFrom(""); setRequestedTo("");
    setExpectedFrom(""); setExpectedTo(""); setSearchQuery("");
  };

  /* ---------- Tổng hợp ---------- */
  const stats = useMemo(() => {
    const s = { rq: 0, recruited: 0, balance: 0, pending: 0, processing: 0, completed: 0, cancelled: 0, expired: 0 };
    for (const r of rows) {
      s.rq += Number(r.maleRq ?? 0) + Number(r.femaleRq ?? 0);
      s.recruited += Number(r.maleRecruited ?? 0) + Number(r.femaleRecruited ?? 0);
      s.balance += Number(r.totalBalance ?? 0);
      if (r.status === "PENDING") s.pending++;
      else if (r.status === "PROCESSING") s.processing++;
      else if (r.status === "COMPLETED") s.completed++;
      else if (r.status === "CANCELLED") s.cancelled++;
      else if (r.status === "EXPIRED") s.expired++;
    }
    return s;
  }, [rows]);

  const selectClass =
    "h-9 max-w-[160px] rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent";
  const dateClass =
    "h-9 rounded-[8px] border border-border-strong bg-surface-raised px-2 text-xs font-medium text-fg outline-none focus:border-accent";

  const renderSortIcon = (col: ResolvedColumn) => {
    if (!col.sortable) return null;
    if (sortBy !== col.key) return <ChevronsUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
    return sortDir === "asc"
      ? <ChevronUp className="ml-1 inline h-3 w-3" />
      : <ChevronDown className="ml-1 inline h-3 w-3" />;
  };

  const rowActions = (r: RecruitmentRequest) => (
    <div className="flex justify-end gap-1">
      {caps.canEdit && r.status === "PENDING" && (
        <button
          onClick={() => batchAction("status", "PROCESSING", [r.id])}
          className="rounded-full bg-success-tint px-2 py-0.5 text-[10px] font-semibold text-success transition-colors hover:bg-success/20"
        >
          Activate
        </button>
      )}
      {caps.canEdit && (r.status === "CANCELLED" || r.status === "COMPLETED") && (
        <button
          onClick={() => batchAction("status", "PENDING", [r.id])}
          className="rounded-full bg-primary-tint px-2 py-0.5 text-[10px] font-semibold text-primary transition-colors hover:bg-primary/15"
        >
          Reopen
        </button>
      )}
      {caps.canReallocate && (
        <button
          onClick={() => setReallocFrom({ id: r.id, code: r.requestCode })}
          title="Chuyển phân bổ DW sang yêu cầu mới"
          className="rounded-full bg-accent-tint px-2 py-0.5 text-[10px] font-semibold text-accent transition-colors hover:bg-accent/20"
        >
          <Shuffle className="mr-0.5 inline h-3 w-3" /> Chuyển DW
        </button>
      )}
    </div>
  );

  const tableBodyRows = (list: RecruitmentRequest[]) =>
    list.map((r) => (
      <tr
        key={r.id}
        className={cn(
          "border-b border-border/70 bg-surface transition-colors hover:bg-botanical-50",
          selected[r.id] && "bg-accent-tint/30",
        )}
      >
        <td className="sticky left-0 z-[1] w-10 bg-inherit px-2 py-2.5 text-center">
          <button onClick={() => toggleSelect(r.id)} aria-label={`Chọn ${r.requestCode}`}>
            {selected[r.id] ? <CheckSquare className="h-4 w-4 text-primary" /> : <Square className="h-4 w-4 text-fg-muted" />}
          </button>
        </td>
        {shown.map((col) => (
          <td
            key={col.key}
            style={col.sticky ? { left: stickyOffsets[col.key], minWidth: col.width } : { minWidth: col.width }}
            className={cn(
              "px-3 py-2.5 text-[12.5px] text-fg",
              ALIGN_RIGHT.has(col.type) && "text-right tabular-nums",
              col.type === "status" && "text-center",
              col.sticky && "sticky z-[1] bg-inherit shadow-[1px_0_0_var(--color-border)]",
              col.key === "requestCode" && "font-mono font-semibold",
            )}
          >
            {col.key === "requestCode" ? (
              <button className="text-left hover:text-primary hover:underline" onClick={() => setDetailRow(r)}>
                {String(r.requestCode)}
              </button>
            ) : (
              renderCellValue(col, r)
            )}
          </td>
        ))}
        <td className="px-3 py-2.5 text-right">{rowActions(r)}</td>
      </tr>
    ));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={<SectionLabel>Workforce Recruitment Request Planning</SectionLabel>}
        title="Yêu cầu tuyển dụng — Recruitment Requests"
        description="Lịch sử yêu cầu nhân lực theo quy trình Dalat Hasfarm. Mặc định sắp xếp theo Ngày cần nhân lực, nhóm quá hạn lên đầu."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setChooserOpen(true)} disabled={columnsLoading}>
              <Columns3 className="h-4 w-4" /> Cột hiển thị ({shown.length})
            </Button>
            {/* Yêu cầu #11 — nút Import chỉ hiện với vai trò có quyền planning.import. */}
            {caps.canImport && (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <ClipboardPaste className="h-4 w-4" /> Dán kế hoạch từ Excel / Google Sheets
              </Button>
            )}
            <Button variant="primary" onClick={handleExport}>
              <FileDown className="h-4 w-4" /> Xuất Excel
            </Button>
          </div>
        }
      />

      {/* Thông báo vai trò chỉ đọc (Yêu cầu #3) */}
      {!columnsLoading && !caps.canEdit && (
        <div className="flex items-start gap-2 rounded-[12px] border border-border bg-surface-raised px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-[12.5px] leading-relaxed text-fg-muted">
            Vai trò <strong className="text-fg">{role}</strong> chỉ được <strong className="text-fg">xem</strong> dữ liệu
            trong phạm vi phòng ban được phân quyền. Bạn không thể import, tạo hay chỉnh sửa yêu cầu tuyển dụng.
          </p>
        </div>
      )}

      {/* Tổng hợp */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <SectionLabel tone="green">Summary</SectionLabel>
            <h2 className="mt-1 text-[16px] font-bold text-fg">Tổng hợp theo bộ lọc hiện tại</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {overdueCount > 0 && <Badge tone="red" dot>Quá hạn {overdueCount}</Badge>}
            <Badge tone="blue" dot>Pending {stats.pending}</Badge>
            <Badge tone="amber" dot>Processing {stats.processing}</Badge>
            <Badge tone="green" dot>Completed {stats.completed}</Badge>
            <Badge tone="gray" dot>Cancelled {stats.cancelled}</Badge>
            <Badge tone="gray" dot>Expired {stats.expired}</Badge>
          </div>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-[14px] border border-border bg-surface-raised p-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-muted">Nhu cầu</p>
            <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-primary">{stats.rq}</p>
          </div>
          <div className="rounded-[14px] border border-border bg-surface-raised p-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-muted">Đã tuyển</p>
            <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-success">{stats.recruited}</p>
          </div>
          <div className="rounded-[14px] border border-border bg-surface-raised p-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-muted">Còn cần tuyển</p>
            <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-warning">{stats.balance}</p>
          </div>
          <div className="rounded-[14px] border border-border bg-surface-raised p-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-muted">All requests</p>
            <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-accent">{total}</p>
            <p className="mt-1 text-[11px] text-fg-muted">{rows.length} hiển thị</p>
          </div>
        </div>
      </Card>

      {/* Bộ lọc */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[180px] max-w-xs flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
            <input
              type="text"
              placeholder="Tìm Request Code..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-full rounded-[8px] border border-border-strong bg-surface-raised pl-8 pr-3 text-xs text-fg outline-none placeholder:text-fg-muted focus:border-accent"
            />
          </div>
          <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} className={selectClass}>
            <option value="">Month</option>
            {(distinct.month ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} className={selectClass}>
            <option value="">Location</option>
            {(distinct.location ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)} className={selectClass}>
            <option value="">Division</option>
            {(distinct.division ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)} className={selectClass}>
            <option value="">Department</option>
            {(distinct.department ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)} className={selectClass}>
            <option value="">Section</option>
            {(distinct.section ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className={selectClass}>
            <option value="">Group</option>
            {(distinct.groupName ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectClass}>
            <option value="">Tất cả trạng thái</option>
            {["PENDING", "PROCESSING", "COMPLETED", "CANCELLED", "EXPIRED"].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "Ẩn bộ lọc nâng cao" : "Bộ lọc nâng cao"}
          </Button>
        </div>

        {showAdvanced && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <select value={requesterFilter} onChange={(e) => setRequesterFilter(e.target.value)} className={selectClass}>
              <option value="">Requester</option>
              {(distinct.requester ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <select value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)} className={selectClass}>
              <option value="">Reason</option>
              {(distinct.reason ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <select value={fulfillmentFilter} onChange={(e) => setFulfillmentFilter(e.target.value)} className={selectClass}>
              <option value="">Tình trạng đáp ứng</option>
              <option value="UNFILLED">Còn thiếu người</option>
              <option value="FILLED">Đã đủ</option>
            </select>
            <label className="flex items-center gap-1 text-[11px] font-semibold text-fg-muted">
              Ngày yêu cầu
              <input type="date" value={requestedFrom} onChange={(e) => setRequestedFrom(e.target.value)} className={dateClass} />
              <span>→</span>
              <input type="date" value={requestedTo} onChange={(e) => setRequestedTo(e.target.value)} className={dateClass} />
            </label>
            <label className="flex items-center gap-1 text-[11px] font-semibold text-fg-muted">
              Ngày cần nhân lực
              <input type="date" value={expectedFrom} onChange={(e) => setExpectedFrom(e.target.value)} className={dateClass} />
              <span>→</span>
              <input type="date" value={expectedTo} onChange={(e) => setExpectedTo(e.target.value)} className={dateClass} />
            </label>
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              <X className="h-3.5 w-3.5" /> Xoá bộ lọc
            </Button>
          </div>
        )}

        <div className="mt-3 border-t border-border pt-3 text-[11px] text-fg-muted">
          {sortBy ? (
            <>
              Đang sắp xếp theo <strong className="text-fg">{columns.find((c) => c.key === sortBy)?.labelVi ?? sortBy}</strong>{" "}
              ({sortDir === "asc" ? "tăng dần" : "giảm dần"}).{" "}
              <button className="font-semibold text-primary hover:underline" onClick={() => setSortBy("")}>
                Về thứ tự mặc định (Ngày cần nhân lực)
              </button>
            </>
          ) : (
            <>Thứ tự mặc định: <strong className="text-fg">Quá hạn / Cần xử lý</strong> → sắp tới → chưa có ngày. Nhấn tiêu đề cột để đổi.</>
          )}
        </div>
      </Card>

      {/* Thanh thao tác hàng loạt */}
      {selectedIds.length > 0 && caps.canEdit && (
        <Card className="border-accent/40 bg-accent-tint/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-fg">Đã chọn {selectedIds.length} yêu cầu</span>
            <Button size="sm" variant="primary" loading={batchLoading} onClick={() => batchAction("activate")}>
              <Play className="h-3.5 w-3.5" /> Activate
            </Button>
            <Button size="sm" variant="outline" loading={batchLoading} onClick={() => batchAction("cancel")}>
              <XCircle className="h-3.5 w-3.5" /> Cancel
            </Button>
            <Button size="sm" variant="destructive" loading={batchLoading} onClick={() => batchAction("delete")}>
              <Trash2 className="h-3.5 w-3.5" /> Xoá Draft
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected({})}>Bỏ chọn</Button>
          </div>
        </Card>
      )}

      {/* Bảng / thẻ */}
      <Card className="overflow-hidden p-0">
        <CardContent className="p-0">
          {loading || columnsLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-fg-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang tải dữ liệu...
            </div>
          ) : dataError ? (
            // PHASE 3 — ErrorState thay cho toast bay: hiển thị thông báo rõ ràng,
            // mã lỗi, nút "Thử lại" — không để trang trống im lặng.
            <ErrorState
              title="Không tải được danh sách yêu cầu"
              description={
                <span>
                  {dataError.message}
                  {dataError.code ? (
                    <>
                      {" "}
                      <span className="text-fg-muted">Mã lỗi: {dataError.code}</span>
                    </>
                  ) : null}
                </span>
              }
              onRetry={() => void loadData()}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<FileSpreadsheet className="h-5 w-5" />}
              title="Chưa có yêu cầu tuyển dụng nào"
              description={
                caps.canImport
                  ? "Nhấn 'Dán kế hoạch từ Excel / Google Sheets' để import dữ liệu, hoặc tạo yêu cầu mới."
                  : "Không có yêu cầu nào trong phạm vi dữ liệu của bạn."
              }
              action={
                caps.canImport ? (
                  <Button variant="primary" size="sm" onClick={() => setImportOpen(true)}>
                    <ClipboardPaste className="h-4 w-4" /> Dán kế hoạch từ Excel
                  </Button>
                ) : undefined
              }
            />
          ) : device === "mobile" ? (
            /* ---------- MOBILE: danh sách thẻ, chỉ cột ưu tiên (Yêu cầu #12) ---------- */
            <div className="divide-y divide-border">
              {rows.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setDetailRow(r)}
                  className="flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[13px] font-semibold text-fg">{r.requestCode}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-fg-muted">
                    {shown
                      .filter((c) => c.key !== "requestCode" && c.key !== "status")
                      .slice(0, 5)
                      .map((c) => (
                        <span key={c.key}>
                          {c.labelVi}: <span className="text-fg">{renderCellValue(c, r)}</span>
                        </span>
                      ))}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            /* ---------- DESKTOP: bảng cuộn ngang, cột ghim ---------- */
            <div className="v2-scroll overflow-x-auto">
              <table className="grid-sheet w-full text-[13px]">
                <thead className="sticky top-0 z-10 bg-primary-tint/95 shadow-[inset_0_-1px_0_var(--color-border)] backdrop-blur">
                  <tr>
                    <th className="sticky left-0 z-[2] w-10 bg-primary-tint px-2 py-2.5 text-center">
                      <button onClick={toggleSelectAll} className="mx-auto" aria-label="Chọn tất cả">
                        {allSelected ? <CheckSquare className="h-4 w-4 text-primary" /> : <Square className="h-4 w-4 text-fg-muted" />}
                      </button>
                    </th>
                    {shown.map((col) => (
                      <th
                        key={col.key}
                        title={col.label}
                        style={col.sticky ? { left: stickyOffsets[col.key], minWidth: col.width } : { minWidth: col.width }}
                        className={cn(
                          "whitespace-nowrap px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary",
                          ALIGN_RIGHT.has(col.type) && "text-right",
                          col.type === "status" && "text-center",
                          col.sortable && "cursor-pointer select-none hover:text-accent",
                          col.sticky && "sticky z-[2] bg-primary-tint shadow-[1px_0_0_var(--color-border)]",
                        )}
                        onClick={() => toggleSort(col.key, col.sortable)}
                      >
                        {col.labelVi}
                        {renderSortIcon(col)}
                      </th>
                    ))}
                    <th className="px-3 py-2.5 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">
                      Thao tác
                    </th>
                  </tr>
                </thead>
                {grouped ? (
                  grouped.map(([bucket, list]) => (
                    <tbody key={bucket} className="divide-y divide-border">
                      <tr>
                        <td colSpan={shown.length + 2} className="bg-surface-hover px-3 py-1.5">
                          <span
                            className={cn(
                              "text-[10.5px] font-bold uppercase tracking-[0.14em]",
                              bucket === SORT_BUCKET_OVERDUE ? "text-danger" : "text-fg-muted",
                            )}
                          >
                            {bucketLabel(bucket)} · {list.length}
                          </span>
                        </td>
                      </tr>
                      {tableBodyRows(list)}
                    </tbody>
                  ))
                ) : (
                  <tbody className="divide-y divide-border">{tableBodyRows(rows)}</tbody>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Column Chooser */}
      <ColumnChooser
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        columns={columns}
        role={role}
        device={device}
        canManage={caps.canManageColumns}
        onApply={setColumns}
        onSaved={() => void loadColumns()}
      />

      {/* Chuyển phân bổ DW */}
      <ReallocationPanel
        open={reallocFrom !== null}
        fromRequestId={reallocFrom?.id ?? null}
        fromRequestCode={reallocFrom?.code ?? null}
        onClose={() => setReallocFrom(null)}
        onDone={() => void loadData()}
      />

      {/* Ngăn chi tiết — hiển thị TOÀN BỘ cột được phép xem (Yêu cầu #12) */}
      <Modal
        open={detailRow !== null}
        onClose={() => setDetailRow(null)}
        title={`Yêu cầu ${detailRow?.requestCode ?? ""}`}
        description="Chi tiết đầy đủ theo cấu hình cột của vai trò bạn."
        width="max-w-2xl"
        footer={
          <div className="flex w-full justify-between gap-2">
            {caps.canReallocate && detailRow ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReallocFrom({ id: detailRow.id, code: detailRow.requestCode });
                  setDetailRow(null);
                }}
              >
                <Shuffle className="h-3.5 w-3.5" /> Chuyển phân bổ DW
              </Button>
            ) : <span />}
            <Button variant="ghost" size="sm" onClick={() => setDetailRow(null)}>Đóng</Button>
          </div>
        }
      >
        {detailRow && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {columns
              .filter((c) => c.visible || device === "mobile")
              .map((col) => (
                <div key={col.key} className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1">
                  <dt className="text-[11.5px] text-fg-muted">{col.labelVi}</dt>
                  <dd className="text-right text-[12.5px] font-medium text-fg">{renderCellValue(col, detailRow)}</dd>
                </div>
              ))}
          </dl>
        )}
      </Modal>

      {/* Import Modal — chỉ render khi có quyền (Yêu cầu #11) */}
      {caps.canImport && (
        <Modal
          open={importOpen}
          onClose={() => { setImportOpen(false); setImportPreview(null); setImportText(""); }}
          title="Import Yêu Cầu Tuyển Dụng từ Excel / Google Sheets"
          description="Copy vùng dữ liệu từ Excel/Google Sheets (Ctrl+C) rồi paste vào ô bên dưới, hoặc upload file CSV/XLSX."
          width="max-w-5xl"
        >
          <div className="space-y-4">
            {!importPreview && (
              <>
                <div className="rounded-[10px] border border-border bg-surface-raised p-3 text-[11.5px] leading-relaxed text-fg-muted">
                  Các cột hệ thống tự tính (Application, Interviewed, Recruited, Quit, Screened, Interview, Recruit,
                  Balance, Total Request, Recruited vs Expected) sẽ <strong className="text-fg">không</strong> bị ghi đè
                  bằng giá trị trong file — hệ thống luôn tính lại từ Daily Application, phân bổ và Workforce Movement.
                </div>

                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                    <FileUp className="h-4 w-4" /> Upload CSV/XLSX
                  </Button>
                  <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFileUpload} />
                </div>

                <FormField label="Paste dữ liệu từ Excel / Google Sheets">
                  <textarea
                    ref={pasteRef}
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder="Chọn vùng dữ liệu trong Excel/Google Sheets, copy (Ctrl+C), sau đó paste vào đây (Ctrl+V)..."
                    rows={8}
                    className="w-full rounded-[10px] border border-border-strong bg-surface-raised p-3 font-mono text-[13px] text-fg outline-none focus:border-accent"
                  />
                </FormField>

                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setImportOpen(false)}>Huỷ</Button>
                  <Button variant="primary" onClick={handlePaste} loading={importing}>
                    <Eye className="h-4 w-4" /> Xem trước & Xác thực
                  </Button>
                </div>
              </>
            )}

            {importPreview && (
              <>
                <div className="flex items-center justify-between rounded-[10px] bg-surface-hover p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold text-fg">Tổng: {importPreview.totalRows} dòng</span>
                    <Badge tone="green">{importPreview.validCount} hợp lệ</Badge>
                    {importPreview.errorCount > 0 && <Badge tone="red">{importPreview.errorCount} lỗi</Badge>}
                  </div>
                  {importPreview.unknownHeaders.length > 0 && (
                    <div className="text-[11px] text-fg-muted">
                      <AlertTriangle className="mr-1 inline h-3 w-3" />
                      {importPreview.unknownHeaders.length} cột không nhận diện được
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-4 rounded-[10px] border border-border bg-surface-raised p-3">
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-fg">
                    <input
                      type="checkbox"
                      checked={importSkipDup}
                      onChange={(e) => { setImportSkipDup(e.target.checked); if (e.target.checked) setImportUpdateDup(false); }}
                      className="h-4 w-4 rounded accent-primary"
                    />
                    Bỏ qua Request Code trùng
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-fg">
                    <input
                      type="checkbox"
                      checked={importUpdateDup}
                      onChange={(e) => { setImportUpdateDup(e.target.checked); if (e.target.checked) setImportSkipDup(false); }}
                      className="h-4 w-4 rounded accent-primary"
                    />
                    Cập nhật Request Code trùng
                  </label>
                </div>

                <div className="max-h-80 overflow-auto rounded-[10px] border border-border">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 z-10 bg-primary-tint">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-[10px] font-bold uppercase text-primary">#</th>
                        <th className="px-2 py-1.5 text-left text-[10px] font-bold uppercase text-primary">Request Code</th>
                        <th className="px-2 py-1.5 text-left text-[10px] font-bold uppercase text-primary">Requester</th>
                        <th className="px-2 py-1.5 text-left text-[10px] font-bold uppercase text-primary">Nam Rq</th>
                        <th className="px-2 py-1.5 text-left text-[10px] font-bold uppercase text-primary">Nữ Rq</th>
                        <th className="px-2 py-1.5 text-center text-[10px] font-bold uppercase text-primary">Status</th>
                        <th className="px-2 py-1.5 text-center text-[10px] font-bold uppercase text-primary">Kết quả</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {importPreview.previewFull.map((p) => (
                        <tr key={p.rowIndex} className={cn(p.valid ? "bg-surface" : "bg-danger-tint/20")}>
                          <td className="px-2 py-1.5 text-fg-muted">{p.rowIndex}</td>
                          <td className="px-2 py-1.5 font-semibold text-fg">{p.requestCode || "—"}</td>
                          <td className="px-2 py-1.5 text-fg">{p.mapped["Requester"] || "—"}</td>
                          <td className="px-2 py-1.5 text-fg">{p.mapped["Male Rq"] || "0"}</td>
                          <td className="px-2 py-1.5 text-fg">{p.mapped["Female Rq"] || "0"}</td>
                          <td className="px-2 py-1.5 text-center">
                            <StatusBadge status={p.mapped["Status"] || "PENDING"} />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            {p.valid ? (
                              <span className="font-semibold text-success">✓ OK</span>
                            ) : (
                              <span className="text-[10px] text-danger" title={p.errors.map((e) => e.message).join("; ")}>
                                ✗ {p.errors.length} lỗi
                              </span>
                            )}
                            {p.warnings.length > 0 && (
                              <span className="ml-1 text-[10px] text-warning" title={p.warnings.map((w) => w.message).join("; ")}>
                                ⚠ {p.warnings.length}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {importPreview.previewFull.some((p) => !p.valid) && (
                  <div className="rounded-[10px] border border-danger/30 bg-danger-tint/20 p-3">
                    <p className="mb-1 text-[11px] font-semibold text-danger">Chi tiết lỗi:</p>
                    <ul className="list-inside list-disc space-y-0.5 text-[11px] text-danger">
                      {importPreview.previewFull.filter((p) => !p.valid).slice(0, 10).map((p) => (
                        <li key={p.rowIndex}>Dòng {p.rowIndex}: {p.errors.map((e) => e.message).join("; ")}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => { setImportPreview(null); setImportText(""); }}>Quay lại</Button>
                  <Button variant="primary" onClick={handleImport} loading={importing} disabled={importPreview.validCount === 0}>
                    Import {importPreview.validCount} dòng hợp lệ
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
