"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, Input, Button } from "@/components/ui";
import { Loader2, UserPlus, LogOut, Repeat, CalendarClock, TriangleAlert, RotateCcw } from "lucide-react";

type Section<T> = { rows: T[]; total: number };
type TaskData = {
  newApplicants: Section<{ id: string; fullName: string; cccd: string; submittedAt: string }>;
  resignations: Section<{ id: string; workerName: string | null; workerCccd: string | null; effectiveDate: string; requestedBy: string; createdAt: string }>;
  transfers: Section<{ id: string; workerName: string | null; workerCccd: string | null; status: string; effectiveDate: string; requestedBy: string; createdAt: string }>;
  expiringPlans: Section<{ id: string; deptName: string | null; section: string | null; endDate: string; targetCount: number | null }>;
  hiddenSections: string[];
  generatedAt: string;
};

type LoadState = "loading" | "success" | "empty" | "error" | "forbidden";

function ageDays(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
function priorityBadge(days: number) {
  if (days >= 3) return <Badge tone="red">Ưu tiên cao — {days} ngày</Badge>;
  if (days >= 1) return <Badge tone="amber">{days} ngày</Badge>;
  return <Badge tone="green">Mới</Badge>;
}

export default function TaskCenterPage() {
  const router = useRouter();
  const [data, setData] = useState<TaskData | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [q, setQ] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Phase 3.4 (Production Hardening Audit) — tìm kiếm server-side (query `q`) thay vì fetch
  // 50 dòng đầu rồi lọc ở trình duyệt (trước đây báo "không có" sai nếu record nằm ngoài 50
  // dòng đầu). Debounce 350ms để không gọi API mỗi lần gõ phím.
  const load = useCallback(async (query: string) => {
    setState("loading");
    setErrorMsg("");
    try {
      const res = await fetch(`/api/task-center${query ? `?q=${encodeURIComponent(query)}` : ""}`);
      if (res.status === 401) {
        setState("forbidden");
        setErrorMsg("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
        return;
      }
      if (res.status === 403) {
        setState("forbidden");
        setErrorMsg("Tài khoản của bạn không có quyền xem Task Center.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState("error");
        setErrorMsg(body.error ?? `Lỗi máy chủ (mã ${res.status}).`);
        return;
      }
      const json = (await res.json()) as TaskData;
      setData(json);
      const total = json.newApplicants.total + json.resignations.total + json.transfers.total + json.expiringPlans.total;
      setState(total === 0 ? "empty" : "success");
    } catch {
      // Phase 3.3 — KHÔNG nuốt lỗi im lặng: mất kết nối/lỗi mạng cũng phải hiện rõ + nút thử lại,
      // thay vì để spinner quay vô hạn.
      setState("error");
      setErrorMsg("Không kết nối được máy chủ. Kiểm tra mạng và thử lại.");
    }
  }, []);

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSearchChange = (value: string) => {
    setQ(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(value), 350);
  };

  const retry = () => void load(q);

  if (state === "forbidden") {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-black text-hasfarm-900">Task Center</h1>
        <Card>
          <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
            <TriangleAlert className="h-8 w-8 text-amber-500" />
            <p className="text-sm text-gray-600">{errorMsg}</p>
            {errorMsg.includes("đăng nhập") ? (
              <Button onClick={() => router.push("/login")}>Đăng nhập lại</Button>
            ) : null}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-black text-hasfarm-900">Task Center</h1>
        <Card>
          <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
            <TriangleAlert className="h-8 w-8 text-red-500" />
            <p className="text-sm text-gray-600">{errorMsg}</p>
            <Button onClick={retry} variant="outline">
              <RotateCcw className="mr-2 h-4 w-4" /> Thử lại
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hidden = new Set(data?.hiddenSections ?? []);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-hasfarm-900">Task Center</h1>
        <p className="text-sm text-gray-500">Toàn bộ việc cần xử lý — không cần mở từng màn hình riêng.</p>
      </div>

      <Input placeholder="Tìm theo tên hoặc CCCD trong tất cả các việc bên dưới..." value={q} onChange={(e) => onSearchChange(e.target.value)} className="h-12" />

      {state === "loading" && !data ? (
        <div className="p-10 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
        </div>
      ) : state === "empty" ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-gray-400">
            {q ? `Không có việc nào khớp với "${q}".` : "Không có việc nào cần xử lý."}
          </CardContent>
        </Card>
      ) : data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {!hidden.has("newApplicants") && (
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <UserPlus className="h-4 w-4" /> Người mới chờ duyệt ({data.newApplicants.total})
                  </span>
                }
              />
              <CardContent className="space-y-2">
                {data.newApplicants.rows.length === 0 && <p className="text-sm text-gray-400">Không có.</p>}
                {data.newApplicants.rows.map((r) => (
                  <a key={r.id} href="/hr/registrations" className="flex items-center justify-between rounded-xl bg-gray-50 p-3 text-sm hover:bg-hasfarm-50">
                    <span>
                      <b>{r.fullName}</b> <span className="text-xs text-gray-400">({r.cccd})</span>
                    </span>
                    {priorityBadge(ageDays(r.submittedAt))}
                  </a>
                ))}
                {data.newApplicants.total > data.newApplicants.rows.length && (
                  <a href="/hr/registrations" className="block pt-1 text-center text-xs font-bold text-hasfarm-700 hover:underline">
                    Xem tất cả {data.newApplicants.total} hồ sơ →
                  </a>
                )}
              </CardContent>
            </Card>
          )}

          {!hidden.has("resignations") && (
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <LogOut className="h-4 w-4" /> Nghỉ việc chờ duyệt ({data.resignations.total})
                  </span>
                }
              />
              <CardContent className="space-y-2">
                {data.resignations.rows.length === 0 && <p className="text-sm text-gray-400">Không có.</p>}
                {data.resignations.rows.map((r) => (
                  <a key={r.id} href="/admin/workforce-movements" className="flex items-center justify-between rounded-xl bg-gray-50 p-3 text-sm hover:bg-hasfarm-50">
                    <span>
                      <b>{r.workerName}</b> <span className="text-xs text-gray-400">({r.workerCccd})</span> · hiệu lực {r.effectiveDate}
                    </span>
                    {priorityBadge(ageDays(r.createdAt))}
                  </a>
                ))}
                {data.resignations.total > data.resignations.rows.length && (
                  <a href="/admin/workforce-movements" className="block pt-1 text-center text-xs font-bold text-hasfarm-700 hover:underline">
                    Xem tất cả {data.resignations.total} yêu cầu →
                  </a>
                )}
              </CardContent>
            </Card>
          )}

          {!hidden.has("transfers") && (
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Repeat className="h-4 w-4" /> Thuyên chuyển chờ xử lý ({data.transfers.total})
                  </span>
                }
              />
              <CardContent className="space-y-2">
                {data.transfers.rows.length === 0 && <p className="text-sm text-gray-400">Không có.</p>}
                {data.transfers.rows.map((r) => (
                  <a key={r.id} href="/admin/workforce-movements" className="flex items-center justify-between rounded-xl bg-gray-50 p-3 text-sm hover:bg-hasfarm-50">
                    <span>
                      <b>{r.workerName}</b> <span className="text-xs text-gray-400">({r.workerCccd})</span> ·{" "}
                      {r.status === "WAITING_DECISION" ? "Không đến — chờ quyết định" : "Chờ xác nhận"}
                    </span>
                    {priorityBadge(ageDays(r.createdAt))}
                  </a>
                ))}
                {data.transfers.total > data.transfers.rows.length && (
                  <a href="/admin/workforce-movements" className="block pt-1 text-center text-xs font-bold text-hasfarm-700 hover:underline">
                    Xem tất cả {data.transfers.total} yêu cầu →
                  </a>
                )}
              </CardContent>
            </Card>
          )}

          {!hidden.has("expiringPlans") && (
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <CalendarClock className="h-4 w-4" /> Planning sắp hết hạn ({data.expiringPlans.total})
                  </span>
                }
              />
              <CardContent className="space-y-2">
                {data.expiringPlans.rows.length === 0 && <p className="text-sm text-gray-400">Không có.</p>}
                {data.expiringPlans.rows.map((r) => (
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
                {data.expiringPlans.total > data.expiringPlans.rows.length && (
                  <a href="/admin/planning" className="block pt-1 text-center text-xs font-bold text-hasfarm-700 hover:underline">
                    Xem tất cả {data.expiringPlans.total} kế hoạch →
                  </a>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      ) : null}
    </div>
  );
}
