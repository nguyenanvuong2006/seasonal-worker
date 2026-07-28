"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, Input, Label, Modal, toast } from "@/components/ui";
import { Loader2, Download } from "lucide-react";

type FieldDef = {
  id: string;
  fieldKey: string;
  groupName: "department" | "dw_data" | "daily_application";
  displayName: string;
  databaseField: string;
  importColumnName: string | null;
  exportColumnName: string | null;
  aliases: string[] | null;
  fieldType: string;
  required: boolean;
  visible: boolean;
  searchable: boolean;
  sortable: boolean;
  filterable: boolean;
  exportable: boolean;
  importable: boolean;
  sortOrder: number;
  isSystem: boolean;
};

const GROUPS: { key: FieldDef["groupName"]; label: string }[] = [
  { key: "department", label: "Department (Bộ phận)" },
  { key: "dw_data", label: "DW Data (Kho lao động)" },
  { key: "daily_application", label: "Daily Application (Đăng ký hằng ngày)" },
];

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} title={label}>
      <Badge tone={on ? "green" : "gray"}>{label}</Badge>
    </button>
  );
}

export default function FieldDefinitionsPage() {
  const [rows, setRows] = useState<FieldDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<FieldDef["groupName"]>("daily_application");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    fieldKey: "",
    displayName: "",
    importColumnName: "",
    exportColumnName: "",
    aliasesRaw: "",
    sortOrder: 100,
  });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/field-definitions");
    const data = await res.json();
    setRows(data.rows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleRows = useMemo(
    () => rows.filter((r) => r.groupName === group).sort((a, b) => a.sortOrder - b.sortOrder),
    [rows, group],
  );

  const patch = async (id: string, body: Partial<FieldDef>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...body } : r)));
    const res = await fetch("/api/admin/field-definitions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    if (!res.ok) {
      toast({ title: "Lưu thất bại", variant: "destructive" });
      await load();
    }
  };

  const saveAliases = async (row: FieldDef, raw: string) => {
    const aliases = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await patch(row.id, { aliases });
  };

  const create = async () => {
    const res = await fetch("/api/admin/field-definitions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        groupName: group,
        aliases: form.aliasesRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast({ title: data.error ?? "Lỗi tạo trường", variant: "destructive" });
      return;
    }
    toast({ title: "✅ Đã thêm trường dữ liệu mới" });
    setOpen(false);
    setForm({ fieldKey: "", displayName: "", importColumnName: "", exportColumnName: "", aliasesRaw: "", sortOrder: 100 });
    await load();
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/admin/field-definitions?id=${id}`, { method: "DELETE" });
    const d = await res.json();
    if (!res.ok) {
      toast({ title: d.error, variant: "destructive" });
      return;
    }
    toast({ title: "Đã xoá trường" });
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-hasfarm-900">Quản lý trường dữ liệu (Metadata Engine)</h1>
          <p className="text-sm text-gray-500">
            Đổi tên cột, thêm alias nhận diện khi Import, bật/tắt Export/Tìm kiếm/Lọc — không cần sửa code.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/admin/field-definitions/template?group=${group}`}
            className="inline-flex h-10 items-center gap-2 rounded-full border-2 border-hasfarm-700 px-4 text-sm font-bold text-hasfarm-700 hover:bg-hasfarm-50"
          >
            <Download className="h-4 w-4" /> Tải file mẫu
          </a>
          <Button variant="gold" onClick={() => setOpen(true)}>
            + Thêm trường tuỳ chỉnh
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {GROUPS.map((g) => (
          <button
            key={g.key}
            onClick={() => setGroup(g.key)}
            className={`rounded-full px-4 py-2 text-sm font-bold transition ${
              group === g.key ? "bg-hasfarm-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>

      <Card className="p-0">
        <CardHeader title="Danh sách trường" subtitle="Bấm vào nhãn để bật/tắt. Sửa alias/tên trực tiếp trong ô." />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
            </div>
          ) : (
            <ul className="divide-y">
              {visibleRows.length === 0 && (
                <li className="p-8 text-center text-sm text-gray-400">Chưa có trường nào trong nhóm này.</li>
              )}
              {visibleRows.map((f) => (
                <li key={f.id} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-[200px] flex-1">
                      <input
                        defaultValue={f.displayName}
                        onBlur={(e) => e.target.value !== f.displayName && patch(f.id, { displayName: e.target.value })}
                        className="w-full rounded border-2 border-gray-200 px-2 py-1 text-sm font-bold text-hasfarm-900"
                      />
                      <p className="mt-0.5 text-xs text-gray-400">
                        <span className="font-mono">{f.fieldKey}</span> · cột DB: <span className="font-mono">{f.databaseField}</span>
                        {f.isSystem && " · Trường lõi"}
                      </p>
                    </div>
                    <Toggle on={f.exportable} onClick={() => patch(f.id, { exportable: !f.exportable })} label="Export" />
                    <Toggle on={f.importable} onClick={() => patch(f.id, { importable: !f.importable })} label="Import" />
                    <Toggle on={f.searchable} onClick={() => patch(f.id, { searchable: !f.searchable })} label="Tìm kiếm" />
                    <Toggle on={f.filterable} onClick={() => patch(f.id, { filterable: !f.filterable })} label="Lọc" />
                    <Toggle on={f.visible} onClick={() => patch(f.id, { visible: !f.visible })} label="Hiển thị" />
                    <Toggle on={f.required} onClick={() => patch(f.id, { required: !f.required })} label="Bắt buộc" />
                    <input
                      type="number"
                      defaultValue={f.sortOrder}
                      title="Thứ tự"
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v !== f.sortOrder) void patch(f.id, { sortOrder: v });
                      }}
                      className="w-16 rounded border-2 border-gray-200 px-2 py-1 text-sm"
                    />
                    {!f.isSystem && (
                      <button onClick={() => void remove(f.id)} className="text-xs font-bold text-red-600 hover:underline">
                        Xoá
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <div>
                      <Label className="mb-0.5 text-[10px]">Tên cột khi Import</Label>
                      <input
                        defaultValue={f.importColumnName ?? ""}
                        onBlur={(e) => e.target.value !== f.importColumnName && patch(f.id, { importColumnName: e.target.value })}
                        className="w-full rounded border-2 border-gray-200 px-2 py-1 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="mb-0.5 text-[10px]">Tên cột khi Export</Label>
                      <input
                        defaultValue={f.exportColumnName ?? ""}
                        onBlur={(e) => e.target.value !== f.exportColumnName && patch(f.id, { exportColumnName: e.target.value })}
                        className="w-full rounded border-2 border-gray-200 px-2 py-1 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="mb-0.5 text-[10px]">Alias khác (cách nhau bằng dấu phẩy)</Label>
                      <input
                        defaultValue={(f.aliases ?? []).join(", ")}
                        onBlur={(e) => saveAliases(f, e.target.value)}
                        placeholder="vd: Phone, Mobile, SĐT"
                        className="w-full rounded border-2 border-gray-200 px-2 py-1 text-xs"
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Thêm trường dữ liệu tuỳ chỉnh">
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            Nhóm: <span className="font-bold">{GROUPS.find((g) => g.key === group)?.label}</span>
          </p>
          <div>
            <Label>Mã trường (field key) *</Label>
            <Input
              value={form.fieldKey}
              onChange={(e) => setForm({ ...form, fieldKey: e.target.value })}
              placeholder="vd: ma_so_thue"
              className="h-11 font-mono"
            />
          </div>
          <div>
            <Label>Tên hiển thị *</Label>
            <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className="h-11" />
          </div>
          <div>
            <Label>Tên cột khi Import (bỏ trống = dùng tên hiển thị)</Label>
            <Input value={form.importColumnName} onChange={(e) => setForm({ ...form, importColumnName: e.target.value })} className="h-11" />
          </div>
          <div>
            <Label>Tên cột khi Export (bỏ trống = dùng tên hiển thị)</Label>
            <Input value={form.exportColumnName} onChange={(e) => setForm({ ...form, exportColumnName: e.target.value })} className="h-11" />
          </div>
          <div>
            <Label>Alias khác (cách nhau bằng dấu phẩy)</Label>
            <Input value={form.aliasesRaw} onChange={(e) => setForm({ ...form, aliasesRaw: e.target.value })} className="h-11" placeholder="vd: Tax Code, MST" />
          </div>
          <div className="flex items-center gap-2">
            <Label className="mb-0">Thứ tự</Label>
            <Input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} className="h-10 w-24" />
          </div>
          <p className="text-[11px] text-gray-400">
            Lưu ý: trường tuỳ chỉnh này chỉ mô tả metadata cho Import/Export nhận diện cột — không tự tạo cột mới trong
            database. Nếu cần lưu dữ liệu thật cho trường này ở Daily Application, hãy dùng{" "}
            <a href="/admin/form-builder" className="underline">
              Câu hỏi động
            </a>{" "}
            thay vì tạo ở đây.
          </p>
          <Button variant="gold" size="lg" className="w-full" onClick={create}>
            Lưu trường
          </Button>
        </div>
      </Modal>
    </div>
  );
}
