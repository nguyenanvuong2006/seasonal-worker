"use client";

import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";

/**
 * Chỗ trống (asset slot) cho logo chính thức của Dalat Hasfarm — xem public/brand/README.md.
 * Repo hiện CHƯA có file logo chính thức nào; ảnh này sẽ 404 cho tới khi có file thật được đặt
 * đúng đường dẫn. Cố tình KHÔNG dùng CDN ngoài, KHÔNG vẽ logo giả (SVG/CSS), KHÔNG dùng chữ
 * "Dalat Hasfarm" thay cho logo — khi ảnh chưa có, hiển thị khung trống rõ ràng (ImageOff) thay
 * vì mô phỏng một logo không có thật.
 */
const LOGO_SRC = "/brand/dalat-hasfarm-logo.png";

/** "checking" = SSR + trước khi client kiểm tra xong; "ok"/"failed" = kết quả đã biết. */
let cachedLogoStatus: "checking" | "ok" | "failed" = "checking";

export function BrandLogo({
  size = "md",
  light = false,
  withText = true,
}: {
  size?: "sm" | "md" | "lg" | "xl";
  light?: boolean;
  withText?: boolean;
}) {
  // KHÔNG render <img src=...> lạc quan rồi bắt onError: ảnh 404 cục bộ thường load/lỗi NHANH
  // HƠN thời điểm React gắn xong sự kiện sau hydration (sự kiện "error" trên <img> không bubble
  // nên React không delegate/replay được) — onError bị bỏ lỡ, trình duyệt hiện icon ảnh vỡ mặc
  // định. Thay vào đó: kiểm tra ảnh hoàn toàn phía client bằng `Image()` sau mount, chỉ render
  // <img> thật khi ĐÃ CHẮC CHẮN tải được (lúc đó trình duyệt đã cache sẵn, không thể lỗi nữa).
  const [status, setStatus] = useState(cachedLogoStatus);
  useEffect(() => {
    if (cachedLogoStatus !== "checking") {
      setStatus(cachedLogoStatus);
      return;
    }
    const probe = new Image();
    probe.onload = () => {
      cachedLogoStatus = "ok";
      setStatus("ok");
    };
    probe.onerror = () => {
      cachedLogoStatus = "failed";
      setStatus("failed");
    };
    probe.src = LOGO_SRC;
  }, []);
  const box =
    size === "sm"
      ? "h-9 w-9"
      : size === "lg"
        ? "h-[52px] w-[52px]"
        : size === "xl"
          ? "h-16 w-16 md:h-20 md:w-20"
          : "h-11 w-11";
  const titleSize =
    size === "sm" ? "text-[13px]" : size === "lg" || size === "xl" ? "text-[19px]" : "text-[15px]";
  const subSize = size === "sm" ? "text-[8px]" : "text-[10px]";

  return (
    <div className="flex items-center gap-3">
      <div
        className={`${box} relative flex shrink-0 items-center justify-center overflow-hidden rounded-[12px] ${
          light ? "bg-white/10 ring-1 ring-white/15" : "bg-white shadow-[0_4px_14px_rgba(0,0,0,0.12)] ring-1 ring-black/5"
        }`}
      >
        {status === "ok" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={LOGO_SRC} alt="Dalat Hasfarm" className="h-[80%] w-[80%] object-contain" />
        ) : status === "failed" ? (
          <ImageOff className={light ? "h-[42%] w-[42%] text-white/35" : "h-[42%] w-[42%] text-fg-muted"} aria-hidden />
        ) : null}
      </div>
      {withText && (
        <div className="leading-[1.15]">
          <p className={`${titleSize} font-bold tracking-[-0.01em] ${light ? "text-white" : "text-fg"}`}>
            Seasonal Worker
          </p>
          <p className={`${subSize} mt-[1px] font-medium uppercase tracking-[0.14em] ${light ? "text-white/55" : "text-fg-muted"}`}>
            Dalat Hasfarm
          </p>
        </div>
      )}
    </div>
  );
}

export function HasfarmMark({ className = "" }: { className?: string }) {
  return (
    <div className={`pointer-events-none select-none ${className}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.28em] text-hasfarm-700/50">
        EST. 1994 — DA LAT — NETHERLANDS — JAPAN
      </p>
    </div>
  );
}
