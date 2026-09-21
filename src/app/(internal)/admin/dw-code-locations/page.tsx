"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, EmptyState, FormField, Input, Modal, toast } from "@/components/ui";
import { Loader2, MapPin, Pencil, Plus } from "lucide-react";

type OrgUnit = { id: string; name: string; unitType: string; isActive: boolean };

type LocationRow = {
  id: string;
  organizationUnitId: string;
  organizationUnitName: string | null;
  name: string;
  prefix: string;
  sequenceDigits: number;
  separator: string;
  suffix: string;
  startNumber: number;
  nextSequence: number;
  isActive: boolean;
  preview: string;
  pool: { available: number; assigned: number; retired: number };
};

const emptyForm = { organizationUnitId: "", name: "", prefix: "", sequenceDigits: 5, separator: "-", suffix: "D", startNumber: 1 };

/**
 * MISSION E section 4-7, 48, 52 — cấu hình namespace Mã số công nhật nội bộ
 * theo địa điểm (Organization Unit loại LOCATION). Prefix/số chữ số/
 * separator/suffix/số bắt đầu do Admin cấu hình — KHÔNG hard-code trong mã
 * nguồn, KHÔNG cho nhập script/biểu thức tuỳ ý (chỉ chữ/số cố định).
 */
export default function DwCodeLocationsPage() {
  const [rows, setRows] = useState<LocationRow[]>([]);
  const [orgUnits, setOrgUnits] = useState<OrgUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  // Edit modal state
  const [editingRow, setEditingRow] = useState<LocationRow | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    isActive: true,
    prefix: "",
    sequenceDigits: 5,
    separator: "-",
    suffix: "D",
    startNumber: 1,
  });
  const [editSubmitting, setEditSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [locRes, orgRes] = await Promise.all([
        fetch("/api/administration/dw-code-locations"),
        fetch("/api/organization-units"),
      ]);
      if (locRes.ok) setRows((await locRes.json()).rows ?? []);
      if (orgRes.ok) {
        const data = await orgRes.json();
        setOrgUnits((data.units ?? []).filter((u: OrgUnit) => u.unitType === "LOCATION" && u.isActive));
      }
    } catch {
      toast({ title: "Lỗi kết nối", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const preview = `${form.prefix.toUpperCase()}${String(form.startNumber).padStart(form.sequenceDigits, "0")}${form.separator}${form.suffix.toUpperCase()}`;

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/administration/dw-code-locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Thất bại", variant: "destructive" });
        return;
      }
      toast({ title: "Đã tạo cấu hình địa điểm." });
      setModalOpen(false);
      setForm(emptyForm);
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = async (row: LocationRow) => {
    setEditingRow(row);
    setEditLoading(true);
    try {
      const res = await fetch(`/api/administration/dw-code-locations/${row.id}`);
      if (res.ok) {
        const data = await res.json();
        const loc: LocationRow = data.location;
        setEditingRow(loc);
        setEditForm({
          name: loc.name,
          isActive: loc.isActive,
          prefix: loc.prefix,
          sequenceDigits: loc.sequenceDigits,
          separator: loc.separator,
          suffix: loc.suffix,
          startNumber: loc.startNumber,
        });
      } else {
        toast({ title: "Không thể tải thông tin địa điểm", variant: "destructive" });
        setEditingRow(null);
      }
    } catch {
      toast({ title: "Lỗi kết nối khi tải địa điểm", variant: "destructive" });
      setEditingRow(null);
    } finally {
      setEditLoading(false);
    }
  };

  const submitEdit = async () => {
    if (!editingRow) return;
    setEditSubmitting(true);
    try {
      const hasIssuedCodes = editingRow.pool.available + editingRow.pool.assigned + editingRow.pool.retired > 0;
      const body = hasIssuedCodes
        ? { name: editForm.name, isActive: editForm.isActive }
        : editForm;

      const res = await fetch(`/api/administration/dw-code-locations/${editingRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Thất bại khi cập nhật", variant: "destructive" });
        return;
      }
      toast({ title: "Đã cập nhật cấu hình địa điểm." });
      setEditingRow(null);
      await load();
    } catch {
      toast({ title: "Lỗi kết nối khi lưu", variant: "destructive" });
    } finally {
      setEditSubmitting(false);
    }
  };

  const toggleActive = async (row: LocationRow) => {
    const res = await fetch(`/api/administration/dw-code-locations/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !row.isActive }),
    });
    if (res.ok) {
      toast({ title: row.isActive ? "Đã tạm dừng địa điểm." : "Đã kích hoạt lại địa điểm." });
      await load();
    } else {
      toast({ title: "Thất bại", variant: "destructive" });
    }
  };

  const hasIssuedCodes = editingRow ? (editingRow.pool.available + editingRow.pool.assigned + editingRow.pool.retired > 0) : false;
  const editPreview = `${editForm.prefix.toUpperCase()}${String(editForm.startNumber).padStart(editForm.sequenceDigits, "0")}${editForm.separator}${editForm.suffix.toUpperCase()}`;

  return (
    <div className="space-y-5 pb-20">
      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge tone="purple">Cấu hình vận hành</Badge>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-fg">Mã số công nhật nội bộ — theo địa điểm</h1>
            <p className="text-xs text-fg-secondary">
              Mỗi địa điểm (Organization Unit loại LOCATION) có prefix/định dạng mã riêng — ví dụ DR00001-D, DL00001-D.
              Đổi cấu hình sau khi đã cấp mã KHÔNG viết lại các mã lịch sử đã tồn tại.
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={() => setModalOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" /> Thêm địa điểm
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <CardHeader title={`Địa điểm đã cấu hình (${rows.length})`} />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={<MapPin className="h-5 w-5" aria-hidden />} title="Chưa có địa điểm nào" description="Thêm địa điểm để bắt đầu cấp Mã số công nhật theo namespace riêng." />
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-sheet w-full text-[13px]">
                <thead className="bg-primary text-white">
                  <tr>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Địa điểm</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Định dạng</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Mã kế tiếp (dự kiến)</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Available</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Assigned</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Retired</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Trạng thái</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2.5 font-semibold text-fg">
                        {r.name}
                        <div className="text-[11px] font-normal text-fg-muted">{r.organizationUnitName ?? "—"}</div>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg-secondary">
                        {r.prefix}
                        {"0".repeat(r.sequenceDigits)}
                        {r.separator}
                        {r.suffix}
                      </td>
                      <td className="px-3 py-2.5 text-center font-mono">{r.preview}</td>
                      <td className="px-3 py-2.5 text-center">{r.pool.available}</td>
                      <td className="px-3 py-2.5 text-center">{r.pool.assigned}</td>
                      <td className="px-3 py-2.5 text-center">{r.pool.retired}</td>
                      <td className="px-3 py-2.5 text-center">
                        <button type="button" onClick={() => toggleActive(r)} className="cursor-pointer">
                          <Badge tone={r.isActive ? "green" : "gray"} dot>
                            {r.isActive ? "Đang hoạt động" : "Tạm dừng"}
                          </Badge>
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => openEdit(r)}
                          className="h-7 gap-1 px-2.5 text-xs"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Sửa
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Location Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Thêm địa điểm Mã số công nhật">
        <div className="space-y-4">
          <FormField label="Địa điểm (Organization Unit)" required>
            <select
              value={form.organizationUnitId}
              onChange={(e) => setForm((f) => ({ ...f, organizationUnitId: e.target.value }))}
              className="h-10 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-sm font-medium text-fg outline-none focus:border-primary"
            >
              <option value="">— Chọn địa điểm —</option>
              {orgUnits.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
            {orgUnits.length === 0 && (
              <p className="mt-1 text-[11px] text-warning">
                Chưa có Organization Unit loại LOCATION nào — tạo trước ở màn Cây tổ chức.
              </p>
            )}
          </FormField>
          <FormField label="Tên hiển thị" required>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="VD: Đông Rồng" />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Prefix" required>
              <Input value={form.prefix} onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value.toUpperCase() }))} placeholder="DR" maxLength={8} />
            </FormField>
            <FormField label="Số chữ số" required>
              <Input type="number" min={1} max={10} value={form.sequenceDigits} onChange={(e) => setForm((f) => ({ ...f, sequenceDigits: Number(e.target.value) }))} />
            </FormField>
            <FormField label="Separator">
              <Input value={form.separator} onChange={(e) => setForm((f) => ({ ...f, separator: e.target.value }))} maxLength={4} />
            </FormField>
            <FormField label="Suffix">
              <Input value={form.suffix} onChange={(e) => setForm((f) => ({ ...f, suffix: e.target.value.toUpperCase() }))} maxLength={8} />
            </FormField>
            <FormField label="Số bắt đầu" required>
              <Input type="number" min={0} value={form.startNumber} onChange={(e) => setForm((f) => ({ ...f, startNumber: Number(e.target.value) }))} />
            </FormField>
          </div>
          <div className="rounded-[8px] bg-primary-tint p-3 text-center font-mono text-sm font-semibold text-primary">{preview}</div>
          <Button variant="primary" size="lg" className="w-full" loading={submitting} disabled={!form.organizationUnitId || !form.name || !form.prefix} onClick={submit}>
            Tạo cấu hình
          </Button>
        </div>
      </Modal>

      {/* Edit Location Modal */}
      <Modal open={!!editingRow} onClose={() => setEditingRow(null)} title={editingRow ? `Sửa cấu hình địa điểm: ${editingRow.name}` : "Sửa địa điểm"}>
        {editLoading ? (
          <div className="p-10 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
            <p className="mt-2 text-xs text-fg-muted">Đang tải dữ liệu từ máy chủ...</p>
          </div>
        ) : editingRow ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-border bg-surface-subtle p-3 text-xs">
              <div>
                <span className="font-semibold text-fg">{editingRow.name}</span>
                <span className="ml-2 text-fg-muted">({editingRow.organizationUnitName ?? "—"})</span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[11px]">
                <span className="text-fg-secondary">Avail: <strong>{editingRow.pool.available}</strong></span>
                <span className="text-fg-secondary">Assign: <strong>{editingRow.pool.assigned}</strong></span>
                <span className="text-fg-secondary">Retire: <strong>{editingRow.pool.retired}</strong></span>
              </div>
            </div>

            {hasIssuedCodes ? (
              <div className="rounded-[8px] border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
                <p className="font-semibold">Định dạng mã và số bắt đầu đã bị khóa</p>
                <p className="mt-0.5 text-[11px] opacity-90">
                  Địa điểm này đã phát hành {editingRow.pool.available + editingRow.pool.assigned + editingRow.pool.retired} mã trong hệ thống (Available: {editingRow.pool.available}, Assigned: {editingRow.pool.assigned}, Retired: {editingRow.pool.retired}). Không thể thay đổi định dạng sau khi đã cấp mã để bảo đảm tính toàn vẹn của dữ liệu lịch sử.
                </p>
              </div>
            ) : (
              <div className="rounded-[8px] border border-blue-300 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-700/50 dark:bg-blue-950/30 dark:text-blue-200">
                <p className="font-semibold">Địa điểm chưa phát hành mã</p>
                <p className="mt-0.5 text-[11px] opacity-90">
                  Địa điểm này chưa có mã nào trong pool. Bạn có thể chỉnh sửa định dạng và số bắt đầu an toàn trước khi cấp mã đầu tiên.
                </p>
              </div>
            )}

            <FormField label="Tên hiển thị" required>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="VD: Đạ Ròn"
              />
            </FormField>

            <FormField label="Trạng thái hoạt động">
              <select
                value={editForm.isActive ? "active" : "paused"}
                onChange={(e) => setEditForm((f) => ({ ...f, isActive: e.target.value === "active" }))}
                className="h-10 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-sm font-medium text-fg outline-none focus:border-primary"
              >
                <option value="active">Đang hoạt động</option>
                <option value="paused">Tạm dừng (không cấp mã mới)</option>
              </select>
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Prefix" required>
                <Input
                  value={editForm.prefix}
                  disabled={hasIssuedCodes}
                  onChange={(e) => setEditForm((f) => ({ ...f, prefix: e.target.value.toUpperCase() }))}
                  maxLength={8}
                />
              </FormField>
              <FormField label="Số chữ số" required>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={editForm.sequenceDigits}
                  disabled={hasIssuedCodes}
                  onChange={(e) => setEditForm((f) => ({ ...f, sequenceDigits: Number(e.target.value) }))}
                />
              </FormField>
              <FormField label="Separator">
                <Input
                  value={editForm.separator}
                  disabled={hasIssuedCodes}
                  onChange={(e) => setEditForm((f) => ({ ...f, separator: e.target.value }))}
                  maxLength={4}
                />
              </FormField>
              <FormField label="Suffix">
                <Input
                  value={editForm.suffix}
                  disabled={hasIssuedCodes}
                  onChange={(e) => setEditForm((f) => ({ ...f, suffix: e.target.value.toUpperCase() }))}
                  maxLength={8}
                />
              </FormField>
              <FormField label="Số bắt đầu" required>
                <Input
                  type="number"
                  min={0}
                  value={editForm.startNumber}
                  disabled={hasIssuedCodes}
                  onChange={(e) => setEditForm((f) => ({ ...f, startNumber: Number(e.target.value) }))}
                />
              </FormField>
              <div className="flex flex-col justify-end">
                <div className="rounded-[8px] bg-primary-tint p-2.5 text-center font-mono text-xs font-semibold text-primary">
                  <div className="text-[10px] font-normal uppercase opacity-75">Mã kế tiếp (dự kiến)</div>
                  {editingRow.preview}
                </div>
              </div>
            </div>

            {!hasIssuedCodes && (
              <div className="rounded-[8px] bg-primary-tint p-2.5 text-center font-mono text-xs font-semibold text-primary">
                <div className="text-[10px] font-normal uppercase opacity-75">Định dạng mới xem trước</div>
                {editPreview}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setEditingRow(null)}>
                Hủy
              </Button>
              <Button
                variant="primary"
                loading={editSubmitting}
                disabled={!editForm.name.trim()}
                onClick={submitEdit}
              >
                Lưu thay đổi
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

