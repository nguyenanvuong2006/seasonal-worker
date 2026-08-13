"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  FormField,
  Input,
  PageHeader,
  StatusBadge,
  toast,
} from "@/components/ui";
import { Fingerprint, RefreshCw, Search, UserX } from "lucide-react";

type Session = {
  id: string;
  regDate: string;
  status: string;
  startingDate: string | null;
  endDate: string | null;
  note: string | null;
  deptName: string | null;
  groupName: string | null;
};
type Profile = {
  id: string;
  cccd: string;
  fullName: string;
  gender: string | null;
  dob: string | null;
  phone: string | null;
  permanentAddress: string | null;
  residentialAddress: string | null;
  fingerprintCode: string | null;
  fingerprintDevice: string | null;
  fingerprintStatus: string | null;
};

export default function WorkerProfilesPage() {
  const searchParams = useSearchParams();
  const [cccd, setCccd] = useState(() => searchParams.get("cccd") ?? "");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fp, setFp] = useState({ fingerprintCode: "", fingerprintDevice: "" });

  const search = async () => {
    if (!cccd.trim()) return;
    setLoading(true);
    setNotFound(false);
    setProfile(null);
    try {
      const res = await fetch(`/api/worker-profiles/${cccd.trim()}`);
      if (!res.ok) {
        setNotFound(true);
        return;
      }
      const data = await res.json();
      setProfile(data.profile);
      setSessions(data.sessions ?? []);
      setFp({ fingerprintCode: data.profile.fingerprintCode ?? "", fingerprintDevice: data.profile.fingerprintDevice ?? "" });
    } finally {
      setLoading(false);
    }
  };

  // Deep-link từ Tìm kiếm toàn hệ thống (?cccd=...) — tự tra cứu ngay khi vào trang
  useEffect(() => {
    if (searchParams.get("cccd")) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveFingerprint = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/worker-profiles/${profile.cccd}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fp, fingerprintStatus: fp.fingerprintCode ? "DA_CAP" : "CHUA_CAP" }),
      });
      if (!res.ok) {
        toast({ title: "Lưu thất bại", variant: "destructive" });
        return;
      }
      toast({ title: "Đã cập nhật mã vân tay" });
      await search();
    } finally {
      setSaving(false);
    }
  };

  const runBackfill = async () => {
    setBackfilling(true);
    try {
      const res = await fetch("/api/admin/worker-profiles/backfill", { method: "POST" });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Lỗi đồng bộ", variant: "destructive" });
        return;
      }
      toast({
        title: `Đã đồng bộ: ${d.profilesFromApps} hồ sơ Tập nghề, ${d.sessionsCreated} đợt Tập nghề mới được liên kết`,
      });
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Hồ sơ Tập nghề (Digital Internship Profile)"
        description="Mỗi người tập nghề chỉ có 1 hồ sơ duy nhất, gộp toàn bộ lịch sử các lần đăng ký và đợt Tập nghề — không tạo trùng hồ sơ mỗi khi quay lại."
        actions={
          <Button variant="outline" onClick={runBackfill} loading={backfilling}>
            <RefreshCw className="h-4 w-4" /> Đồng bộ dữ liệu cũ
          </Button>
        }
      />

      <Card>
        <CardContent className="flex gap-2 pt-6">
          <Input
            value={cccd}
            onChange={(e) => setCccd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Nhập số CCCD để tra cứu hồ sơ Tập nghề..."
            className="h-11 flex-1"
          />
          <Button onClick={search} loading={loading}>
            <Search className="h-4 w-4" /> Tra cứu
          </Button>
        </CardContent>
      </Card>

      {notFound && (
        <Card>
          <EmptyState
            icon={<UserX className="h-5 w-5" aria-hidden />}
            title="Không tìm thấy hồ sơ Tập nghề"
            description="Chưa có hồ sơ Tập nghề điện tử cho số CCCD này."
          />
        </Card>
      )}

      {profile && (
        <>
          <Card>
            <CardHeader title={profile.fullName} subtitle={`CCCD: ${profile.cccd}`} />
            <CardContent className="grid gap-x-6 gap-y-1.5 text-sm text-fg-secondary sm:grid-cols-2">
              <p>Giới tính: <span className="text-fg">{profile.gender ?? "—"}</span></p>
              <p>Ngày sinh: <span className="text-fg">{profile.dob ?? "—"}</span></p>
              <p>SĐT: <span className="text-fg">{profile.phone ?? "—"}</span></p>
              <p>Địa chỉ: <span className="text-fg">{profile.residentialAddress ?? profile.permanentAddress ?? "—"}</span></p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <Fingerprint className="h-4 w-4" /> Biometric — Mã vân tay người tập nghề
                </span>
              }
              subtitle={<Badge tone={profile.fingerprintStatus === "DA_CAP" ? "green" : "amber"} dot>{profile.fingerprintStatus === "DA_CAP" ? "Đã cấp" : "Chưa cấp"}</Badge>}
            />
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <FormField label="Mã vân tay">
                <Input value={fp.fingerprintCode} onChange={(e) => setFp({ ...fp, fingerprintCode: e.target.value })} />
              </FormField>
              <FormField label="Thiết bị">
                <Input value={fp.fingerprintDevice} onChange={(e) => setFp({ ...fp, fingerprintDevice: e.target.value })} />
              </FormField>
              <div className="flex items-end">
                <Button variant="primary" onClick={saveFingerprint} loading={saving} className="h-10 w-full">
                  Lưu
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="p-0">
            <CardHeader title={`Lịch sử đợt Tập nghề — ${sessions.length} đợt`} />
            <CardContent className="p-0">
              {sessions.length === 0 ? (
                <EmptyState title="Chưa có lịch sử Tập nghề" description="Người này chưa có đợt Tập nghề nào được ghi nhận." />
              ) : (
                <ul className="divide-y divide-border">
                  {sessions.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-3 p-4 text-sm">
                      <StatusBadge status={s.status} />
                      <span className="font-semibold text-fg">{s.deptName ?? "Chưa xếp bộ phận"}</span>
                      <span className="text-fg-muted">Đăng ký: {s.regDate}</span>
                      {s.startingDate && <span className="text-fg-muted">Bắt đầu: {s.startingDate}</span>}
                      {s.endDate && <span className="text-fg-muted">Kết thúc: {s.endDate}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
