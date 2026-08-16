"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  FormField,
  Input,
  Modal,
  PageHeader,
  SectionLabel,
  StatusBadge,
  cn,
  toast,
} from "@/components/ui";
import {
  ClipboardPaste,
  Download,
  Upload,
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
  Filter,
  Loader2,
  RefreshCw,
} from "lucide-react";

/* ============================================================
   TYPES
   ============================================================ */
type RecruitmentRequest = {
  id: string;
  requestCode: string;
  requester: string;
  position: string | null;
  jobTitle: string | null;
  location: string | null;
  section: string | null;
  groupName: string | null;
  division: string | null;
  department: string | null;
  reason: string | null;
  noteForReason: string | null;
  specialRequirements: string | null;
  maleRq: number;
  femaleRq: number;
  maleApplication: number;
  femaleApplication: number;
  maleInterviewed: number;
  femaleInterviewed: number;
  maleRecruited: number;
  femaleRecruited: number;
  maleQuit: number;
  femaleQuit: number;
  maleBalance: number;
  femaleBalance: number;
  totalBalance: number;
  status: string;
  requestedDate: string | null;
  expectedDate: string | null;
  offeredDate: string | null;
  completedDate: string | null;
  month: string | null;
  cost: number;
  remarks: string | null;
  to: string | null;
  rqStatus: string | null;
  monthRc: string | null;
  totalRequest: number;
  recruitedVsExpected: number;
  screened: number;
  interview: number;
  recruit: number;
  departmentText: string | null;
  monthReport: string | null;
  createdBy: string;
  createdAt: string;
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

/* ============================================================
   PARSER (Client-side TSV)
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
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = row[j]?.trim() ?? "";
    }
    records.push(record);
  }

  return records;
}

/* ============================================================
   HEADER ALIAS MAPPING (Client-side)
   ============================================================ */
const HEADER_ALIASES: Record<string, string[]> = {
  "Request Code": ["request_code", "ma yeu cau", "mã yêu cầu", "request code", "code", "ma tuyen dung", "mã tuyển dụng"],
  Requester: ["requester", "nguoi yeu cau", "người yêu cầu", "nguoi de xuat", "người đề xuất"],
  Position: ["position", "vi tri", "vị trí", "chuc vu", "chức vụ"],
  "Job title": ["job_title", "job title", "chuc danh", "chức danh", "cong viec", "công việc", "job"],
  Location: ["location", "dia diem", "địa điểm", "noi lam viec", "nơi làm việc", "loc"],
  Division: ["division", "khoi", "khối"],
  Department: ["department", "phong ban", "phòng ban", "bo phan", "bộ phận", "dept"],
  Section: ["section", "to", "tổ"],
  Group: ["group", "nhom", "nhóm", "group_name", "group name"],
  Reason: ["reason", "ly do", "lý do", "nguyen nhan", "nguyên nhân"],
  "Note for reason": ["note_for_reason", "note for reason", "ghi chu ly do", "ghi chú lý do"],
  "Special Requirements": ["special_requirements", "special requirements", "yeu cau dac biet", "yêu cầu đặc biệt"],
  "Male Rq": ["male_rq", "male rq", "nam rq", "nam can", "nam cần", "male required"],
  "Female Rq": ["female_rq", "female rq", "nu rq", "nữ rq", "nu can", "nữ cần", "female required"],
  "Male Application": ["male_application", "male application", "nam app"],
  "Female Application": ["female_application", "female application", "nu app"],
  "Male Interviewed": ["male_interviewed", "male interviewed", "nam pv"],
  "Female Interviewed": ["female_interviewed", "female interviewed", "nu pv"],
  "Male Recruited": ["male_recruited", "male recruited", "nam tuyen", "nam tuyển"],
  "Female Recruited": ["female_recruited", "female recruited", "nu tuyen", "nữ tuyển"],
  "Male Quit": ["male_quit", "male quit", "nam nghi", "nam nghỉ"],
  "Female Quit": ["female_quit", "female quit", "nu nghi", "nữ nghỉ"],
  "Male Balance": ["male_balance", "male balance"],
  "Female Balance": ["female_balance", "female balance"],
  "Total Balance": ["total_balance", "total balance"],
  Status: ["status", "trang thai", "trạng thái"],
  "Requested Date": ["requested_date", "requested date", "ngay yeu cau", "ngày yêu cầu"],
  "Expected Date": ["expected_date", "expected date", "ngay du kien", "ngày dự kiến"],
  "Offered Date": ["offered_date", "offered date", "ngay de nghi", "ngày đề nghị"],
  "Completed Date": ["completed_date", "completed date", "ngay hoan thanh", "ngày hoàn thành"],
  Month: ["month", "thang", "tháng"],
  Cost: ["cost", "chi phi", "chi phí"],
  Remarks: ["remarks", "ghi chu", "ghi chú"],
  To: ["to", "den", "đến"],
  "Rq Status": ["rq_status", "rq status"],
  Month_Rc: ["month_rc", "month rc", "thang rc"],
  "Total Request": ["total_request", "total request"],
  "Recruited vs Expected": ["recruited_vs_expected", "recruited vs expected"],
  Screened: ["screened", "da loc", "đã lọc"],
  Interview: ["interview", "phong van", "phỏng vấn"],
  Recruit: ["recruit", "tuyen", "tuyển"],
  Month_Report: ["month_report", "month report"],
};

function normalizeHeaderName(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "");
}

function resolveHeaderAlias(header: string): string | null {
  const normalized = normalizeHeaderName(header);
  if (!normalized) return null;
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    if (normalizeHeaderName(canonical) === normalized) return canonical;
    for (const alias of aliases) {
      if (normalizeHeaderName(alias) === normalized) return canonical;
    }
  }
  return null;
}

function mapRowToCanonical(rawRow: Record<string, string>): {
  canonical: Record<string, string>;
  unknownHeaders: string[];
} {
  const canonical: Record<string, string> = {};
  const unknownHeaders: string[] = [];
  for (const [header, value] of Object.entries(rawRow)) {
    const resolved = resolveHeaderAlias(header);
    if (resolved) {
      canonical[resolved] = value;
    } else {
      unknownHeaders.push(header);
    }
  }
  return { canonical, unknownHeaders };
}

/* ============================================================
   UI
   ============================================================ */
const STATUS_OPTIONS = [
  { value: "", label: "Tất cả trạng thái" },
  { value: "PENDING", label: "PENDING" },
  { value: "PROCESSING", label: "PROCESSING" },
  { value: "COMPLETED", label: "COMPLETED" },
  { value: "CANCELLED", label: "CANCELLED" },
];

export default function RecruitmentRequestsPage() {
  const [rows, setRows] = useState<RecruitmentRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [selectAll, setSelectAll] = useState(false);

  // Filters
  const [monthFilter, setMonthFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [divisionFilter, setDivisionFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [sectionFilter, setSectionFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [requesterFilter, setRequesterFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Distinct values for filter dropdowns
  const [distinctMonths, setDistinctMonths] = useState<string[]>([]);
  const [distinctLocations, setDistinctLocations] = useState<string[]>([]);
  const [distinctDivisions, setDistinctDivisions] = useState<string[]>([]);
  const [distinctDepartments, setDistinctDepartments] = useState<string[]>([]);
  const [distinctSections, setDistinctSections] = useState<string[]>([]);
  const [distinctGroups, setDistinctGroups] = useState<string[]>([]);
  const [distinctRequesters, setDistinctRequesters] = useState<string[]>([]);

  // Import modal state
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreviewData | null>(null);
  const [importing, setImporting] = useState(false);
  const [importSkipDup, setImportSkipDup] = useState(false);
  const [importUpdateDup, setImportUpdateDup] = useState(true);
  const [importFile, setImportFile] = useState<File | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Batch actions
  const [batchLoading, setBatchLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (monthFilter) params.set("month", monthFilter);
    if (locationFilter) params.set("location", locationFilter);
    if (divisionFilter) params.set("division", divisionFilter);
    if (departmentFilter) params.set("department", departmentFilter);
    if (sectionFilter) params.set("section", sectionFilter);
    if (groupFilter) params.set("group", groupFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (requesterFilter) params.set("requester", requesterFilter);
    if (searchQuery) params.set("q", searchQuery);
    params.set("limit", "1000");

    const res = await fetch(`/api/recruitment-requests?${params}`);
    const data = await res.json();
    if (res.ok) {
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    }
    setLoading(false);
  }, [monthFilter, locationFilter, divisionFilter, departmentFilter, sectionFilter, groupFilter, statusFilter, requesterFilter, searchQuery]);

  const loadDistinct = useCallback(async () => {
    try {
      const res = await fetch("/api/recruitment-requests?limit=5000");
      const data = await res.json();
      if (!res.ok) return;
      const allRows: RecruitmentRequest[] = data.rows ?? [];
      setDistinctMonths([...new Set(allRows.map((r) => r.month).filter(Boolean))] as string[]);
      setDistinctLocations([...new Set(allRows.map((r) => r.location).filter(Boolean))] as string[]);
      setDistinctDivisions([...new Set(allRows.map((r) => r.division).filter(Boolean))] as string[]);
      setDistinctDepartments([...new Set(allRows.map((r) => r.department ?? r.departmentText).filter(Boolean))] as string[]);
      setDistinctSections([...new Set(allRows.map((r) => r.section).filter(Boolean))] as string[]);
      setDistinctGroups([...new Set(allRows.map((r) => r.groupName).filter(Boolean))] as string[]);
      setDistinctRequesters([...new Set(allRows.map((r) => r.requester).filter(Boolean))] as string[]);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => { void loadDistinct(); }, [loadDistinct]);

  // Selection
  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);

  useEffect(() => {
    if (selectAll) {
      const all: Record<string, boolean> = {};
      rows.forEach((r) => { all[r.id] = true; });
      setSelected(all);
    } else if (selectedIds.length > 0 && selectedIds.length === rows.length) {
      // Only toggle off if all were selected
    }
  }, [selectAll, rows]);

  const toggleSelect = (id: string) => setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  const toggleSelectAll = () => {
    if (selectAll || selectedIds.length === rows.length) {
      setSelected({});
      setSelectAll(false);
    } else {
      const all: Record<string, boolean> = {};
      rows.forEach((r) => { all[r.id] = true; });
      setSelected(all);
      setSelectAll(true);
    }
  };

  /* ============================================================
     IMPORT / PASTE
     ============================================================ */
  const handlePaste = () => {
    const text = importText.trim();
    if (!text) { toast({ title: "Vui lòng paste dữ liệu từ Excel/Google Sheets", variant: "destructive" }); return; }

    const cells = parseClipboardTable(text);
    if (cells.length < 2) {
      toast({ title: "Dữ liệu paste không hợp lệ. Cần ít nhất 1 hàng tiêu đề và 1 hàng dữ liệu.", variant: "destructive" });
      return;
    }

    const records = tsvToRecords(cells);
    if (records.length === 0) {
      toast({ title: "Không thể parse dữ liệu. Kiểm tra định dạng TSV.", variant: "destructive" });
      return;
    }

    previewData(records);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);

    // Read file as base64
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      const base64 = dataUrl.split(",")[1] || dataUrl;

      try {
        setImporting(true);
        const res = await fetch("/api/recruitment-requests/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileData: base64,
            fileName: file.name,
            action: "preview",
          }),
        });
        const data = await res.json();
        if (res.ok) {
          setImportPreview(data);
        } else {
          toast({ title: data.error ?? "Lỗi preview file", variant: "destructive" });
        }
      } catch (err) {
        toast({ title: "Lỗi đọc file", variant: "destructive" });
      } finally {
        setImporting(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const previewData = async (records: Record<string, string>[]) => {
    try {
      setImporting(true);
      const res = await fetch("/api/recruitment-requests/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawData: records, action: "preview" }),
      });
      const data = await res.json();
      if (res.ok) {
        setImportPreview(data);
      } else {
        toast({ title: data.error ?? "Lỗi preview", variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Lỗi kết nối", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  const handleImport = async () => {
    if (!importPreview) return;
    const validRows = importPreview.previewFull.filter((p) => p.valid).map((p) => p.mapped);
    if (validRows.length === 0) {
      toast({ title: "Không có dòng hợp lệ để import.", variant: "destructive" });
      return;
    }

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
        toast({ title: `Đã import: ${data.results.filter((r: any) => r.status === "INSERTED").length} thêm mới, ${data.results.filter((r: any) => r.status === "UPDATED").length} cập nhật, ${data.results.filter((r: any) => r.status === "SKIPPED").length} bỏ qua.` });
        setImportOpen(false);
        setImportPreview(null);
        setImportText("");
        setImportFile(null);
        await loadData();
      } else {
        toast({ title: data.error ?? "Lỗi import", variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Lỗi kết nối", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  /* ============================================================
     BATCH ACTIONS
     ============================================================ */
  const batchAction = async (action: string, status?: string) => {
    const ids = selectedIds;
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
        setSelectAll(false);
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

  /* ============================================================
     EXPORT
     ============================================================ */
  const handleExport = () => {
    const params = new URLSearchParams();
    if (monthFilter) params.set("month", monthFilter);
    if (locationFilter) params.set("location", locationFilter);
    if (divisionFilter) params.set("division", divisionFilter);
    if (departmentFilter) params.set("department", departmentFilter);
    if (sectionFilter) params.set("section", sectionFilter);
    if (groupFilter) params.set("group", groupFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (requesterFilter) params.set("requester", requesterFilter);
    if (searchQuery) params.set("q", searchQuery);

    window.open(`/api/recruitment-requests/export?${params}`, "_blank");
  };

  /* ============================================================
     FORMAT HELPERS
     ============================================================ */
  const formatDate = (d?: string | null) => {
    if (!d) return "—";
    const [y, m, day] = d.split("-");
    return `${day}/${m}/${y}`;
  };

  const stats = useMemo(() => {
    const s = { maleRq: 0, femaleRq: 0, maleRecruited: 0, femaleRecruited: 0, maleBalance: 0, femaleBalance: 0, totalBalance: 0, pending: 0, processing: 0, completed: 0, cancelled: 0 };
    rows.forEach((r) => {
      s.maleRq += r.maleRq;
      s.femaleRq += r.femaleRq;
      s.maleRecruited += r.maleRecruited;
      s.femaleRecruited += r.femaleRecruited;
      s.maleBalance += r.maleBalance;
      s.femaleBalance += r.femaleBalance;
      s.totalBalance += r.totalBalance;
      if (r.status === "PENDING") s.pending++;
      else if (r.status === "PROCESSING") s.processing++;
      else if (r.status === "COMPLETED") s.completed++;
      else if (r.status === "CANCELLED") s.cancelled++;
    });
    return s;
  }, [rows]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={<SectionLabel>Workforce Recruitment Request Planning</SectionLabel>}
        title="Yêu cầu tuyển dụng — Recruitment Requests"
        description="Quản lý yêu cầu tuyển dụng chi tiết. Import từ Excel/Google Sheets bằng TSV paste với header alias mapping linh hoạt."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <ClipboardPaste className="h-4 w-4" /> Dán kế hoạch từ Excel / Google Sheets
            </Button>
            <Button variant="primary" onClick={handleExport}>
              <FileDown className="h-4 w-4" /> Xuất Excel
            </Button>
          </div>
        }
      />

      {/* Stats */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <SectionLabel tone="green">Summary</SectionLabel>
            <h2 className="mt-1 text-[16px] font-bold text-fg">Tổng hợp theo bộ lọc hiện tại</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="blue" dot>Pending {stats.pending}</Badge>
            <Badge tone="amber" dot>Processing {stats.processing}</Badge>
            <Badge tone="green" dot>Completed {stats.completed}</Badge>
            <Badge tone="gray" dot>Cancelled {stats.cancelled}</Badge>
          </div>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-[14px] border border-border bg-surface-raised p-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-muted">Nhu cầu</p>
            <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-primary">{stats.maleRq + stats.femaleRq}</p>
            <p className="mt-1 text-[11px] text-fg-muted">Nam {stats.maleRq} · Nữ {stats.femaleRq}</p>
          </div>
          <div className="rounded-[14px] border border-border bg-surface-raised p-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-muted">Đã tuyển</p>
            <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-success">{stats.maleRecruited + stats.femaleRecruited}</p>
            <p className="mt-1 text-[11px] text-fg-muted">Nam {stats.maleRecruited} · Nữ {stats.femaleRecruited}</p>
          </div>
          <div className="rounded-[14px] border border-border bg-surface-raised p-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-muted">Còn cần tuyển</p>
            <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-warning">{stats.totalBalance}</p>
            <p className="mt-1 text-[11px] text-fg-muted">Nam {stats.maleBalance} · Nữ {stats.femaleBalance}</p>
          </div>
          <div className="rounded-[14px] border border-border bg-surface-raised p-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-muted">All requests</p>
            <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-accent">{total}</p>
            <p className="mt-1 text-[11px] text-fg-muted">{rows.length} hiển thị</p>
          </div>
        </div>
      </Card>

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[180px] flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
            <input
              type="text"
              placeholder="Tìm Request Code..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-full rounded-[8px] border border-border-strong bg-surface-raised pl-8 pr-3 text-xs text-fg placeholder:text-fg-muted outline-none focus:border-accent"
            />
          </div>
          <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} className="h-9 rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent">
            <option value="">Month</option>
            {distinctMonths.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} className="h-9 max-w-[140px] rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent">
            <option value="">Location</option>
            {distinctLocations.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)} className="h-9 max-w-[140px] rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent">
            <option value="">Division</option>
            {distinctDivisions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)} className="h-9 max-w-[150px] rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent">
            <option value="">Department</option>
            {distinctDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)} className="h-9 max-w-[130px] rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent">
            <option value="">Section</option>
            {distinctSections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className="h-9 max-w-[130px] rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent">
            <option value="">Group</option>
            {distinctGroups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-9 rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent">
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={requesterFilter} onChange={(e) => setRequesterFilter(e.target.value)} className="h-9 max-w-[150px] rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent">
            <option value="">Requester</option>
            {distinctRequesters.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </Card>

      {/* Batch actions bar */}
      {selectedIds.length > 0 && (
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
            <Button size="sm" variant="ghost" onClick={() => { setSelected({}); setSelectAll(false); }}>
              Bỏ chọn
            </Button>
          </div>
        </Card>
      )}

      {/* Main Table */}
      <Card className="overflow-hidden p-0">
        <CardContent className="p-0">
          {loading ? (
            <div className="v2-scroll overflow-x-auto p-6">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 border-b border-border py-3.5">
                  <div className="skeleton h-4 w-32" />
                  <div className="skeleton h-4 w-24" />
                  <div className="skeleton h-4 w-16" />
                  <div className="skeleton h-4 w-20" />
                  <div className="skeleton ml-auto h-6 w-16 rounded-full" />
                </div>
              ))}
              <p className="mt-4 text-center text-[12.5px] text-fg-muted">Đang tải dữ liệu...</p>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<FileSpreadsheet className="h-5 w-5" />}
              title="Chưa có yêu cầu tuyển dụng nào"
              description="Nhấn 'Dán kế hoạch từ Excel / Google Sheets' để import dữ liệu, hoặc tạo yêu cầu mới."
              action={
                <Button variant="primary" size="sm" onClick={() => setImportOpen(true)}>
                  <ClipboardPaste className="h-4 w-4" /> Dán kế hoạch từ Excel
                </Button>
              }
            />
          ) : (
            <div className="v2-scroll overflow-x-auto">
              <table className="grid-sheet w-full text-[13px]">
                <thead className="sticky top-0 z-10 bg-primary-tint/95 shadow-[inset_0_-1px_0_var(--color-border)] backdrop-blur">
                  <tr>
                    <th className="w-10 px-2 py-2.5 text-center">
                      <button onClick={toggleSelectAll} className="mx-auto" aria-label="Chọn tất cả">
                        {selectAll || selectedIds.length === rows.length ? (
                          <CheckSquare className="h-4 w-4 text-primary" />
                        ) : (
                          <Square className="h-4 w-4 text-fg-muted" />
                        )}
                      </button>
                    </th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Request Code</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Requester</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Vị trí</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Location</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Org</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Nam / Nữ (Nhu cầu)</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Đã tuyển</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Balance</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Status</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Ngày</th>
                    <th className="px-3 py-2.5 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b border-border/70 bg-surface transition-colors hover:bg-botanical-50",
                        selected[r.id] && "bg-accent-tint/30",
                      )}
                    >
                      <td className="px-2 py-2.5 text-center">
                        <button onClick={() => toggleSelect(r.id)} aria-label={`Chọn ${r.requestCode}`}>
                          {selected[r.id] ? (
                            <CheckSquare className="h-4 w-4 text-primary" />
                          ) : (
                            <Square className="h-4 w-4 text-fg-muted" />
                          )}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="font-semibold text-fg font-mono text-xs">{r.requestCode}</span>
                      </td>
                      <td className="px-3 py-2.5 text-fg">{r.requester}</td>
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-fg">{r.jobTitle ?? r.position ?? "—"}</div>
                        <div className="text-[11px] text-fg-muted">{r.reason ? r.reason.slice(0, 40) : ""}</div>
                      </td>
                      <td className="px-3 py-2.5 text-fg text-xs">{r.location ?? "—"}</td>
                      <td className="px-3 py-2.5">
                        <div className="text-xs text-fg">
                          {[r.division, r.department ?? r.departmentText, r.section, r.groupName].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <div className="font-semibold text-fg">{r.maleRq + r.femaleRq}</div>
                        <div className="text-[11px] text-fg-muted">{r.maleRq} Nam · {r.femaleRq} Nữ</div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="font-semibold text-success">{r.maleRecruited + r.femaleRecruited}</span>
                        <div className="text-[11px] text-fg-muted">{r.maleRecruited} · {r.femaleRecruited}</div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={cn("font-semibold", r.totalBalance > 0 ? "text-warning" : "text-success")}>
                          {r.totalBalance}
                        </span>
                        <div className="text-[11px] text-fg-muted">{r.maleBalance} · {r.femaleBalance}</div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2.5 text-center text-[11px] text-fg-muted">
                        {r.requestedDate ? formatDate(r.requestedDate) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex justify-end gap-1">
                          {r.status === "PENDING" && (
                            <button
                              onClick={() => batchAction("status", "PROCESSING")}
                              className="rounded-full bg-success-tint px-2 py-0.5 text-[10px] font-semibold text-success hover:bg-success/20 transition-colors"
                            >
                              Activate
                            </button>
                          )}
                          {r.status === "CANCELLED" || r.status === "COMPLETED" ? (
                            <button
                              onClick={() => batchAction("status", "PENDING")}
                              className="rounded-full bg-primary-tint px-2 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/15 transition-colors"
                            >
                              Reopen
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Import Modal */}
      <Modal
        open={importOpen}
        onClose={() => { setImportOpen(false); setImportPreview(null); setImportText(""); setImportFile(null); }}
        title="Import Yêu Cầu Tuyển Dụng từ Excel / Google Sheets"
        description="Copy vùng dữ liệu từ Excel/Google Sheets (CMD+C / Ctrl+C) rồi paste vào ô bên dưới, hoặc upload file CSV/XLSX."
        width="max-w-5xl"
      >
        <div className="space-y-4">
          {/* Step 1: Paste / Upload */}
          {!importPreview && (
            <>
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
                  className="w-full rounded-[10px] border border-border-strong bg-surface-raised p-3 text-[13px] text-fg outline-none focus:border-accent font-mono"
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

          {/* Step 2: Preview */}
          {importPreview && (
            <>
              <div className="flex items-center justify-between rounded-[10px] bg-surface-hover p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-semibold text-fg">Tổng: {importPreview.totalRows} dòng</span>
                  <Badge tone="green">{importPreview.validCount} hợp lệ</Badge>
                  {importPreview.errorCount > 0 && <Badge tone="red">{importPreview.errorCount} lỗi</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  {importPreview.unknownHeaders.length > 0 && (
                    <div className="text-[11px] text-fg-muted">
                      <AlertTriangle className="inline h-3 w-3 mr-1" />
                      {importPreview.unknownHeaders.length} cột không nhận diện được
                    </div>
                  )}
                </div>
              </div>

              {/* Duplicate handling options */}
              <div className="flex items-center gap-4 rounded-[10px] border border-border bg-surface-raised p-3">
                <label className="flex items-center gap-2 text-xs font-medium text-fg cursor-pointer">
                  <input type="checkbox" checked={importSkipDup} onChange={(e) => { setImportSkipDup(e.target.checked); if (e.target.checked) setImportUpdateDup(false); }} className="h-4 w-4 rounded accent-primary" />
                  Bỏ qua Request Code trùng
                </label>
                <label className="flex items-center gap-2 text-xs font-medium text-fg cursor-pointer">
                  <input type="checkbox" checked={importUpdateDup} onChange={(e) => { setImportUpdateDup(e.target.checked); if (e.target.checked) setImportSkipDup(false); }} className="h-4 w-4 rounded accent-primary" />
                  Cập nhật Request Code trùng
                </label>
              </div>

              {/* Preview Grid */}
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
                            <span className="text-success font-semibold">✓ OK</span>
                          ) : (
                            <span className="text-danger text-[10px]" title={p.errors.map((e) => e.message).join("; ")}>
                              ✗ {p.errors.length} lỗi
                            </span>
                          )}
                          {p.warnings.length > 0 && (
                            <span className="ml-1 text-warning text-[10px]" title={p.warnings.map((w) => w.message).join("; ")}>
                              ⚠ {p.warnings.length}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Errors detail */}
              {importPreview.previewFull.some((p) => !p.valid) && (
                <div className="rounded-[10px] border border-danger/30 bg-danger-tint/20 p-3">
                  <p className="text-[11px] font-semibold text-danger mb-1">Chi tiết lỗi:</p>
                  <ul className="list-disc list-inside text-[11px] text-danger space-y-0.5">
                    {importPreview.previewFull.filter((p) => !p.valid).slice(0, 10).map((p) => (
                      <li key={p.rowIndex}>
                        Dòng {p.rowIndex}: {p.errors.map((e) => e.message).join("; ")}
                      </li>
                    ))}
                  </ul>
                  {importPreview.previewFull.filter((p) => !p.valid).length > 10 && (
                    <p className="text-[11px] text-fg-muted mt-1">
                      ...và {importPreview.previewFull.filter((p) => !p.valid).length - 10} lỗi khác
                    </p>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => { setImportPreview(null); setImportText(""); }}>
                  Quay lại
                </Button>
                <Button
                  variant="primary"
                  onClick={handleImport}
                  loading={importing}
                  disabled={importPreview.validCount === 0}
                >
                  Import {importPreview.validCount} dòng hợp lệ
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}