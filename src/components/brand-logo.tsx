"use client";

import { useState } from "react";

const REAL_LOGO_URL =
  "https://datax-talent.basecdn.net/dalathasfarm/logo-footer.png";

type LogoSize = "sm" | "md" | "lg" | "xl" | "2xl";

interface BrandLogoProps {
  size?: LogoSize;
  light?: boolean;
  withText?: boolean;
}

export function BrandLogo({
  size = "md",
  light = false,
  withText = true,
}: BrandLogoProps) {
  const [imgFailed, setImgFailed] = useState(false);

  const sizes = {
    sm: {
      box: "h-10 w-10 rounded-xl",
      img: "h-[74%] w-[74%]",
      title: "text-sm",
      sub: "text-[9px]",
    },
    md: {
      box: "h-14 w-14 rounded-2xl",
      img: "h-[78%] w-[78%]",
      title: "text-lg",
      sub: "text-[10px]",
    },
    lg: {
      box: "h-16 w-16 rounded-2xl",
      img: "h-[80%] w-[80%]",
      title: "text-xl",
      sub: "text-[10px]",
    },
    xl: {
      box: "h-20 w-20 rounded-3xl",
      img: "h-[82%] w-[82%]",
      title: "text-2xl",
      sub: "text-[11px]",
    },
    "2xl": {
      box: "h-24 w-24 rounded-[28px]",
      img: "h-[84%] w-[84%]",
      title: "text-3xl",
      sub: "text-xs",
    },
  };

  const current = sizes[size];

  return (
    <div className="flex items-center gap-4">

      <div
        className={`
          ${current.box}
          relative
          flex
          shrink-0
          items-center
          justify-center
          overflow-hidden
          bg-white
          shadow-[0_18px_45px_rgba(15,23,42,.18)]
          ring-1
          ring-slate-200
          transition-all
          duration-300
          hover:-translate-y-1
          hover:shadow-[0_24px_60px_rgba(15,23,42,.25)]
        `}
      >
        {!imgFailed ? (
          <img
            src={REAL_LOGO_URL}
            alt="Dalat Hasfarm"
            className={`${current.img} object-contain`}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <svg
            viewBox="0 0 40 40"
            className="h-[75%] w-[75%]"
            aria-hidden
          >
            <circle cx="20" cy="20" r="5" fill="#D9A327" />

            <ellipse cx="20" cy="8" rx="6" ry="7" fill="#0D5D35" />

            <ellipse cx="20" cy="32" rx="6" ry="7" fill="#0D5D35" />

            <ellipse cx="8" cy="20" rx="7" ry="6" fill="#197A44" />

            <ellipse cx="32" cy="20" rx="7" ry="6" fill="#197A44" />

            <ellipse cx="12" cy="12" rx="5" ry="5" fill="#2C9856" />

            <ellipse cx="28" cy="12" rx="5" ry="5" fill="#2C9856" />

            <ellipse cx="12" cy="28" rx="5" ry="5" fill="#2C9856" />

            <ellipse cx="28" cy="28" rx="5" ry="5" fill="#2C9856" />
          </svg>
        )}
      </div>

      {withText && (
        <div className="leading-tight">

          <h2
            className={`
              ${current.title}
              font-black
              tracking-tight
              ${
                light
                  ? "text-white"
                  : "text-hasfarm-900"
              }
            `}
          >
            DALAT{" "}
            <span
              className={
                light
                  ? "text-gold-300"
                  : "text-gold-700"
              }
            >
              HASFARM
            </span>
          </h2>

          <p
            className={`
              ${current.sub}
              mt-1
              font-semibold
              uppercase
              tracking-[0.22em]
              ${
                light
                  ? "text-white/70"
                  : "text-slate-500"
              }
            `}
          >
            Recruitment & Internship Portal
          </p>

        </div>
      )}
    </div>
  );
}

export function HasfarmMark({
  className = "",
}: {
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-hasfarm-700/40">
        DALAT HASFARM • GROW HAPPINESS
      </p>
    </div>
  );
}
