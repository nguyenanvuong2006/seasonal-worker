"use client";

import * as React from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ---------------- Button ---------------- */
type ButtonVariant =
  | "default"
  | "gold"
  | "outline"
  | "ghost"
  | "destructive"
  | "subtle"
  | "success";
type ButtonSize = "sm" | "md" | "lg" | "xl" | "icon";

const variantMap: Record<ButtonVariant, string> = {
  default: "bg-hasfarm-700 text-white hover:bg-hasfarm-800 shadow-sm",
  gold: "bg-gold-500 text-hasfarm-900 hover:bg-gold-400 shadow-md font-extrabold",
  outline: "border-2 border-hasfarm-200 bg-white text-hasfarm-800 hover:bg-hasfarm-50",
  ghost: "text-hasfarm-700 hover:bg-hasfarm-50",
  destructive: "bg-red-600 text-white hover:bg-red-700 shadow-sm",
  subtle: "bg-hasfarm-50 text-hasfarm-800 hover:bg-hasfarm-100",
  success: "bg-emerald-600 text-white hover:bg-emerald-700",
};

const sizeMap: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
  xl: "h-14 px-6 text-lg",
  icon: "h-9 w-9",
};

export function Button({
  className,
  variant = "default",
  size = "md",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl font-bold transition-all active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
        variantMap[variant],
        sizeMap[size],
        className,
      )}
      {...props}
    />
  );
}

/* ---------------- Input ---------------- */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full rounded-xl border-2 border-gray-200 bg-white px-3 py-2 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-hasfarm-500 focus:ring-2 focus:ring-hasfarm-100 disabled:bg-gray-50",
        className,
      )}
      {...props}
    />
  );
});

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-xl border-2 border-gray-200 bg-white px-3 py-2 text-gray-900 outline-none focus:border-hasfarm-500",
        className,
      )}
      {...props}
    />
  );
}

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("mb-1 block text-sm font-bold text-hasfarm-900", className)}
      {...props}
    />
  );
}

/* ---------------- Card ---------------- */
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-2xl border bg-white shadow-sm", className)}
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}

export function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
      <div>
        <h2 className="text-lg font-extrabold text-hasfarm-900">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
        ) : null}
      </div>
      {right}
    </div>
  );
}

/* ---------------- Badge ---------------- */
export function Badge({
  tone = "gray",
  children,
  className,
}: {
  tone?: "gray" | "green" | "amber" | "red" | "gold" | "blue";
  children: React.ReactNode;
  className?: string;
}) {
  const tones: Record<string, string> = {
    gray: "bg-gray-100 text-gray-700 border-gray-200",
    green: "bg-emerald-100 text-emerald-800 border-emerald-200",
    amber: "bg-amber-100 text-amber-900 border-amber-300",
    red: "bg-red-100 text-red-800 border-red-200",
    gold: "bg-gold-100 text-gold-800 border-gold-300",
    blue: "bg-sky-100 text-sky-800 border-sky-200",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ---------------- Toast ---------------- */
type Toast = { id: number; title: string; variant?: "default" | "destructive" };
let pushToastFn: ((t: Omit<Toast, "id">) => void) | null = null;

export function toast(t: { title: string; variant?: "default" | "destructive" }) {
  pushToastFn?.(t);
}

export function Toaster() {
  const [items, setItems] = React.useState<Toast[]>([]);

  React.useEffect(() => {
    pushToastFn = (t) => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev, { ...t, id }]);
      setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), 3800);
    };
    return () => {
      pushToastFn = null;
    };
  }, []);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,360px)] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            "animate-slide-up rounded-xl border px-4 py-3 text-sm font-bold shadow-lg",
            t.variant === "destructive"
              ? "border-red-300 bg-red-50 text-red-800"
              : "border-hasfarm-200 bg-white text-hasfarm-900",
          )}
        >
          {t.title}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Searchable Select (Combobox) ---------------- */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "-- Nhấp để chọn --",
  className,
  searchThreshold = 6,
}: {
  value?: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  className?: string;
  searchThreshold?: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-12 w-full items-center justify-between rounded-xl border-2 bg-white px-3 text-left text-sm font-semibold transition",
          open ? "border-hasfarm-500" : "border-gray-200",
          selected ? "text-gray-900" : "text-gray-400",
        )}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <span className="ml-2 text-gray-400">▾</span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-hidden rounded-xl border-2 border-hasfarm-100 bg-white shadow-2xl">
          {options.length >= searchThreshold && (
            <div className="border-b bg-hasfarm-50/60 p-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="🔎 Gõ để tìm nhanh..."
                className="h-10 w-full rounded-lg border border-hasfarm-200 px-3 text-sm outline-none focus:border-hasfarm-500"
              />
            </div>
          )}
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 && (
              <p className="p-3 text-center text-xs text-gray-400">
                Không tìm thấy kết quả
              </p>
            )}
            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                  setQuery("");
                }}
                className={cn(
                  "block w-full px-3 py-2.5 text-left text-sm font-semibold hover:bg-hasfarm-50",
                  o.value === value && "bg-hasfarm-100 text-hasfarm-900",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Modal ---------------- */
export function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4">
      <div
        className={cn(
          "animate-slide-up max-h-[90vh] w-full overflow-y-auto rounded-2xl bg-white shadow-2xl",
          width,
        )}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h3 className="text-lg font-extrabold text-hasfarm-900">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-lg px-2 text-xl text-gray-400 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
