"use client";

/* ============================================================
   COLUMN CHOOSER — Cấu hình cột bảng Planning (Yêu cầu #2, #12)
   ------------------------------------------------------------
   KHÔNG hardcode danh sách cột: toàn bộ danh sách đến từ
   /api/planning/column-config (catalog + bản ghi DB).

   - Mọi vai trò đều bật/tắt/sắp xếp được cho PHIÊN LÀM VIỆC hiện tại.
   - Chỉ Admin có quyền `planning.columns.manage` mới LƯU được cấu
     hình vào DB (planning_column_configs) cho cả vai trò, áp dụng
     cho mọi máy — không phải localStorage.
   - Cấu hình tách riêng desktop / mobile.
   ============================================================ */

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Pin, PinOff, RotateCcw, Save } from "lucide-react";
import { Badge, Button, Modal, toast } from "@/components/ui";
import type { ResolvedColumn } from "@/lib/recruitment-request-columns";

export type DeviceKind = "desktop" | "mobile";

const SOURCE_TONE: Record<string, "gray" | "blue" | "amber"> = {
  INPUT: "gray",
  SYSTEM: "blue",
  DERIVED: "amber",
};

const SOURCE_LABEL: Record<string, string> = {
  INPUT: "Nhập tay / Excel",
  SYSTEM: "Hệ thống tính",
  DERIVED: "Công thức",
};

export function ColumnChooser({
  open,
  onClose,
  columns,
  role,
  device,
  canManage,
  onApply,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Cột đã resolve từ API, theo đúng thứ tự hiện tại. */
  columns: ResolvedColumn[];
  role: string;
  device: DeviceKind;
  /** true khi người dùng có quyền planning.columns.manage. */
  canManage: boolean;
  /** Áp dụng cho phiên hiện tại (không ghi DB). */
  onApply: (next: ResolvedColumn[]) => void;
  /** Gọi sau khi lưu/khôi phục thành công để tải lại cấu hình từ server. */
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ResolvedColumn[]>(columns);
  const [saving, setSaving] = useState(false);
  const [dirtyKey, setDirtyKey] = useState(0);

  // Đồng bộ lại nháp mỗi khi mở modal với danh sách cột mới.
  const signature = useMemo(() => columns.map((c) => `${c.key}:${c.visible}:${c.sticky}`).join("|"), [columns]);
  const [lastSignature, setLastSignature] = useState(signature);
  if (signature !== lastSignature) {
    setLastSignature(signature);
    setDraft(columns);
  }

  const visibleCount = draft.filter((c) => c.visible).length;

  const move = (index: number, delta: number) => {
    const next = [...draft];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
    setDirtyKey((k) => k + 1);
  };

  const toggle = (index: number, field: "visible" | "sticky") => {
    const next = [...draft];
    next[index] = { ...next[index], [field]: !next[index][field] };
    if (field === "sticky" && next[index].sticky && !next[index].stickyCapable) {
      next[index] = { ...next[index], sticky: false };
      toast({ title: `Cột "${next[index].labelVi}" không hỗ trợ ghim.`, variant: "destructive" });
    }
    setDraft(next);
    setDirtyKey((k) => k + 1);
  };

  const apply = () => {
    if (visibleCount === 0) {
      toast({ title: "Phải hiển thị ít nhất một cột.", variant: "destructive" });
      return;
    }
    onApply(draft.map((c, i) => ({ ...c, sortOrder: i })));
    onClose();
  };

  const persist = async () => {
    if (visibleCount === 0) {
      toast({ title: "Phải hiển thị ít nhất một cột.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/planning/column-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          device,
          columns: draft.map((c, i) => ({
            columnKey: c.key,
            visible: c.visible,
            sticky: c.sticky,
            sortOrder: i,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Không lưu được cấu hình cột.", variant: "destructive" });
        return;
      }
      toast({ title: `Đã lưu cấu hình cột cho vai trò ${role} (${device}).` });
      onSaved();
      onClose();
    } catch {
      toast({ title: "Lỗi kết nối khi lưu cấu hình cột.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/planning/column-config?role=${encodeURIComponent(role)}&device=${device}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Không khôi phục được mặc định.", variant: "destructive" });
        return;
      }
      toast({ title: `Đã khôi phục cấu hình mặc định của vai trò ${role}.` });
      onSaved();
      onClose();
    } catch {
      toast({ title: "Lỗi kết nối.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cấu hình cột hiển thị"
      description={`Vai trò ${role} · ${device === "mobile" ? "Điện thoại" : "Máy tính"} · ${visibleCount}/${draft.length} cột đang bật`}
      width="max-w-3xl"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-fg-muted">
            {canManage
              ? "Lưu cấu hình sẽ áp dụng cho MỌI người dùng thuộc vai trò này, trên mọi thiết bị."
              : "Bạn chỉ có thể đổi cách hiển thị cho phiên làm việc này. Admin mới lưu được cấu hình chung."}
          </div>
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <Button variant="ghost" size="sm" onClick={resetToDefault} loading={saving}>
                <RotateCcw className="h-3.5 w-3.5" /> Khôi phục mặc định
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={apply}>
              Áp dụng cho phiên này
            </Button>
            {canManage && (
              <Button variant="primary" size="sm" onClick={persist} loading={saving}>
                <Save className="h-3.5 w-3.5" /> Lưu cho vai trò {role}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div key={dirtyKey} className="max-h-[55vh] overflow-y-auto rounded-[10px] border border-border">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-primary-tint">
            <tr>
              <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-primary">Cột</th>
              <th className="px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-primary">Nguồn dữ liệu</th>
              <th className="w-20 px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wider text-primary">Hiện</th>
              <th className="w-20 px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wider text-primary">Ghim</th>
              <th className="w-24 px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wider text-primary">Thứ tự</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {draft.map((col, index) => (
              <tr key={col.key} className={col.visible ? "bg-surface" : "bg-surface-hover/50"}>
                <td className="px-3 py-2">
                  <div className="font-medium text-fg">{col.labelVi}</div>
                  <div className="text-[10.5px] text-fg-muted">{col.label}</div>
                </td>
                <td className="px-2 py-2">
                  <Badge tone={SOURCE_TONE[col.source] ?? "gray"}>{SOURCE_LABEL[col.source] ?? col.source}</Badge>
                </td>
                <td className="px-2 py-2 text-center">
                  <button
                    type="button"
                    onClick={() => toggle(index, "visible")}
                    aria-label={col.visible ? `Ẩn cột ${col.labelVi}` : `Hiện cột ${col.labelVi}`}
                    className="mx-auto text-fg-muted transition-colors hover:text-primary"
                  >
                    {col.visible ? <Eye className="h-4 w-4 text-primary" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                </td>
                <td className="px-2 py-2 text-center">
                  {col.stickyCapable ? (
                    <button
                      type="button"
                      onClick={() => toggle(index, "sticky")}
                      aria-label={col.sticky ? `Bỏ ghim ${col.labelVi}` : `Ghim ${col.labelVi}`}
                      className="mx-auto text-fg-muted transition-colors hover:text-primary"
                    >
                      {col.sticky ? <Pin className="h-4 w-4 text-accent" /> : <PinOff className="h-4 w-4" />}
                    </button>
                  ) : (
                    <span className="text-[10.5px] text-fg-muted">—</span>
                  )}
                </td>
                <td className="px-2 py-2">
                  <div className="flex justify-center gap-1">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Đưa ${col.labelVi} lên trên`}
                      className="rounded border border-border px-1 py-0.5 text-fg-muted disabled:opacity-30 hover:text-primary"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === draft.length - 1}
                      aria-label={`Đưa ${col.labelVi} xuống dưới`}
                      className="rounded border border-border px-1 py-0.5 text-fg-muted disabled:opacity-30 hover:text-primary"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
