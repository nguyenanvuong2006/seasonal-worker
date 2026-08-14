"use client";

import * as React from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  Search,
  X,
} from "lucide-react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ============================================================
   BUTTON
   ------------------------------------------------------------
   Same prop surface as before (variant/size never removed — every
   existing call site across the app keeps compiling and rendering) —
   only the underlying treatment changed: 1 filled primary, 2 flavors of
   secondary (bordered / tinted), 1 ghost, "danger" now OUTLINED instead
   of filled (a filled destructive button sitting next to a filled
   primary reads as two equally-weighted choices, which is backwards for
   anything irreversible). `gold` is kept as an alias of `primary` — the
   design system retires solid-gold as a button fill (gold is reserved for
   rare highlights), but 34 call sites already pass variant="gold" as
   *the* primary CTA, so the prop name stays and now renders the same
   restrained green primary as `default`.
   ============================================================ */
type ButtonVariant =
  | "default"
  | "primary"
  | "gold"
  | "outline"
  | "secondary"
  | "ghost"
  | "destructive"
  | "danger"
  | "subtle"
  | "success";
type ButtonSize = "sm" | "md" | "lg" | "xl" | "icon";

const variantMap: Record<ButtonVariant, string> = {
  // V2: Hasfarm orange is THE primary CTA. `gold` (warm yellow) is retired as a
  // button fill — it stays as a rare highlight color — and now maps to the same
  // orange primary so every existing `variant="gold"` call site renders the CTA.
  default: "bg-accent text-white hover:bg-accent-hover shadow-[0_1px_2px_rgba(198,90,15,0.35),0_6px_16px_rgba(226,109,28,0.18)]",
  primary: "bg-accent text-white hover:bg-accent-hover shadow-[0_1px_2px_rgba(198,90,15,0.35),0_6px_16px_rgba(226,109,28,0.18)]",
  gold: "bg-accent text-white hover:bg-accent-hover shadow-[0_1px_2px_rgba(198,90,15,0.35),0_6px_16px_rgba(226,109,28,0.18)]",
  outline: "border border-border-strong bg-surface-raised text-fg hover:border-primary/40 hover:bg-surface-hover",
  secondary: "border border-border-strong bg-surface-raised text-fg hover:border-primary/40 hover:bg-surface-hover",
  subtle: "bg-surface-hover text-fg hover:bg-border/60",
  ghost: "text-fg-secondary hover:bg-surface-hover hover:text-fg",
  destructive: "border border-danger/40 bg-surface-raised text-danger hover:bg-danger-tint",
  danger: "border border-danger/40 bg-surface-raised text-danger hover:bg-danger-tint",
  success: "bg-success text-white hover:brightness-95 shadow-sm",
};

const sizeMap: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-5 text-[15px]",
  xl: "h-12 px-6 text-base",
  icon: "h-9 w-9",
};

export function Button({
  className,
  variant = "default",
  size = "md",
  loading = false,
  disabled,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        variantMap[variant],
        sizeMap[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/* ---------------- Icon Button ---------------- */
export function IconButton({
  className,
  label,
  variant = "ghost",
  size = "icon",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <Button variant={variant} size={size} aria-label={label} title={label} className={className} {...props} />
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
        "h-10 w-full rounded-[10px] border border-border-strong bg-surface-raised px-3 text-[14px] text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-fg-muted",
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
        "w-full rounded-[10px] border border-border-strong bg-surface-raised px-3 py-2 text-[14px] text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

export function Label({
  className,
  required,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }) {
  return (
    <label className={cn("mb-1.5 block text-[13px] font-semibold text-fg", className)} {...props}>
      {children}
      {required ? <span className="ml-0.5 text-danger">*</span> : null}
    </label>
  );
}

/* ---------------- FormField ---------------- */
/** Label + control (via children) + helper text + inline error — the field-level
 * pattern the audit found missing everywhere (errors, when shown at all, only ever
 * surfaced as a toast). Purely presentational — wrap any existing Input/Textarea/Select. */
export function FormField({
  label,
  required,
  helper,
  error,
  htmlFor,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  helper?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
      {error ? (
        <p className="flex items-center gap-1 text-[12px] font-medium text-danger">
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          {error}
        </p>
      ) : helper ? (
        <p className="text-[12px] text-fg-muted">{helper}</p>
      ) : null}
    </div>
  );
}

/* ---------------- Card ---------------- */
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[16px] border border-border bg-surface shadow-[0_1px_2px_rgba(23,32,18,0.04),0_8px_24px_rgba(23,32,18,0.05)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-6", className)} {...props} />;
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
    <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}

/* ---------------- PageHeader + Breadcrumb ---------------- */
export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1.5 text-[12.5px] text-fg-muted">
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <React.Fragment key={item.label + i}>
            {i > 0 ? <span aria-hidden>/</span> : null}
            {item.href && !last ? (
              <a href={item.href} className="rounded transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30">
                {item.label}
              </a>
            ) : (
              <span className={last ? "font-semibold text-fg" : undefined} aria-current={last ? "page" : undefined}>
                {item.label}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/** Eyebrow label above a page title — small caps with an orange rule. */
export function SectionLabel({
  children,
  className,
  tone = "accent",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: "accent" | "green" | "muted";
}) {
  return (
    <p
      className={cn(
        "flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.14em]",
        tone === "accent" ? "text-accent" : tone === "green" ? "text-primary" : "text-fg-muted",
        className,
      )}
    >
      <span aria-hidden className={cn("h-[3px] w-4 rounded-full", tone === "accent" ? "bg-accent" : tone === "green" ? "bg-primary" : "bg-fg-muted")} />
      {children}
    </p>
  );
}

export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  eyebrow,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumb ? <Breadcrumb items={breadcrumb} /> : null}
        {eyebrow ? <div className="mb-1.5">{eyebrow}</div> : null}
        <h1 className="text-[24px] font-bold leading-tight tracking-[-0.015em] text-fg text-balance md:text-[27px]">{title}</h1>
        {description ? <p className="mt-1.5 max-w-[66ch] text-[13.5px] leading-relaxed text-fg-secondary">{description}</p> : null}
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ---------------- Badge ---------------- */
type BadgeTone = "gray" | "green" | "amber" | "red" | "gold" | "blue" | "purple";
const badgeTones: Record<BadgeTone, string> = {
  gray: "bg-surface-hover text-fg-secondary",
  green: "bg-success-tint text-success",
  amber: "bg-warning-tint text-warning",
  red: "bg-danger-tint text-danger",
  gold: "bg-accent-tint text-accent",
  blue: "bg-info-tint text-info",
  purple: "bg-purple-100 text-purple-800",
};
const badgeDotTones: Record<BadgeTone, string> = {
  gray: "bg-fg-muted",
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-danger",
  gold: "bg-accent",
  blue: "bg-info",
  purple: "bg-purple-600",
};

export function Badge({
  tone = "gray",
  dot = false,
  children,
  className,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-transparent px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        badgeTones[tone],
        className,
      )}
    >
      {dot ? <span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", badgeDotTones[tone])} aria-hidden /> : null}
      {children}
    </span>
  );
}

/* ---------------- StatusBadge ---------------- */
/** Single status -> {label, tone} lookup for every workflow/stage status string used
 * across the app, so "PENDING" (or any other status) renders identically everywhere
 * instead of the 4 parallel color implementations the audit found. Falls back to the
 * raw status string (still styled, just neutral tone) for anything not in the table —
 * new workflow_stages configured later at /admin/workflow keep working, just untinted
 * until added here. */
const STATUS_BADGE_MAP: Record<string, { label: string; tone: BadgeTone }> = {
  PENDING: { label: "Chờ duyệt", tone: "amber" },
  APPROVED: { label: "Đã nhận việc", tone: "green" },
  REJECTED: { label: "Không nhận", tone: "red" },
  WAITLIST: { label: "Dự phòng", tone: "blue" },
  ACTIVE: { label: "Đang hoạt động", tone: "green" },
  DRAFT: { label: "Nháp", tone: "gray" },
  EXPIRED: { label: "Hết hạn", tone: "gray" },
  PENDING_HR: { label: "Chờ HR xử lý", tone: "amber" },
  INACTIVE: { label: "Đã nghỉ việc", tone: "gray" },
  TRANSFER_COMPLETED: { label: "Đã chuyển bộ phận", tone: "green" },
  TRANSFER_RESCHEDULED: { label: "Đã hoãn", tone: "blue" },
  WAITING_DECISION: { label: "Chờ quyết định", tone: "amber" },
  CANCELLED: { label: "Đã huỷ", tone: "gray" },
  QUEUED: { label: "Trong hàng đợi", tone: "gray" },
  RUNNING: { label: "Đang xử lý", tone: "blue" },
  PAUSED: { label: "Tạm dừng", tone: "amber" },
  DONE: { label: "Hoàn tất", tone: "green" },
  FAILED: { label: "Thất bại", tone: "red" },
  SENT: { label: "Đã gửi", tone: "green" },
  SKIPPED: { label: "Đã bỏ qua", tone: "gray" },
  MATCHED: { label: "Khớp DW Data", tone: "green" },
  NEW: { label: "Mới", tone: "amber" },
  MISMATCH: { label: "Không khớp", tone: "red" },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const cfg = STATUS_BADGE_MAP[status] ?? { label: status, tone: "gray" as BadgeTone };
  return (
    <Badge tone={cfg.tone} dot className={className}>
      {cfg.label}
    </Badge>
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
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,360px)] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            "animate-slide-up flex items-start gap-2.5 rounded-[10px] border px-4 py-3 text-[13.5px] font-medium shadow-lg",
            t.variant === "destructive" ? "border-danger/25 bg-surface text-danger" : "border-border bg-surface text-fg",
          )}
        >
          {t.variant === "destructive" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
          )}
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
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
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
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-[10px] border bg-surface-raised px-3 text-left text-[14px] font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20",
          open ? "border-accent" : "border-border-strong",
          selected ? "text-fg" : "text-fg-muted",
        )}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown className={cn("ml-2 h-4 w-4 shrink-0 text-fg-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open && (
        <div role="listbox" className="animate-menu-in absolute z-50 mt-1 max-h-72 w-full overflow-hidden rounded-[10px] border border-border bg-surface shadow-lg">
          {options.length >= searchThreshold && (
            <div className="border-b border-border bg-surface-hover p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" aria-hidden />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Gõ để tìm nhanh..."
                  className="h-9 w-full rounded-[8px] border border-border bg-surface-raised pl-8 pr-3 text-[13px] outline-none focus:border-accent"
                />
              </div>
            </div>
          )}
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && <p className="p-3 text-center text-[12px] text-fg-muted">Không tìm thấy kết quả</p>}
            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                  setQuery("");
                }}
                className={cn(
                  "block w-full px-3 py-2 text-left text-[13.5px] font-medium hover:bg-surface-hover",
                  o.value === value && "bg-accent-tint text-accent",
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
  description,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  const titleId = React.useId();
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="animate-overlay-in fixed inset-0 z-[90] flex items-center justify-center bg-fg/40 p-4 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn("animate-fade-in-scale flex max-h-[88vh] w-full flex-col overflow-hidden rounded-[16px] bg-surface shadow-lg", width)}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h3 id={titleId} className="text-[16px] font-semibold text-fg">
              {title}
            </h3>
            {description ? <p className="mt-0.5 text-[12.5px] text-fg-muted">{description}</p> : null}
          </div>
          <IconButton label="Đóng" onClick={onClose} className="shrink-0">
            <X className="h-4 w-4" aria-hidden />
          </IconButton>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-border bg-surface px-6 py-4">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------------- ConfirmDialog ---------------- */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Xác nhận",
  cancelLabel = "Huỷ",
  danger = false,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        {danger ? (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger-tint text-danger">
            <AlertTriangle className="h-[18px] w-[18px]" aria-hidden />
          </div>
        ) : null}
        {description ? <p className="text-[13.5px] leading-relaxed text-fg-secondary">{description}</p> : null}
      </div>
    </Modal>
  );
}

/* ---------------- KpiCard ---------------- */
export function KpiCard({
  icon,
  label,
  value,
  context,
  tone = "primary",
  href,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  context?: React.ReactNode;
  tone?: "primary" | "success" | "warning" | "danger" | "info";
  href?: string;
  onClick?: () => void;
}) {
  const toneClass: Record<string, string> = {
    primary: "bg-primary-tint text-primary",
    success: "bg-success-tint text-success",
    warning: "bg-warning-tint text-warning",
    danger: "bg-danger-tint text-danger",
    info: "bg-info-tint text-info",
  };
  const clickable = Boolean(href || onClick);
  const cardClass = cn(
    "block rounded-[16px] border border-border bg-surface p-[18px] shadow-[0_1px_2px_rgba(23,32,18,0.04),0_8px_24px_rgba(23,32,18,0.05)] transition-[box-shadow,transform] duration-150",
    clickable && "cursor-pointer hover:-translate-y-[1px] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
  );
  const inner = (
    <>
      <div className={cn("flex h-8 w-8 items-center justify-center rounded-[9px] ring-1 ring-black/[0.03]", toneClass[tone])}>{icon}</div>
      <p className="mt-2.5 text-[28px] font-bold leading-none tracking-tight tabular-nums text-fg">{value}</p>
      <p className="mt-1.5 text-[12.5px] font-semibold text-fg-secondary">{label}</p>
      {context ? <p className="mt-0.5 text-[11.5px] text-fg-muted">{context}</p> : null}
    </>
  );

  if (href) {
    return (
      <a href={href} className={cardClass}>
        {inner}
      </a>
    );
  }
  return (
    <div onClick={onClick} className={cardClass}>
      {inner}
    </div>
  );
}

/* ============================================================
   V2 OPERATIONAL PRIMITIVES
   Compact metric strip / number tile / progress / alert panel /
   gender split / period bar — shared building blocks for the four
   pilot workspaces (dashboard, daily application, planning).
   ============================================================ */

export type Tone = "primary" | "success" | "warning" | "danger" | "info" | "accent";

const TONE_ICON: Record<Tone, string> = {
  primary: "bg-primary-tint text-primary",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  danger: "bg-danger-tint text-danger",
  info: "bg-info-tint text-info",
  accent: "bg-accent-tint text-accent",
};

const TONE_TEXT: Record<Tone, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  accent: "text-accent",
};

const TONE_FILL: Record<Tone, string> = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  accent: "bg-accent",
};

/** Compact inline metric: icon · value · label · context. Replaces the
 *  row of identical white KPI cards on operational screens. */
export function MetricStripItem({
  icon,
  value,
  label,
  context,
  tone = "primary",
}: {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  context?: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ring-1 ring-black/[0.03]", TONE_ICON[tone])}>{icon}</div>
      <div className="min-w-0">
        <p className="text-[20px] font-bold leading-none tracking-tight tabular-nums text-fg">{value}</p>
        <p className="mt-1 truncate text-[11.5px] font-semibold text-fg-secondary">{label}</p>
        {context ? <p className="mt-0.5 truncate text-[10.5px] text-fg-muted">{context}</p> : null}
      </div>
    </div>
  );
}

export function MetricStrip({ items, className }: { items: React.ReactElement<typeof MetricStripItem>[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap divide-y divide-border rounded-[16px] border border-border bg-surface shadow-[0_1px_2px_rgba(23,32,18,0.04),0_8px_24px_rgba(23,32,18,0.05)] sm:divide-x sm:divide-y-0", className)}>
      {items}
    </div>
  );
}

/** Big-number tile for dashboard snapshots (progress + context). */
export function NumberTile({
  icon,
  label,
  value,
  context,
  tone = "primary",
  progress,
  progressLabel,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  context?: React.ReactNode;
  tone?: Tone;
  progress?: number;
  progressLabel?: string;
}) {
  return (
    <div className="rounded-[16px] border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(23,32,18,0.04),0_8px_24px_rgba(23,32,18,0.05)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-fg-muted">{label}</p>
        {icon ? <div className={cn("flex h-7 w-7 items-center justify-center rounded-[8px]", TONE_ICON[tone])}>{icon}</div> : null}
      </div>
      <p className={cn("mt-2 text-[30px] font-bold leading-none tracking-tight tabular-nums", TONE_TEXT[tone])}>{value}</p>
      {context ? <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-secondary">{context}</p> : null}
      {typeof progress === "number" ? (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover" role="presentation">
            <div className={cn("h-full rounded-full transition-[width] duration-500", TONE_FILL[tone])} style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
          </div>
          {progressLabel ? <p className="mt-1 text-[10.5px] font-semibold text-fg-muted">{progressLabel}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Thin progress bar with optional label. */
export function ProgressBar({
  value,
  tone = "primary",
  trackClassName,
  barClassName,
  className,
}: {
  value: number;
  tone?: Tone;
  trackClassName?: string;
  barClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-hover", trackClassName, className)} role="presentation" aria-hidden>
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", TONE_FILL[tone], barClassName)}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

/** Two-segment gender bar (Nam = deep green, Nữ = orange). */
export function GenderSplit({
  male,
  female,
  height = 8,
  className,
}: {
  male: number;
  female: number;
  height?: number;
  className?: string;
}) {
  const total = Math.max(1, male + female);
  const malePct = (male / total) * 100;
  return (
    <div
      className={cn("flex w-full overflow-hidden rounded-full bg-surface-hover", className)}
      style={{ height }}
      role="presentation"
      aria-label={`Nam ${male}, Nữ ${female}`}
    >
      {male > 0 ? <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${malePct}%` }} /> : null}
      {female > 0 ? <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${100 - malePct}%` }} /> : null}
    </div>
  );
}

export function GenderLegend({ male, female }: { male: number; female: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] font-medium text-fg-secondary">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-primary" aria-hidden /> Nam {male}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-accent" aria-hidden /> Nữ {female}
      </span>
    </div>
  );
}

/** "Needs attention" alert panel — used for the dashboard focus strip. */
export function AlertPanel({
  tone = "warning",
  icon,
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  icon?: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-[16px] border p-4 sm:flex-row sm:items-center sm:gap-4",
        tone === "warning" && "border-warning/25 bg-warning-tint/70",
        tone === "danger" && "border-danger/25 bg-danger-tint/70",
        tone === "info" && "border-info/25 bg-info-tint/70",
        tone === "accent" && "border-accent/25 bg-accent-tint/70",
        tone === "success" && "border-success/25 bg-success-tint/70",
        tone === "primary" && "border-primary/20 bg-primary-tint/70",
        className,
      )}
    >
      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ring-1 ring-black/[0.03]", TONE_ICON[tone])}>{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-bold text-fg">{title}</p>
        {children ? <div className="mt-1 text-[12.5px] leading-relaxed text-fg-secondary">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Horizontal timeline bar for a planning period (start → end, today marker). */
export function PeriodBar({
  startDate,
  endDate,
  today = new Date().toISOString().slice(0, 10),
  tone = "primary",
  className,
}: {
  startDate: string;
  endDate: string;
  today?: string;
  tone?: "primary" | "success" | "warning";
  className?: string;
}) {
  const start = new Date(startDate + "T00:00:00").getTime();
  const end = new Date(endDate + "T00:00:00").getTime();
  const now = new Date(today + "T00:00:00").getTime();
  const span = Math.max(1, end - start);
  const pct = ((now - start) / span) * 100;
  const todayInside = now >= start && now <= end;
  const barColor = tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-primary";
  return (
    <div className={cn("relative h-1.5 w-full overflow-visible rounded-full bg-surface-hover", className)} aria-hidden>
      <div className={cn("h-full rounded-full", barColor)} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      {todayInside ? (
        <span className="absolute top-1/2 h-[9px] w-[2px] -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_2px_rgba(226,109,28,0.25)]" style={{ left: `${pct}%` }} />
      ) : null}
    </div>
  );
}

/* ---------------- Skeleton ---------------- */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn("skeleton", className)} style={style} aria-hidden />;
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="w-full" role="status" aria-label="Đang tải dữ liệu">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r} className="border-b border-border">
              {Array.from({ length: cols }).map((_, c) => (
                <td key={c} className="px-4 py-3.5">
                  <Skeleton className="h-3.5" style={{ width: `${55 + ((r + c) % 4) * 10}%` }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-[14px] border border-border bg-surface p-[18px]" role="status" aria-label="Đang tải">
      <Skeleton className="h-8 w-8 rounded-[8px]" />
      <Skeleton className="mt-3 h-7 w-16" />
      <Skeleton className="mt-2 h-3 w-24" />
    </div>
  );
}

export function SkeletonKpiRow({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

/* ---------------- EmptyState ---------------- */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon ? (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-success-tint text-success">{icon}</div>
      ) : null}
      <p className="text-[14px] font-semibold text-fg">{title}</p>
      {description ? <p className="mx-auto mt-1.5 max-w-[42ch] text-[13px] leading-relaxed text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/* ---------------- ErrorState ---------------- */
export function ErrorState({
  title = "Không thể tải dữ liệu",
  description = "Đã xảy ra lỗi khi tải dữ liệu. Vui lòng thử lại.",
  onRetry,
  retrying = false,
}: {
  title?: string;
  description?: React.ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-danger-tint text-danger">
        <AlertTriangle className="h-5 w-5" aria-hidden />
      </div>
      <p className="text-[14px] font-semibold text-fg">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[42ch] text-[13px] leading-relaxed text-fg-muted">{description}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry} loading={retrying}>
          Thử lại
        </Button>
      ) : null}
    </div>
  );
}

/* ---------------- RowMenu (overflow row actions) ---------------- */
export function RowMenu({
  items,
}: {
  items: {
    label: string;
    icon?: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
    separated?: boolean;
  }[];
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={ref} className="relative inline-block text-left">
      <IconButton label="Thêm tuỳ chọn" variant="outline" onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </IconButton>
      {open && (
        <div role="menu" className="animate-menu-in absolute right-0 z-40 mt-1 min-w-[176px] overflow-hidden rounded-[10px] border border-border bg-surface py-1 shadow-lg">
          {items.map((item) => (
            <React.Fragment key={item.label}>
              {item.separated ? <div role="separator" className="my-1 h-px bg-border" /> : null}
              <button
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  item.danger ? "text-danger hover:bg-danger-tint" : "text-fg hover:bg-surface-hover",
                )}
              >
                {item.icon ? <span className="shrink-0 opacity-80">{item.icon}</span> : null}
                <span className="flex-1">{item.label}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- SearchBar / FilterBar ---------------- */
export function SearchBar({
  value,
  onChange,
  placeholder = "Tìm kiếm...",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-[10px] border border-border-strong bg-surface-raised pl-9 pr-3 text-[14px] text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-accent/15"
      />
    </div>
  );
}

export function FilterBar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function FilterSelect({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-9 rounded-[9px] border border-border-strong bg-surface-raised px-2.5 text-[13px] font-medium text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/15",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
