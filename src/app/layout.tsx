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
      <head>
        <style>{`
          /* Premium flat brand treatment: shared legacy classes must not
             reintroduce gradients or agricultural grid textures. */
          .hasfarm-hero,
          .hasfarm-hero.field-rows {
            background-color: #0b4527 !important;
            background-image: none !important;
          }
          .hasfarm-hero::after {
            display: none !important;
          }
          .field-rows,
          .field-rows-light {
            background-image: none !important;
          }
        `}</style>
      </head>
      <body className="bg-bg text-fg antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
