"use client";

import { useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, Input, Label, toast } from "@/components/ui";
import { Loader2, Search, Fingerprint, RefreshCw } from "lucide-react";

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
  const [cccd, setCccd] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
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

  const saveFingerprint = async () => {
    if (!profile) return;
    const res = await fetch(`/api/worker-profiles/${profile.cccd}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...fp, fingerprintStatus: fp.fingerprintCode ? "DA_CAP" : "CHUA_CAP" }),
    });
    if (!res.ok) {
      toast({ title: "Lưu thất bại", variant: "destructive" });
      return;
    }
    toast({ title: "✅ Đã cập nhật mã vân tay" });
    await search();
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
        title: `✅ Đã đồng bộ: ${d.profilesFromApps} hồ sơ điện tử, ${d.sessionsCreated} đợt làm việc mới được liên kết`,
      });
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-hasfarm-900">Hồ sơ điện tử lao động (Digital Worker File)</h1>
          <p className="text-sm text-gray-500">
            Mỗi người chỉ có 1 hồ sơ duy nhất, gộp toàn bộ lịch sử các lần đăng ký/đợt làm việc — không tạo người mới
            mỗi lần quay lại.
          </p>
        </div>
        <Button variant="subtle" onClick={runBackfill} disabled={backfilling} className="gap-2">
          {backfilling ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Đồng bộ dữ liệu cũ
        </Button>
      </div>

      <Card>
        <CardContent className="flex gap-2 pt-6">
          <Input
            value={cccd}
            onChange={(e) => setCccd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Nhập số CCCD để tra cứu hồ sơ điện tử..."
            className="h-11 flex-1"
          />
          <Button onClick={search} disabled={loading} className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Tra cứu
          </Button>
        </CardContent>
      </Card>

      {notFound && <p className="text-center text-sm text-gray-400">Chưa có hồ sơ điện tử cho CCCD này.</p>}

      {profile && (
        <>
          <Card>
            <CardHeader title={profile.fullName} subtitle={`CCCD: ${profile.cccd}`} />
            <CardContent className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <p>Giới tính: {profile.gender ?? "—"}</p>
              <p>Ngày sinh: {profile.dob ?? "—"}</p>
              <p>SĐT: {profile.phone ?? "—"}</p>
              <p>Địa chỉ: {profile.residentialAddress ?? profile.permanentAddress ?? "—"}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <Fingerprint className="h-4 w-4" /> Biometric — Mã vân tay
                </span>
              }
              subtitle={<Badge tone={profile.fingerprintStatus === "DA_CAP" ? "green" : "amber"}>{profile.fingerprintStatus === "DA_CAP" ? "Đã cấp" : "Chưa cấp"}</Badge>}
            />
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label>Mã vân tay</Label>
                <Input value={fp.fingerprintCode} onChange={(e) => setFp({ ...fp, fingerprintCode: e.target.value })} className="h-10" />
              </div>
              <div>
                <Label>Thiết bị</Label>
                <Input value={fp.fingerprintDevice} onChange={(e) => setFp({ ...fp, fingerprintDevice: e.target.value })} className="h-10" />
              </div>
              <div className="flex items-end">
                <Button onClick={saveFingerprint} className="h-10 w-full">
                  Lưu
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="p-0">
            <CardHeader title={`Lịch sử làm việc — ${sessions.length} đợt`} />
            <CardContent className="p-0">
              <ul className="divide-y">
                {sessions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 p-4 text-sm">
                    <Badge tone={s.status === "APPROVED" ? "green" : s.status === "REJECTED" ? "red" : "amber"}>{s.status}</Badge>
                    <span className="font-semibold">{s.deptName ?? "Chưa xếp bộ phận"}</span>
                    <span className="text-gray-400">Đăng ký: {s.regDate}</span>
                    {s.startingDate && <span className="text-gray-400">Bắt đầu: {s.startingDate}</span>}
                  </li>
                ))}
                {sessions.length === 0 && <li className="p-8 text-center text-gray-400">Chưa có lịch sử.</li>}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
