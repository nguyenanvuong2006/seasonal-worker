import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Toaster } from "@/components/ui";

export const metadata: Metadata = {
  title: "Dalat Hasfarm — Hệ Thống Quản Trị Tập Nghề Thời Vụ",
  description:
    "Đăng ký tập nghề thời vụ, xếp bộ phận và quản trị nhân sự cho Dalat Hasfarm.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body className="bg-bg text-fg antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
