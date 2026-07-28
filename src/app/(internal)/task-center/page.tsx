"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Card, CardContent, CardHeader, Input } from "@/components/ui";
import { Loader2, UserPlus, LogOut, Repeat, CalendarClock } from "lucide-react";

type TaskData = {
  newApplicants: { id: string; fullName: string; cccd: string; submittedAt: string }[];
  resignations: { id: string; workerName: string | null; workerCccd: string | null; effectiveDate: string; requestedBy: string; createdAt: string }[];
  transfers: { id: string; workerName: string | null; workerCccd: string | null; status: string; effectiveDate: string; requestedBy: string; createdAt: string }[];
  expiringPlans: { id: string; deptName: string | null; section: string | null; endDate: string; targetCount: number | null }[];
  generatedAt: string;
};

function ageDays(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
function priorityBadge(days: number) {
  if (days >= 3) return <Badge tone="red">Ưu tiên cao — {days} ngày</Badge>;
  if (days >= 1) return <Badge tone="amber">{days} ngày</Badge>;
  return <Badge tone="green">Mới</Badge>;
}

export default function TaskCenterPage() {
  const [data, setData] = useState<TaskData | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/task-center");
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const match = (name: string | null, cccd: string | null) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return (name ?? "").toLowerCase().includes(s) || (cccd ?? "").includes(s);
  };

  const filtered = useMemo(() => {
    if (!data) return null;
    return {
      newApplicants: data.newApplicants.filter((r) => match(r.fullName, r.cccd)),
      resignations: data.resignations.filter((r) => match(r.workerName, r.workerCccd)),
      transfers: data.transfers.filter((r) => match(r.workerName, r.workerCccd)),
      expiringPlans: data.expiringPlans.filter((r) => match(r.deptName, null)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, q]);

  const totalTasks = filtered ? filtered.newApplicants.length + filtered.resignations.length + filtered.transfers.length + filtered.expiringPlans.length : 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-hasfarm-900">Task Center</h1>
        <p className="text-sm text-gray-500">Toàn bộ việc cần xử lý — không cần mở từng màn hình riêng.</p>
      </div>

      <Input placeholder="Tìm theo tên hoặc CCCD trong tất cả các việc bên dưới..." value={q} onChange={(e) => setQ(e.target.value)} className="h-12" />

      {loading || !filtered ? (
        <div className="p-10 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
        </div>
      ) : totalTasks === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-gray-400">Không có việc nào cần xử lý.</CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <UserPlus className="h-4 w-4" /> Người mới chờ duyệt ({filtered.newApplicants.length})
                </span>
              }
            />
            <CardContent className="space-y-2">
              {filtered.newApplicants.length === 0 && <p className="text-sm text-gray-400">Không có.</p>}
              {filtered.newApplicants.map((r) => (
                <a key={r.id} href="/hr/registrations" className="flex items-center justify-between rounded-xl bg-gray-50 p-3 text-sm hover:bg-hasfarm-50">
                  <span>
                    <b>{r.fullName}</b> <span className="text-xs text-gray-400">({r.cccd})</span>
                  </span>
                  {priorityBadge(ageDays(r.submittedAt))}
                </a>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <LogOut className="h-4 w-4" /> Nghỉ việc chờ duyệt ({filtered.resignations.length})
                </span>
              }
            />
            <CardContent className="space-y-2">
              {filtered.resignations.length === 0 && <p className="text-sm text-gray-400">Không có.</p>}
              {filtered.resignations.map((r) => (
                <a key={r.id} href="/admin/workforce-movements" className="flex items-center justify-between rounded-xl bg-gray-50 p-3 text-sm hover:bg-hasfarm-50">
                  <span>
                    <b>{r.workerName}</b> <span className="text-xs text-gray-400">({r.workerCccd})</span> · hiệu lực {r.effectiveDate}
                  </span>
                  {priorityBadge(ageDays(r.createdAt))}
                </a>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <Repeat className="h-4 w-4" /> Thuyên chuyển chờ xử lý ({filtered.transfers.length})
                </span>
              }
            />
            <CardContent className="space-y-2">
              {filtered.transfers.length === 0 && <p className="text-sm text-gray-400">Không có.</p>}
              {filtered.transfers.map((r) => (
                <a key={r.id} href="/admin/workforce-movements" className="flex items-center justify-between rounded-xl bg-gray-50 p-3 text-sm hover:bg-hasfarm-50">
                  <span>
                    <b>{r.workerName}</b> <span className="text-xs text-gray-400">({r.workerCccd})</span> ·{" "}
                    {r.status === "WAITING_DECISION" ? "Không đến — chờ quyết định" : "Chờ xác nhận"}
                  </span>
                  {priorityBadge(ageDays(r.createdAt))}
                </a>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4" /> Planning sắp hết hạn ({filtered.expiringPlans.length})
                </span>
              }
            />
            <CardContent className="space-y-2">
              {filtered.expiringPlans.length === 0 && <p className="text-sm text-gray-400">Không có.</p>}
              {filtered.expiringPlans.map((r) => (
                <a key={r.id} href="/admin/planning" className="flex items-center justify-between rounded-xl bg-gray-50 p-3 text-sm hover:bg-hasfarm-50">
                  <span>
                    <b>
                      {r.deptName}
                      {r.section ? ` — ${r.section}` : ""}
                    </b>{" "}
                    · nhu cầu {r.targetCount ?? 0}
                  </span>
                  <Badge tone="amber">Hết hạn {r.endDate}</Badge>
                </a>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
