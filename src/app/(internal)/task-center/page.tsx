"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  PageHeader,
  SearchBar,
  Skeleton,
} from "@/components/ui";
import {
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  LogOut,
  Repeat,
  Shuffle,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

type Section<T> = { rows: T[]; total: number };
type TaskData = {
  newApplicants: Section<{ id: string; fullName: string; cccd: string; submittedAt: string }>;
  resignations: Section<{ id: string; workerName: string | null; workerCccd: string | null; effectiveDate: string; requestedBy: string; createdAt: string }>;
  transfers: Section<{ id: string; workerName: string | null; workerCccd: string | null; status: string; effectiveDate: string; requestedBy: string; createdAt: string }>;
  expiringPlans: Section<{ id: string; deptName: string | null; section: string | null; endDate: string; targetCount: number | null }>;
  reallocationTasks: Section<{
    id: string;
    requestCode: string | null;
    departmentName: string | null;
    section: string | null;
    groupName: string | null;
    endDate: string | null;
    totalActiveAllocations: number;
    maleCount: number;
    femaleCount: number;
    recruitmentRequestId: string | null;
    dueDate: string | null;
  }>;
  hiddenSections: string[];
  generatedAt: string;
};

type LoadState = "loading" | "success" | "empty" | "error" | "forbidden";

function ageDays(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
function priorityBadge(days: number) {
  if (days >= 3) return <Badge tone="red" dot>Ưu tiên cao · {days} ngày</Badge>;
  if (days >= 1) return <Badge tone="amber" dot>{days} ngày</Badge>;
  return <Badge tone="green" dot>Mới</Badge>;
}

function TaskGroup({
  icon: Icon,
  title,
  total,
  emptyLabel,
  moreHref,
  children,
}: {
  icon: LucideIcon;
  title: string;
  total: number;
  emptyLabel: string;
  moreHref: string;
  visibleCount: number;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-3.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-primary-tint text-primary">
          <Icon className="h-4 w-4" aria-hidden />
        </div>
        <h3 className="text-[14px] font-semibold text-fg">
          {title} <span className="text-fg-muted">({total})</span>
        </h3>
      </div>
      <CardContent className="space-y-1 p-2.5">
        {total === 0 ? (
          <p className="px-2.5 py-4 text-center text-[13px] text-fg-muted">{emptyLabel}</p>
        ) : (
          <>
            {children}
            {total > 0 && (
              <a
                href={moreHref}
                className="mt-1 block rounded-[8px] px-2.5 py-2 text-center text-[12px] font-semibold text-primary transition-colors hover:bg-primary-tint"
              >
                Xem tất cả {total} →
              </a>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TaskRow({
  href,
  title,
  meta,
  badge,
}: {
  href: string;
  title: React.ReactNode;
  meta: React.ReactNode;
  badge: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="group flex items-center justify-between gap-3 rounded-[10px] px-3 py-2.5 transition-colors hover:bg-surface-hover"
    >
      <div className="min-w-0">
        <p className="truncate text-[13.5px] font-semibold text-fg">{title}</p>
        <p className="mt-0.5 truncate text-[12px] text-fg-muted">{meta}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {badge}
        <ChevronRight className="h-4 w-4 text-fg-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </div>
    </a>
  );
}

function TaskCenterSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-[14px] border border-border bg-surface p-5" role="status" aria-label="Đang tải">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-7 w-7 rounded-[8px]" />
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="mt-4 space-y-3">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3.5 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
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
      const total =
        json.newApplicants.total +
        json.resignations.total +
        json.transfers.total +
        json.expiringPlans.total +
        (json.reallocationTasks?.total ?? 0);
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

  const hidden = new Set(data?.hiddenSections ?? []);

  return (
    <div className="space-y-5">
      <PageHeader title="Task Center" description="Các công việc cần bạn xử lý và theo dõi." />

      <SearchBar
        value={q}
        onChange={onSearchChange}
        placeholder="Tìm theo tên hoặc CCCD trong tất cả các việc bên dưới..."
        className="max-w-xl"
      />

      {state === "forbidden" ? (
        <Card>
          <ErrorState
            title="Không có quyền truy cập"
            description={errorMsg}
            onRetry={errorMsg.includes("đăng nhập") ? () => router.push("/login") : undefined}
          />
        </Card>
      ) : state === "error" ? (
        <Card>
          <ErrorState description={errorMsg} onRetry={retry} />
        </Card>
      ) : state === "loading" && !data ? (
        <TaskCenterSkeleton />
      ) : state === "empty" ? (
        <Card>
          <EmptyState
            icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
            title="Không còn công việc cần xử lý"
            description={q ? `Không có việc nào khớp với "${q}".` : "Bạn đã xử lý hết các task hiện tại."}
          />
        </Card>
      ) : data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {!hidden.has("newApplicants") && (
            <TaskGroup
              icon={UserPlus}
              title="Người mới chờ duyệt"
              total={data.newApplicants.total}
              visibleCount={data.newApplicants.rows.length}
              emptyLabel="Không có."
              moreHref="/hr/registrations"
            >
              {data.newApplicants.rows.map((r) => (
                <TaskRow
                  key={r.id}
                  href="/hr/registrations"
                  title={r.fullName}
                  meta={r.cccd}
                  badge={priorityBadge(ageDays(r.submittedAt))}
                />
              ))}
            </TaskGroup>
          )}

          {!hidden.has("resignations") && (
            <TaskGroup
              icon={LogOut}
              title="Nghỉ việc chờ duyệt"
              total={data.resignations.total}
              visibleCount={data.resignations.rows.length}
              emptyLabel="Không có."
              moreHref="/admin/workforce-movements"
            >
              {data.resignations.rows.map((r) => (
                <TaskRow
                  key={r.id}
                  href="/admin/workforce-movements"
                  title={r.workerName}
                  meta={`${r.workerCccd} · hiệu lực ${r.effectiveDate}`}
                  badge={priorityBadge(ageDays(r.createdAt))}
                />
              ))}
            </TaskGroup>
          )}

          {!hidden.has("transfers") && (
            <TaskGroup
              icon={Repeat}
              title="Thuyên chuyển chờ xử lý"
              total={data.transfers.total}
              visibleCount={data.transfers.rows.length}
              emptyLabel="Không có."
              moreHref="/admin/workforce-movements"
            >
              {data.transfers.rows.map((r) => (
                <TaskRow
                  key={r.id}
                  href="/admin/workforce-movements"
                  title={r.workerName}
                  meta={`${r.workerCccd} · ${r.status === "WAITING_DECISION" ? "Không đến — chờ quyết định" : "Chờ xác nhận"}`}
                  badge={priorityBadge(ageDays(r.createdAt))}
                />
              ))}
            </TaskGroup>
          )}

          {/* Yêu cầu tuyển dụng hết hạn còn DW chờ chuyển phân bổ (Yêu cầu #7/#14).
              Đặt ĐẦU danh sách vì đây là việc chặn: DW vẫn đang làm việc nhưng
              không còn gắn với yêu cầu nào còn hiệu lực. */}
          {!hidden.has("reallocationTasks") && data.reallocationTasks && (
            <TaskGroup
              icon={Shuffle}
              title="Yêu cầu hết hạn — cần chuyển phân bổ DW"
              total={data.reallocationTasks.total}
              visibleCount={data.reallocationTasks.rows.length}
              emptyLabel="Không có."
              moreHref="/admin/recruitment-requests"
            >
              {data.reallocationTasks.rows.map((r) => (
                <TaskRow
                  key={r.id}
                  href={`/admin/recruitment-requests?reallocateFrom=${r.recruitmentRequestId ?? ""}`}
                  title={`${r.requestCode ?? "—"} · ${r.totalActiveAllocations} DW cần xác nhận`}
                  meta={`${[r.departmentName, r.section, r.groupName].filter(Boolean).join(" / ") || "—"} · Nam ${r.maleCount} / Nữ ${r.femaleCount}`}
                  badge={<Badge tone="red" dot>Hết hạn {r.endDate ?? "—"}</Badge>}
                />
              ))}
            </TaskGroup>
          )}

          {!hidden.has("expiringPlans") && (
            <TaskGroup
              icon={CalendarClock}
              title="Planning sắp hết hạn"
              total={data.expiringPlans.total}
              visibleCount={data.expiringPlans.rows.length}
              emptyLabel="Không có."
              moreHref="/admin/planning"
            >
              {data.expiringPlans.rows.map((r) => (
                <TaskRow
                  key={r.id}
                  href="/admin/planning"
                  title={`${r.deptName}${r.section ? ` — ${r.section}` : ""}`}
                  meta={`Nhu cầu ${r.targetCount ?? 0}`}
                  badge={<Badge tone="amber" dot>Hết hạn {r.endDate}</Badge>}
                />
              ))}
            </TaskGroup>
          )}
        </div>
      ) : null}
    </div>
  );
}
