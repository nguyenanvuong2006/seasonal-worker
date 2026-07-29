"use client";

import { useState } from "react";

const REAL_LOGO_URL = "https://datax-talent.basecdn.net/dalathasfarm/logo-footer.png";

export function BrandLogo({
  size = "md",
  light = false,
  withText = true,
}: {
  size?: "sm" | "md" | "lg" | "xl";
  light?: boolean;
  withText?: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const box =
    size === "sm"
      ? "h-9 w-9"
      : size === "lg"
        ? "h-[52px] w-[52px]"
        : size === "xl"
          ? "h-16 w-16 md:h-20 md:w-20"
          : "h-11 w-11";
  const titleSize =
    size === "sm" ? "text-[13px]" : size === "lg" || size === "xl" ? "text-[22px]" : "text-[16px]";
  const subSize = size === "sm" ? "text-[8px]" : "text-[10px]";

  return (
    <div className="flex items-center gap-3">
      <div
        className={`${box} relative flex shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-white shadow-[0_4px_14px_rgba(0,0,0,0.12)] ring-1 ring-black/5`}
      >
        {!imgFailed ? (
          // Logo thật của Dalat Hasfarm (từ trang tuyển dụng chính thức) — dự phòng bằng
          // biểu tượng hoa vẽ tay bên dưới nếu ảnh không tải được (CDN ngoài, không kiểm soát được).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={REAL_LOGO_URL}
            alt="Dalat Hasfarm"
            className="h-[80%] w-[80%] object-contain"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <svg viewBox="0 0 40 40" className="h-[70%] w-[70%]" aria-hidden>
            <circle cx="20" cy="19" r="5" fill="#D9A327" />
            <ellipse cx="20" cy="8" rx="6" ry="7" fill="#115830" opacity={0.95} />
            <ellipse cx="20" cy="31" rx="6" ry="7" fill="#115830" opacity={0.95} />
            <ellipse cx="8.5" cy="19" rx="7" ry="6" fill="#16693A" />
            <ellipse cx="31.5" cy="19" rx="7" ry="6" fill="#16693A" />
            <ellipse cx="11.5" cy="10.5" rx="5" ry="5.5" fill="#22824B" opacity={0.9} />
            <ellipse cx="28.5" cy="10.5" rx="5" ry="5.5" fill="#22824B" opacity={0.9} />
            <ellipse cx="11.5" cy="27.5" rx="5" ry="5.5" fill="#22824B" opacity={0.9} />
            <ellipse cx="28.5" cy="27.5" rx="5" ry="5.5" fill="#22824B" opacity={0.9} />
          </svg>
        )}
      </div>
      {withText && (
        <div className="leading-[0.95]">
          <p
            className={`${titleSize} font-black tracking-[-0.02em] ${
              light ? "text-white" : "text-[#0E3A1F]"
            }`}
            style={{ fontFamily: "Inter, ui-sans-serif, system-ui" }}
          >
            DALAT <span className={light ? "text-[#F6D785]" : "text-[#9A6B12]"}>HASFARM</span>
          </p>
          <p
            className={`${subSize} mt-[2px] font-bold uppercase tracking-[0.22em] ${
              light ? "text-white/70" : "text-[#6B7F72]"
            }`}
          >
            Seasonal HR • Đà Lạt
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
