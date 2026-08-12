"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Label,
  Modal,
  Textarea,
  toast,
} from "@/components/ui";
import { Loader2 } from "lucide-react";

type Question = {
  id: string;
  fieldKey: string;
  questionText: string;
  fieldType: string;
  options: string[] | null;
  isRequired: boolean;
  sortOrder: number;
  isActive: boolean;
  applyFrom: string | null;
  aliases: string[] | null;
  exportColumnName: string | null;
};

const TYPES = [
  { value: "TEXT", label: "Nhập văn bản" },
  { value: "NUMBER", label: "Nhập số" },
  { value: "SELECT", label: "Chọn từ danh sách (có tìm kiếm)" },
  { value: "BOOLEAN", label: "Có / Không" },
];

export default function FormBuilderPage() {
  const [rows, setRows] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    fieldKey: "",
    questionText: "",
    fieldType: "TEXT",
    optionsRaw: "",
    isRequired: false,
    sortOrder: 10,
    applyFrom: "",
    aliasesRaw: "",
    exportColumnName: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/questions");
    const data = await res.json();
    setRows(data.rows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const res = await fetch("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        options: form.optionsRaw
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        aliases: form.aliasesRaw
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        exportColumnName: form.exportColumnName || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast({ title: data.error ?? "Lỗi tạo câu hỏi", variant: "destructive" });
      return;
    }
    toast({ title: "Đã thêm câu hỏi — form người xin việc sẽ tự hiển thị từ ngày áp dụng" });
    setOpen(false);
    setForm({
      fieldKey: "",
      questionText: "",
      fieldType: "TEXT",
      optionsRaw: "",
      isRequired: false,
      sortOrder: 0,
      applyFrom: "",
      aliasesRaw: "",
      exportColumnName: "",
    });
    await load();
  };

  const patch = async (id: string, body: Partial<Question>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...body } : r)));
    const res = await fetch("/api/questions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    if (!res.ok) {
      toast({ title: "Lưu thất bại", variant: "destructive" });
      await load();
    }
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/questions?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json();
      toast({ title: d.error, variant: "destructive" });
      return;
    }
    toast({ title: "Đã xoá câu hỏi" });
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-fg">Trình tạo câu hỏi động</h1>
          <p className="text-sm text-fg-secondary">
            Thêm/sửa câu hỏi cho form đăng ký mà không cần lập trình lại (lưu dạng JSONB).
          </p>
        </div>
        <Button
          variant="gold"
          onClick={() => {
            const nextSortOrder = rows.length > 0 ? Math.max(...rows.map((r) => r.sortOrder)) + 1 : 1;
            setForm((f) => ({ ...f, sortOrder: nextSortOrder }));
            setOpen(true);
          }}
        >
          + Thêm câu hỏi
        </Button>
      </div>

      <Card className="p-0">
        <CardHeader title="Câu hỏi hiện có" subtitle="Bật/tắt hiển thị và bắt buộc trả lời" />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <ul className="divide-y">
              {rows.length === 0 && (
                <li className="p-8 text-center text-sm text-fg-muted">Chưa có câu hỏi nào.</li>
              )}
              {rows.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-[240px] flex-1">
                    <p className="font-bold text-fg">{q.questionText}</p>
                    <p className="text-xs text-fg-secondary">
                      <span className="font-mono">{q.fieldKey}</span> ·{" "}
                      {TYPES.find((t) => t.value === q.fieldType)?.label ?? q.fieldType}
                      {q.fieldType === "SELECT" && ` · ${q.options?.length ?? 0} lựa chọn`}
                      {q.applyFrom
                        ? ` · Áp dụng từ ${q.applyFrom.split("-").reverse().join("/")}`
                        : " · Áp dụng ngay"}
                    </p>
                  </div>
                  <button onClick={() => void patch(q.id, { isRequired: !q.isRequired })}>
                    <Badge tone={q.isRequired ? "red" : "gray"}>
                      {q.isRequired ? "Bắt buộc" : "Tuỳ chọn"}
                    </Badge>
                  </button>
                  <button onClick={() => void patch(q.id, { isActive: !q.isActive })}>
                    <Badge tone={q.isActive ? "green" : "gray"}>
                      {q.isActive ? "Đang hiển thị" : "Đã ẩn"}
                    </Badge>
                  </button>
                  <input
                    type="number"
                    defaultValue={q.sortOrder}
                    title="Thứ tự"
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== q.sortOrder) void patch(q.id, { sortOrder: v });
                    }}
                    className="w-16 rounded border-2 border-border-strong px-2 py-1 text-sm"
                  />
                  <button
                    onClick={() => void remove(q.id)}
                    className="text-xs font-bold text-red-600 hover:underline"
                  >
                    Xoá
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Thêm câu hỏi động">
        <div className="space-y-3">
          <div>
            <Label>Mã trường (field key) *</Label>
            <Input
              value={form.fieldKey}
              onChange={(e) => setForm({ ...form, fieldKey: e.target.value })}
              placeholder="vd: kinh_nghiem_hai_hoa"
              className="h-11 font-mono"
            />
          </div>
          <div>
            <Label>Nội dung câu hỏi *</Label>
            <Textarea
              value={form.questionText}
              onChange={(e) => setForm({ ...form, questionText: e.target.value })}
              rows={2}
            />
          </div>
          <div>
            <Label>Kiểu trả lời</Label>
            <select
              value={form.fieldType}
              onChange={(e) => setForm({ ...form, fieldType: e.target.value })}
              className="h-11 w-full rounded-xl border-2 border-border-strong px-2 font-semibold"
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {form.fieldType === "SELECT" && (
            <div>
              <Label>Danh sách lựa chọn (mỗi dòng 1 lựa chọn)</Label>
              <Textarea
                value={form.optionsRaw}
                onChange={(e) => setForm({ ...form, optionsRaw: e.target.value })}
                rows={5}
                placeholder={"Xe máy\nXe đạp\nĐi bộ"}
              />
            </div>
          )}
          <div>
            <Label>Alias cột import (mỗi dòng 1 tên cột khác nhận diện được khi Import CSV/Excel)</Label>
            <Textarea
              value={form.aliasesRaw}
              onChange={(e) => setForm({ ...form, aliasesRaw: e.target.value })}
              rows={2}
              placeholder={"vd: Height\nChiều cao (cm)"}
            />
          </div>
          <div>
            <Label>Tên cột khi Export Excel (bỏ trống = dùng nội dung câu hỏi)</Label>
            <Input
              value={form.exportColumnName}
              onChange={(e) => setForm({ ...form, exportColumnName: e.target.value })}
              placeholder="vd: Chiều cao"
            />
          </div>
          <div>
            <Label>Ngày bắt đầu áp dụng</Label>
            <Input
              type="date"
              value={form.applyFrom}
              onChange={(e) => setForm({ ...form, applyFrom: e.target.value })}
              className="h-11"
            />
            <p className="mt-1 text-[11px] text-fg-muted">
              Bỏ trống = áp dụng ngay lập tức. Form của người xin việc tự hiển thị câu hỏi từ ngày này — không cần IT sửa code.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm font-bold">
              <input
                type="checkbox"
                checked={form.isRequired}
                onChange={(e) => setForm({ ...form, isRequired: e.target.checked })}
                className="h-4 w-4 accent-gold-500"
              />
              Bắt buộc trả lời
            </label>
            <div className="flex items-center gap-2">
              <Label className="mb-0">Thứ tự</Label>
              <Input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
                className="h-10 w-20"
              />
            </div>
          </div>
          <Button variant="gold" size="lg" className="w-full" onClick={create}>
            Lưu câu hỏi
          </Button>
        </div>
      </Modal>
    </div>
  );
}
