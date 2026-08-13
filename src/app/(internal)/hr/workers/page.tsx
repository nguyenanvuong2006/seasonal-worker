"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Input, Label, Modal, toast } from "@/components/ui";
import { Loader2 } from "lucide-react";

type W = {
  id: string;
  code: string | null;
  itCode: string | null;
  oldDwCode: string | null;
  fullName: string;
  gender: string | null;
  bod: string | null;
  cccd: string | null;
  phone: string | null;
  profile: string | null;
  permanentAddress: string | null;
  residentialAddress: string | null;
  note: string | null;
  source: string | null;
  isActive: boolean;
};

export default function DwDataPage() {
  const [rows, setRows] = useState<W[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<W | null>(null);
  const [form, setForm] = useState<Partial<W>>({});
  const [oldCccd, setOldCccd] = useState("");
  const limit = 50;

  const load = useCallback(
    async (p = page, query = q) => {
      setLoading(true);
      const params = new URLSearchParams({ page: String(p), limit: String(limit) });
      if (query) params.set("q", query);
      const res = await fetch(`/api/workers?${params}`);
      if (!res.ok) {
        toast({ title: "Không có quyền truy cập DW Data", variant: "destructive" });
        setLoading(false);
        return;
      }
      const d = await res.json();
      setRows(d.rows ?? []);
      setTotal(d.total ?? 0);
      setLoading(false);
    },
    [page, q],
  );

  useEffect(() => {
    void load(1, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = async () => {
    setPage(1);
    await load(1, q);
  };

  const save = async () => {
    if (!form.fullName?.trim()) {
      toast({ title: "Thiếu họ tên", variant: "destructive" });
      return;
    }
    const res = await fetch("/api/workers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        oldCccd,
        cascadeCccd: form.cccd !== oldCccd,
      }),
    });
    const d = await res.json();
    if (!res.ok) {
      toast({ title: d.error ?? "Lưu thất bại", variant: "destructive" });
      return;
    }
    toast({
      title: form.cccd !== oldCccd ? "✅ Đã sửa CCCD & đồng bộ lịch sử đơn" : "✅ Đã cập nhật hồ sơ DW",
    });
    setEdit(null);
    await load(page, q);
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-5">
      <div className="rounded-[20px] bg-white p-6 shadow-sm ring-1 ring-black/5">
        <span className="rounded-full bg-primary px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white">
          DW Data — Nguồn đối chiếu Tập nghề
        </span>
        <h1 className="mt-3 text-[26px] font-black tracking-tight text-fg">
          DW Data — {total.toLocaleString("vi-VN")} hồ sơ đối chiếu lịch sử
        </h1>
        <p className="mt-1 max-w-[85ch] text-sm text-fg-secondary">
          Đây là nguồn dữ liệu lịch sử công ty dùng để đối chiếu <b>người cũ / người mới</b>. Ai không có trong kho dữ liệu này được xác định là người tập nghề MỚI.
          Nếu ứng viên nhập sai CCCD, sửa CCCD tại đây — hệ thống tự đồng bộ toàn bộ đơn đăng ký sang CCCD đúng.
        </p>
      </div>

      <Card className="rounded-[18px] p-3">
        <div className="flex flex-wrap gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="🔎 Tìm theo CCCD / Họ tên / SĐT / Mã CODE (VD: DR0001-D)"
            className="h-11 flex-1 rounded-xl"
          />
          <Button onClick={search} className="h-11 rounded-xl bg-primary text-white">
            Tìm kiếm
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden rounded-[18px] border border-black/5 p-0 shadow-sm">
        <div className="flex items-center justify-between border-b bg-primary-tint px-4 py-3">
          <p className="text-[11px] font-black uppercase tracking-widest text-primary">
            Trang {page}/{totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={page <= 1}
              onClick={() => {
                const p = page - 1;
                setPage(p);
                void load(p, q);
              }}
            >
              ← Trước
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={page >= totalPages}
              onClick={() => {
                const p = page + 1;
                setPage(p);
                void load(p, q);
              }}
            >
              Sau →
            </Button>
          </div>
        </div>
        <div className="max-h-[62vh] overflow-auto">
          <table className="grid-sheet w-full text-[13px]">
            <thead className="sticky top-0 bg-[#0F3D23] text-white">
              <tr>
                {["CODE", "CCCD (ID No)", "Họ và tên", "Giới tính", "Ngày sinh", "SĐT", "Địa chỉ", ""].map(
                  (h) => (
                    <th key={h} className="px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-widest">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={10} className="p-12 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="p-10 text-center text-fg-muted">
                    Không tìm thấy hồ sơ nào.
                  </td>
                </tr>
              )}
              {!loading &&
                rows.map((r) => (
                  <tr key={r.id} className="hover:bg-primary-tint">
                    <td className="px-3 py-2 font-mono text-[11px] font-bold text-primary">{r.code ?? "—"}</td>
                    <td className="px-3 py-2 font-mono font-bold">{r.cccd ?? <span className="text-red-400">thiếu</span>}</td>
                    <td className="px-3 py-2 font-bold text-fg">{r.fullName}</td>
                    <td className="px-3 py-2 text-center">{r.gender ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">{r.bod ?? "—"}</td>
                    <td className="px-3 py-2">{r.phone ?? "—"}</td>
                    <td className="max-w-[240px] truncate px-3 py-2 text-fg-secondary">
                      {r.residentialAddress ?? r.permanentAddress ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => {
                          setEdit(r);
                          setForm({ ...r });
                          setOldCccd(r.cccd ?? "");
                        }}
                        className="rounded-full bg-primary-tint px-3 py-1 text-[11px] font-bold text-primary hover:bg-primary/15"
                      >
                        Sửa
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Sửa hồ sơ DW: ${edit?.fullName ?? ""}`} width="max-w-xl">
        {edit && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
              Sửa <b>CCCD</b> ở đây sẽ đồng bộ toàn bộ đơn đăng ký từ CCCD cũ sang CCCD mới — dùng khi người mới
              nhập sai CCCD nên bị nhận diện nhầm.
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label>CCCD / ID No</Label>
                <Input
                  value={form.cccd ?? ""}
                  onChange={(e) => setForm({ ...form, cccd: e.target.value.replace(/\D/g, "") })}
                  className="h-11 rounded-xl font-mono font-bold"
                />
                {form.cccd !== oldCccd && (
                  <p className="mt-1 text-[11px] font-bold text-amber-700">
                    Đồng bộ {oldCccd || "(trống)"} → {form.cccd}
                  </p>
                )}
              </div>
              <div>
                <Label>Mã CODE</Label>
                <Input
                  value={form.code ?? ""}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  className="h-11 rounded-xl font-mono"
                />
              </div>
              <div>
                <Label>Họ và tên *</Label>
                <Input
                  value={form.fullName ?? ""}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  className="h-11 rounded-xl font-bold"
                />
              </div>
              <div>
                <Label>Ngày sinh</Label>
                <Input
                  value={form.bod ?? ""}
                  onChange={(e) => setForm({ ...form, bod: e.target.value })}
                  placeholder="dd/mm/yyyy"
                  className="h-11 rounded-xl"
                />
              </div>
              <div>
                <Label>Giới tính</Label>
                <Input
                  value={form.gender ?? ""}
                  onChange={(e) => setForm({ ...form, gender: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
              <div>
                <Label>SĐT</Label>
                <Input
                  value={form.phone ?? ""}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
            </div>
            <div>
              <Label>Địa chỉ hiện tại</Label>
              <Input
                value={form.residentialAddress ?? ""}
                onChange={(e) => setForm({ ...form, residentialAddress: e.target.value })}
                className="h-11 rounded-xl"
              />
            </div>
            <div>
              <Label>Ghi chú</Label>
              <Input
                value={form.note ?? ""}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                className="h-11 rounded-xl"
              />
            </div>
            <Button variant="gold" size="lg" className="w-full rounded-xl" onClick={save}>
              Lưu thay đổi
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
