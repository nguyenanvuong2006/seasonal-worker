"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, UserCircle } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, FormField, Input, toast } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/helpers";

type Profile = {
  id: string;
  username: string;
  fullName: string;
  role: string;
  deptId: string | null;
  deptName: string | null;
  isActive: boolean;
  createdAt: string;
};

export function ProfileView({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [fullName, setFullName] = useState(profile.fullName);
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Cập nhật thất bại.", variant: "destructive" });
        return;
      }
      toast({ title: "Đã cập nhật hồ sơ cá nhân." });
      router.refresh();
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPassword(true);
    try {
      const res = await fetch("/api/profile/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Đổi mật khẩu thất bại.", variant: "destructive" });
        return;
      }
      toast({ title: "Đổi mật khẩu thành công! Vui lòng đăng nhập lại." });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      router.push("/login");
      router.refresh();
    } finally {
      setSavingPassword(false);
    }
  };

  const displayName = profile.fullName || profile.username;
  const initial = displayName.slice(0, 1).toUpperCase();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <UserCircle className="h-4 w-4 text-primary" aria-hidden />
              Thông tin tài khoản
            </span>
          }
        />
        <CardContent className="space-y-5">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-[18px] font-bold text-white">
              {initial}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold text-fg">{displayName}</p>
              <p className="text-[12.5px] text-fg-muted">@{profile.username}</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Vai trò</p>
              <p className="mt-0.5 text-[13.5px] font-medium text-fg">{ROLE_LABEL[profile.role] ?? profile.role}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Bộ phận / Phạm vi</p>
              <p className="mt-0.5 text-[13.5px] font-medium text-fg">{profile.deptName ?? "Không giới hạn theo bộ phận"}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Trạng thái tài khoản</p>
              <Badge tone={profile.isActive ? "green" : "red"} className="mt-1">
                {profile.isActive ? "Đang hoạt động" : "Đã khoá"}
              </Badge>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Ngày tạo tài khoản</p>
              <p className="mt-0.5 text-[13.5px] font-medium text-fg">{new Date(profile.createdAt).toLocaleDateString("vi-VN")}</p>
            </div>
          </div>

          <p className="text-[11.5px] text-fg-muted">
            Vai trò, quyền hạn, Data Scope và trạng thái tài khoản chỉ Admin mới có thể thay đổi — không thể tự sửa ở
            đây.
          </p>

          <form onSubmit={saveProfile} className="space-y-4 border-t border-border pt-4">
            <FormField label="Họ và tên" required>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={160} required />
            </FormField>
            <div className="flex justify-end">
              <Button type="submit" loading={savingProfile} disabled={!fullName.trim() || fullName === profile.fullName}>
                Lưu thay đổi
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card id="password">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" aria-hidden />
              Đổi mật khẩu
            </span>
          }
          subtitle="Sau khi đổi mật khẩu thành công, bạn sẽ cần đăng nhập lại."
        />
        <CardContent>
          <form onSubmit={changePassword} className="space-y-4">
            <FormField label="Mật khẩu hiện tại" required>
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Mật khẩu mới" required helper="Tối thiểu 8 ký tự.">
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </FormField>
              <FormField label="Nhập lại mật khẩu mới" required>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </FormField>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={savingPassword}>
                Đổi mật khẩu
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
