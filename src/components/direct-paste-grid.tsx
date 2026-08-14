"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import {
  CalendarDays,
  ClipboardCopy,
  ClipboardPaste,
  Columns3,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { Badge, Button, Card, CardContent, Input, Label, Modal, Textarea, toast } from "@/components/ui";
import { todayStr } from "@/lib/helpers";
import { normalizeGridHeader, parseClipboardTable, serializeCsv } from "@/lib/paste-grid";

export type PasteJobType = "department" | "dw_data" | "daily_application";

type TemplateColumn = {
  id: string;
  fieldKey: string;
  header: string;
  label: string;
  source: "CORE" | "QUESTION";
  required: boolean;
  requiredForImport: boolean;
  fieldType: string;
  options: string[];
  aliases: string[];
  sortOrder: number;
  defaultVisible: boolean;
  isActiveQuestion: boolean;
  visibleToApplicants: boolean;
  questionFieldKeys: string[];
};

type GridRow = Record<string, string>;

const INITIAL_ROWS = 15;
const PAGE_SIZE = 50;
const MAX_PASTE_ROWS = 10_000;
const FIELD_TYPES = [
  { value: "TEXT", label: "Văn bản" },
  { value: "NUMBER", label: "Số" },
  { value: "SELECT", label: "Danh sách lựa chọn" },
  { value: "BOOLEAN", label: "Có / Không" },
  { value: "DATE", label: "Ngày" },
];

function makeBlankRows(count = INITIAL_ROWS): GridRow[] {
  return Array.from({ length: count }, () => ({}));
}

function rowHasData(row: GridRow, columnIds: string[]) {
  return columnIds.some((id) => String(row[id] ?? "").trim() !== "");
}

function questionKey(text: string) {
  const slug = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 44) || "cau_hoi";
  return `${slug}_${Date.now().toString(36).slice(-5)}`;
}

export function DirectPasteGrid({
  jobType,
  submitting,
  uploadPct,
  onSubmit,
}: {
  jobType: PasteJobType;
  submitting: boolean;
  uploadPct: number;
  onSubmit: (file: File) => void;
}) {
  const [columns, setColumns] = useState<TemplateColumn[]>([]);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [rows, setRows] = useState<GridRow[]>(() => makeBlankRows());
  const [loading, setLoading] = useState(true);
  const [addColumnId, setAddColumnId] = useState("");
  const [page, setPage] = useState(0);
  const activeCellRef = useRef({ row: 0, column: 0 });

  const [questionOpen, setQuestionOpen] = useState(false);
  const [savingQuestion, setSavingQuestion] = useState(false);
  const [questionForm, setQuestionForm] = useState({
    questionText: "",
    fieldType: "TEXT",
    optionsRaw: "",
    isRequired: false,
  });

  const loadTemplate = useCallback(async (preferQuestionFieldKey?: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/import/template?jobType=${jobType}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Không tải được template");
      const nextColumns = (data.columns ?? []) as TemplateColumn[];
      setColumns(nextColumns);
      setVisibleIds((current) => {
        // Khi đổi loại dữ liệu, current thuộc template cũ và phải reset. Khi vừa
        // tạo câu hỏi, giữ bố cục hiện tại rồi thêm cột liên quan vào cuối.
        if (!preferQuestionFieldKey) return nextColumns.filter((column) => column.defaultVisible).map((column) => column.id);
        const validCurrent = current.filter((id) => nextColumns.some((column) => column.id === id));
        const createdColumn = nextColumns.find((column) =>
          column.questionFieldKeys.includes(preferQuestionFieldKey),
        );
        return createdColumn && !validCurrent.includes(createdColumn.id)
          ? [...validCurrent, createdColumn.id]
          : validCurrent;
      });
    } catch (error) {
      setColumns([]);
      setVisibleIds([]);
      toast({ title: (error as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [jobType]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTemplate(), 0);
    return () => window.clearTimeout(timer);
  }, [loadTemplate]);

  const visibleColumns = useMemo(
    () => visibleIds.map((id) => columns.find((column) => column.id === id)).filter(Boolean) as TemplateColumn[],
    [columns, visibleIds],
  );
  const hiddenColumns = useMemo(
    () => columns.filter((column) => !visibleIds.includes(column.id)),
    [columns, visibleIds],
  );
  const populatedRows = useMemo(
    () => rows.filter((row) => rowHasData(row, visibleIds)),
    [rows, visibleIds],
  );
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE);
  const formQuestionCount = visibleColumns.filter(
    (column) => column.source === "QUESTION" || column.questionFieldKeys.length > 0,
  ).length;

  const updateCell = (rowIndex: number, columnId: string, value: string) => {
    setRows((current) => {
      const next = current.slice();
      next[rowIndex] = { ...(next[rowIndex] ?? {}), [columnId]: value };
      return next;
    });
  };

  const findColumnForHeader = useCallback((value: string) => {
    const normalized = normalizeGridHeader(value);
    if (!normalized) return undefined;
    return columns.find((column) =>
      [column.label, column.header, column.fieldKey, ...column.aliases]
        .some((name) => normalizeGridHeader(name) === normalized),
    );
  }, [columns]);

  const pasteMatrix = useCallback((matrixInput: string[][], startRow: number, startColumn: number) => {
    if (matrixInput.length === 0) return;
    const matrix = matrixInput.slice(0, MAX_PASTE_ROWS + 1);
    const possibleHeaderColumns = matrix[0].map(findColumnForHeader);
    const recognizedHeaders = possibleHeaderColumns.filter(Boolean).length;
    const looksLikeHeader = matrix.length > 1 && (
      recognizedHeaders >= 2 ||
      (matrix[0].length === 1 && recognizedHeaders === 1)
    ) && recognizedHeaders / Math.max(1, matrix[0].length) >= 0.6;

    let targetIds: (string | null)[];
    let dataRows: string[][];
    if (looksLikeHeader) {
      targetIds = possibleHeaderColumns.map((column) => column?.id ?? null);
      dataRows = matrix.slice(1, MAX_PASTE_ROWS + 1);
      setVisibleIds((current) => {
        const next = current.slice();
        for (const id of targetIds) if (id && !next.includes(id)) next.push(id);
        return next;
      });
      toast({ title: `Đã nhận diện ${recognizedHeaders} cột theo hàng tiêu đề` });
    } else {
      targetIds = matrix[0].map((_, index) => visibleColumns[startColumn + index]?.id ?? null);
      dataRows = matrix.slice(0, MAX_PASTE_ROWS);
    }

    if (targetIds.every((id) => !id)) {
      toast({ title: "Không còn cột để nhận dữ liệu. Hãy bấm Thêm cột.", variant: "destructive" });
      return;
    }

    setRows((current) => {
      const next = current.slice();
      const requiredLength = startRow + dataRows.length;
      while (next.length < requiredLength) next.push({});
      dataRows.forEach((sourceRow, rowOffset) => {
        const targetRow = { ...(next[startRow + rowOffset] ?? {}) };
        sourceRow.forEach((value, columnOffset) => {
          const id = targetIds[columnOffset];
          if (id) targetRow[id] = value;
        });
        next[startRow + rowOffset] = targetRow;
      });
      return next;
    });
    setPage(Math.floor(startRow / PAGE_SIZE));

    if (matrixInput.length > MAX_PASTE_ROWS) {
      toast({ title: `Bảng trực tiếp nhận tối đa ${MAX_PASTE_ROWS.toLocaleString("vi-VN")} dòng mỗi lần dán.`, variant: "destructive" });
    }
  }, [findColumnForHeader, visibleColumns]);

  const handleCellPaste = (event: ClipboardEvent<HTMLInputElement>, rowIndex: number, columnIndex: number) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    pasteMatrix(parseClipboardTable(text), rowIndex, columnIndex);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        toast({ title: "Clipboard đang trống", variant: "destructive" });
        return;
      }
      pasteMatrix(
        parseClipboardTable(text),
        activeCellRef.current.row,
        activeCellRef.current.column,
      );
    } catch {
      toast({
        title: "Trình duyệt chưa cho phép đọc clipboard — hãy bấm vào ô đầu tiên rồi nhấn Ctrl+V.",
        variant: "destructive",
      });
    }
  };

  const copyTable = async () => {
    const dataRows = populatedRows.map((row) => visibleColumns.map((column) => row[column.id] ?? ""));
    const tsv = [
      visibleColumns.map((column) => column.header),
      ...dataRows,
    ].map((line) => line.join("\t")).join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      toast({ title: `Đã sao chép ${dataRows.length} dòng và ${visibleColumns.length} cột` });
    } catch {
      toast({ title: "Không thể ghi vào clipboard trên trình duyệt này", variant: "destructive" });
    }
  };

  const addSelectedColumn = () => {
    if (!addColumnId) return;
    setVisibleIds((current) => current.includes(addColumnId) ? current : [...current, addColumnId]);
    setAddColumnId("");
  };

  const removeColumn = (id: string) => {
    if (visibleIds.length <= 1) {
      toast({ title: "Bảng cần ít nhất một cột", variant: "destructive" });
      return;
    }
    setVisibleIds((current) => current.filter((columnId) => columnId !== id));
  };

  const removeRow = (rowIndex: number) => {
    setRows((current) => {
      const next = current.filter((_, index) => index !== rowIndex);
      return next.length > 0 ? next : [{}];
    });
  };

  const resetTable = () => {
    setVisibleIds(columns.filter((column) => column.defaultVisible).map((column) => column.id));
    setRows(makeBlankRows());
    setPage(0);
  };

  const fillToday = () => {
    const dateColumn = columns.find((column) => column.fieldKey === "da_timestamp");
    if (!dateColumn) return;
    const today = todayStr();
    setRows((current) => current.map((row) => {
      if (!rowHasData(row, visibleIds) || String(row[dateColumn.id] ?? "").trim()) return row;
      return { ...row, [dateColumn.id]: today };
    }));
    toast({ title: "Đã điền ngày hôm nay cho các dòng có dữ liệu" });
  };

  const submitGrid = () => {
    const missingRequiredColumns = columns.filter(
      (column) => column.requiredForImport && !visibleIds.includes(column.id),
    );
    if (missingRequiredColumns.length > 0) {
      toast({
        title: `Hãy thêm lại cột bắt buộc: ${missingRequiredColumns.map((column) => column.label).join(", ")}`,
        variant: "destructive",
      });
      return;
    }
    if (populatedRows.length === 0) {
      toast({ title: "Bảng chưa có dữ liệu — hãy dán hoặc nhập ít nhất một dòng", variant: "destructive" });
      return;
    }

    const csvRows = populatedRows.map((row) => visibleColumns.map((column) => row[column.id] ?? ""));
    const csv = serializeCsv(visibleColumns.map((column) => column.header), csvRows);
    const file = new File([csv], `Bang-dan-truc-tiep-${jobType}-${todayStr()}.csv`, {
      type: "text/csv;charset=utf-8",
    });
    onSubmit(file);
  };

  const createQuestion = async () => {
    const questionText = questionForm.questionText.trim();
    if (!questionText) {
      toast({ title: "Hãy nhập nội dung câu hỏi", variant: "destructive" });
      return;
    }
    setSavingQuestion(true);
    try {
      const fieldKey = questionKey(questionText);
      const res = await fetch("/api/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldKey,
          questionText,
          fieldType: questionForm.fieldType,
          options: questionForm.optionsRaw.split("\n").map((value) => value.trim()).filter(Boolean),
          isRequired: questionForm.isRequired,
          isActive: true,
          visibleToApplicants: true,
          targetAudience: "ALL",
          sortOrder: Math.max(
            0,
            ...columns
              .filter((column) => column.source === "QUESTION")
              .map((column) => Math.max(0, column.sortOrder - 10_000)),
          ) + 1,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Không thể tạo câu hỏi");
      await loadTemplate(fieldKey);
      setQuestionOpen(false);
      setQuestionForm({ questionText: "", fieldType: "TEXT", optionsRaw: "", isRequired: false });
      toast({ title: "Đã thêm cột và đồng bộ câu hỏi lên form đăng ký tập nghề" });
    } catch (error) {
      toast({ title: (error as Error).message, variant: "destructive" });
    } finally {
      setSavingQuestion(false);
    }
  };

  return (
    <>
      <Card className="hasfarm-card overflow-hidden rounded-[22px] border-0 p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border bg-surface px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
              <Table2 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-black text-fg">Bảng template — nhập và dán trực tiếp</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-fg-secondary">
                Copy vùng dữ liệu từ Excel/Google Sheets, bấm ô bắt đầu rồi nhấn <b>Ctrl+V</b>. Nếu có hàng tiêu đề, hệ thống tự nhận diện và ghép đúng cột.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="blue">{visibleColumns.length} cột</Badge>
            <Badge tone="green">{populatedRows.length.toLocaleString("vi-VN")} dòng có dữ liệu</Badge>
            {jobType === "daily_application" && <Badge tone="amber">{formQuestionCount} câu hỏi form</Badge>}
          </div>
        </div>

        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void pasteFromClipboard()} className="gap-2">
              <ClipboardPaste className="h-4 w-4" /> Dán từ clipboard
            </Button>
            <Button type="button" variant="outline" onClick={() => void copyTable()} className="gap-2">
              <ClipboardCopy className="h-4 w-4" /> Sao chép bảng
            </Button>
            <Button type="button" variant="outline" onClick={() => setRows((current) => [...current, ...makeBlankRows(10)])} className="gap-2">
              <Plus className="h-4 w-4" /> Thêm 10 dòng
            </Button>
            {jobType === "daily_application" && (
              <Button type="button" variant="outline" onClick={fillToday} className="gap-2">
                <CalendarDays className="h-4 w-4" /> Điền ngày hôm nay
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={resetTable} className="gap-2 text-fg-secondary">
              <RotateCcw className="h-4 w-4" /> Làm mới bảng
            </Button>
          </div>

          <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-border bg-botanical-50/60 p-3">
            <div className="min-w-[260px] flex-1">
              <Label className="mb-1 text-xs">Thêm lại cột đã xoá / cột chưa hiển thị</Label>
              <select
                value={addColumnId}
                onChange={(event) => setAddColumnId(event.target.value)}
                className="h-10 w-full rounded-[10px] border border-border-strong bg-white px-3 text-sm font-semibold text-fg outline-none focus:border-accent"
              >
                <option value="">— Chọn cột —</option>
                {hiddenColumns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.label}{column.source === "QUESTION" ? " · Câu hỏi form" : ""}{!column.isActiveQuestion && column.source === "QUESTION" ? " · Đang tắt" : ""}
                  </option>
                ))}
              </select>
            </div>
            <Button type="button" variant="secondary" onClick={addSelectedColumn} disabled={!addColumnId} className="gap-2">
              <Columns3 className="h-4 w-4" /> Thêm cột
            </Button>
            {jobType === "daily_application" && (
              <Button type="button" variant="primary" onClick={() => setQuestionOpen(true)} className="gap-2">
                <Sparkles className="h-4 w-4" /> Tạo cột = câu hỏi mới
              </Button>
            )}
          </div>

          <div className="rounded-xl border border-border bg-white">
            {loading ? (
              <div className="flex h-56 items-center justify-center gap-2 text-sm font-semibold text-fg-secondary">
                <Loader2 className="h-5 w-5 animate-spin text-primary" /> Đang dựng template từ cấu hình hiện tại…
              </div>
            ) : visibleColumns.length === 0 ? (
              <div className="p-10 text-center text-sm text-fg-muted">Chưa có cột. Hãy bấm Thêm cột.</div>
            ) : (
              <div className="max-h-[570px] overflow-auto">
                {visibleColumns.map((column) => column.options.length > 0 && (
                  <datalist key={column.id} id={`options-${column.id}`}>
                    {column.options.map((option) => <option key={option} value={option} />)}
                  </datalist>
                ))}
                <table className="grid-sheet min-w-max border-collapse text-[13px]">
                  <thead className="sticky top-0 z-20">
                    <tr>
                      <th className="sticky left-0 z-30 w-14 min-w-14 bg-primary px-2 py-3 text-center text-[11px] font-black text-white">#</th>
                      {visibleColumns.map((column) => (
                        <th
                          key={column.id}
                          className={`${column.source === "QUESTION" || column.questionFieldKeys.length > 0 ? "bg-accent" : "bg-primary"} min-w-[190px] max-w-[280px] px-3 py-2 text-left align-top text-white`}
                          title={column.header !== column.label ? `Tên cột import: ${column.header}` : column.label}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="whitespace-normal text-xs font-black leading-5">
                                {column.label}{column.required && <span className="ml-1 text-gold-200">*</span>}
                              </p>
                              <p className="mt-0.5 truncate text-[9px] font-semibold uppercase tracking-wider text-white/65">
                                {column.source === "QUESTION" || column.questionFieldKeys.length > 0 ? "Câu hỏi form tập nghề" : "Trường dữ liệu lõi"}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeColumn(column.id)}
                              className="mt-0.5 rounded p-1 text-white/70 transition hover:bg-white/15 hover:text-white"
                              title="Xoá cột khỏi bảng nhập (không xoá dữ liệu/câu hỏi trong hệ thống)"
                              aria-label={`Xoá cột ${column.label} khỏi bảng`}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </th>
                      ))}
                      <th className="sticky right-0 z-30 w-12 min-w-12 bg-primary px-2 py-3 text-white" aria-label="Thao tác dòng" />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row, localIndex) => {
                      const rowIndex = pageStart + localIndex;
                      return (
                        <tr key={rowIndex} className="group hover:bg-primary-tint/30">
                          <td className="sticky left-0 z-10 bg-surface-hover px-2 py-1 text-center text-[11px] font-bold text-fg-muted group-hover:bg-primary-tint">
                            {rowIndex + 1}
                          </td>
                          {visibleColumns.map((column, columnIndex) => (
                            <td key={column.id} className="min-w-[190px] bg-white p-0 group-hover:bg-primary-tint/20">
                              <input
                                value={row[column.id] ?? ""}
                                onFocus={() => { activeCellRef.current = { row: rowIndex, column: columnIndex }; }}
                                onChange={(event) => updateCell(rowIndex, column.id, event.target.value)}
                                onPaste={(event) => handleCellPaste(event, rowIndex, columnIndex)}
                                list={column.options.length > 0 ? `options-${column.id}` : undefined}
                                className="h-10 w-full min-w-[190px] bg-transparent px-3 text-[13px] text-fg outline-none focus:bg-accent-tint/45 focus:shadow-[inset_0_0_0_2px_#e26d1c]"
                                placeholder={rowIndex === 0 ? "Nhập hoặc dán…" : ""}
                                aria-label={`${column.label}, dòng ${rowIndex + 1}`}
                              />
                            </td>
                          ))}
                          <td className="sticky right-0 z-10 bg-white p-1 text-center group-hover:bg-primary-tint">
                            <button
                              type="button"
                              onClick={() => removeRow(rowIndex)}
                              className="rounded-md p-1.5 text-fg-muted hover:bg-danger-tint hover:text-danger"
                              title="Xoá dòng"
                              aria-label={`Xoá dòng ${rowIndex + 1}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-fg-secondary">
              <span>Hiển thị dòng {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, rows.length)} / {rows.length.toLocaleString("vi-VN")}</span>
              {totalPages > 1 && (
                <>
                  <Button type="button" size="sm" variant="outline" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Trước</Button>
                  <span className="font-bold">Trang {safePage + 1}/{totalPages}</span>
                  <Button type="button" size="sm" variant="outline" disabled={safePage >= totalPages - 1} onClick={() => setPage((value) => Math.min(totalPages - 1, value + 1))}>Sau</Button>
                </>
              )}
            </div>
            <Button type="button" size="lg" onClick={submitGrid} disabled={submitting || loading || populatedRows.length === 0} className="min-w-[240px] gap-2">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Table2 className="h-4 w-4" />}
              {submitting ? `Đang gửi bảng… ${uploadPct}%` : `Xử lý ${populatedRows.length.toLocaleString("vi-VN")} dòng trong bảng`}
            </Button>
          </div>
          <p className="text-[11px] leading-5 text-fg-muted">
            Dấu * cho biết trường/câu hỏi bắt buộc. Nút × chỉ bỏ cột khỏi bảng nhập hiện tại, không xoá câu hỏi khỏi form. Các dòng lỗi vẫn được tách riêng trong Job Log như quy trình Import Engine.
          </p>
        </CardContent>
      </Card>

      <Modal open={questionOpen} onClose={() => setQuestionOpen(false)} title="Tạo cột và câu hỏi mới trên form tập nghề">
        <div className="space-y-4">
          <div className="rounded-xl border border-info/15 bg-info-tint p-3 text-xs leading-5 text-fg-secondary">
            Cột mới sẽ xuất hiện ngay trong bảng này và đồng thời trở thành câu hỏi đang hoạt động trên form đăng ký tập nghề công khai.
          </div>
          <div>
            <Label required>Nội dung câu hỏi / tên cột</Label>
            <Textarea
              value={questionForm.questionText}
              onChange={(event) => setQuestionForm((current) => ({ ...current, questionText: event.target.value }))}
              rows={2}
              placeholder="Ví dụ: Bạn có thể bắt đầu làm việc từ ngày nào?"
            />
          </div>
          <div>
            <Label>Kiểu câu trả lời</Label>
            <select
              value={questionForm.fieldType}
              onChange={(event) => setQuestionForm((current) => ({ ...current, fieldType: event.target.value }))}
              className="h-11 w-full rounded-[10px] border border-border-strong bg-white px-3 text-sm font-semibold"
            >
              {FIELD_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </div>
          {questionForm.fieldType === "SELECT" && (
            <div>
              <Label>Danh sách lựa chọn (mỗi dòng một lựa chọn)</Label>
              <Textarea
                value={questionForm.optionsRaw}
                onChange={(event) => setQuestionForm((current) => ({ ...current, optionsRaw: event.target.value }))}
                rows={5}
                placeholder={"Lựa chọn 1\nLựa chọn 2\nLựa chọn 3"}
              />
            </div>
          )}
          <label className="flex items-center gap-2 text-sm font-semibold text-fg">
            <input
              type="checkbox"
              checked={questionForm.isRequired}
              onChange={(event) => setQuestionForm((current) => ({ ...current, isRequired: event.target.checked }))}
              className="h-4 w-4 accent-primary"
            />
            Bắt buộc trả lời trên form đăng ký
          </label>
          <Button type="button" size="lg" className="w-full" onClick={() => void createQuestion()} disabled={savingQuestion}>
            {savingQuestion ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {savingQuestion ? "Đang tạo…" : "Tạo cột và đồng bộ lên form"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
