"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, toast } from "@/components/ui";
import { Loader2 } from "lucide-react";

type Row = {
  id: string;
  event: string;
  recipientType: string;
  recipientRef: string;
  channel: string;
  templateKey: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
};

export default function NotificationsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/notifications");
    const data = await res.json();
    setRows(data.rows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const processQueue = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/notifications", { method: "POST" });
      const d = await res.json();
      toast({ title: `Đã xử lý: ${d.sent} gửi, ${d.skipped} chờ (chưa có kênh gửi thật)` });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-fg">Hàng đợi thông báo (Notification Foundation)</h1>
          <p className="text-sm text-fg-secondary">
            Kênh <b>IN_APP</b> hoạt động thật. Kênh ZALO/SMS/EMAIL hiện chỉ xếp hàng đợi (chưa có tài khoản dịch vụ
            ngoài để gửi thật) — khi có, chỉ cần bổ sung 1 “sender” trong <code>src/lib/notifications.ts</code>.
          </p>
        </div>
        <Button variant="gold" onClick={processQueue} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Xử lý hàng đợi ngay"}
        </Button>
      </div>

      <Card className="p-0">
        <CardHeader title={`${rows.length} thông báo gần nhất`} />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-sheet w-full text-sm">
                <thead className="bg-primary-tint text-primary">
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Sự kiện</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Người nhận</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Kênh</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Trạng thái</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Thời gian</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-10 text-center text-fg-muted">
                        Chưa có thông báo nào trong hàng đợi.
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-primary-tint/50">
                      <td className="px-3 py-2 font-mono text-xs">{r.event}</td>
                      <td className="px-3 py-2 text-xs">
                        {r.recipientType} · {r.recipientRef}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.channel}</td>
                      <td className="px-3 py-2">
                        <Badge tone={r.status === "SENT" ? "green" : r.status === "FAILED" ? "red" : "amber"}>{r.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-fg-secondary">{new Date(r.createdAt).toLocaleString("vi-VN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
