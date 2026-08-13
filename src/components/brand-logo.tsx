"use client";

import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";

const LOGO_SRC = "/brand/dalat-hasfarm-logo.png";
let cachedLogoStatus: "checking" | "ok" | "failed" = "checking";

export function BrandLogo({ size = "md", light = false, withText = true }: { size?: "sm" | "md" | "lg" | "xl"; light?: boolean; withText?: boolean }) {
  const [status, setStatus] = useState(cachedLogoStatus);
  useEffect(() => {
    if (cachedLogoStatus !== "checking") { setStatus(cachedLogoStatus); return; }
    const probe = new Image();
    probe.onload = () => { cachedLogoStatus = "ok"; setStatus("ok"); };
    probe.onerror = () => { cachedLogoStatus = "failed"; setStatus("failed"); };
    probe.src = LOGO_SRC;
  }, []);

  const box = size === "sm" ? "h-11 w-[72px]" : size === "lg" ? "h-[72px] w-[118px]" : size === "xl" ? "h-[86px] w-[142px] md:h-[96px] md:w-[158px]" : "h-14 w-[92px]";
  const titleSize = size === "sm" ? "text-[13px]" : size === "lg" || size === "xl" ? "text-[20px] md:text-[22px]" : "text-[15px]";
  const subSize = size === "sm" ? "text-[8px]" : "text-[10px]";

  return (
    <div className="flex items-center gap-3.5">
      <div className={`${box} relative flex shrink-0 items-center justify-center overflow-hidden rounded-[16px] bg-white p-2 shadow-[0_8px_24px_rgba(0,0,0,0.14)] ring-1 ring-black/5`}>
        {status === "ok" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={LOGO_SRC} alt="Dalat Hasfarm" className="h-full w-full object-contain" />
        ) : status === "failed" ? (
          <ImageOff className="h-[38%] w-[38%] text-fg-muted" aria-hidden />
        ) : null}
      </div>
      {withText && <div className="leading-[1.15]"><p className={`${titleSize} font-bold tracking-[-0.01em] ${light ? "text-white" : "text-fg"}`}>Seasonal Internship</p><p className={`${subSize} mt-[3px] font-semibold uppercase tracking-[0.16em] ${light ? "text-white/70" : "text-fg-muted"}`}>Dalat Hasfarm</p></div>}
    </div>
  );
}

export function HasfarmMark({ className = "" }: { className?: string }) {
  return <div className={`pointer-events-none select-none ${className}`}><p className="text-[10px] font-black uppercase tracking-[0.22em] text-hasfarm-700/50">DALAT HASFARM • SEASONAL INTERNSHIP</p></div>;
}
