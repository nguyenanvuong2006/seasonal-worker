"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Search, X } from "lucide-react";
import { cn } from "@/components/ui";
import { STATUS_META } from "@/lib/helpers";

const DEBOUNCE_MS = 320;
const MIN_QUERY_LENGTH = 2;

type SearchItem = { id: string; title: string; subtitle: string; status?: string; href: string };
type SearchGroup = { type: string; label: string; items: SearchItem[] };

function statusLabel(status?: string) {
  if (!status) return null;
  return STATUS_META[status]?.label ?? status;
}

export function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [groups, setGroups] = useState<SearchGroup[] | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  const flatItems = useMemo(() => (groups ?? []).flatMap((g) => g.items), [groups]);

  const runSearch = useCallback(async (q: string) => {
    const myReqId = ++reqIdRef.current;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/global-search?q=${encodeURIComponent(q)}`);
      if (myReqId !== reqIdRef.current) return; // trả lời cũ tới sau — bỏ qua, tránh nháy kết quả sai
      if (!res.ok) {
        setError(true);
        setGroups(null);
        return;
      }
      const data = await res.json();
      setGroups(data.groups ?? []);
    } catch {
      if (myReqId === reqIdRef.current) {
        setError(true);
        setGroups(null);
      }
    } finally {
      if (myReqId === reqIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setGroups(null);
      setLoading(false);
      setError(false);
      return;
    }
    debounceRef.current = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  // Ctrl/Cmd+K hoặc "/" (khi không đang gõ ở ô nhập khác) — mở & focus ô tìm kiếm.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isTypingElsewhere =
        document.activeElement instanceof HTMLElement &&
        ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) &&
        document.activeElement !== inputRef.current;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !isTypingElsewhere)) {
        e.preventDefault();
        setMobileExpanded(true);
        setOpen(true);
        inputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        if (!query) setMobileExpanded(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [query]);

  const closeAndClear = () => {
    setOpen(false);
    setQuery("");
    setGroups(null);
    setMobileExpanded(false);
  };

  const goTo = (item: SearchItem) => {
    closeAndClear();
    router.push(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAndClear();
      inputRef.current?.blur();
      return;
    }
    if (!open || flatItems.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flatItems[activeIndex] ?? flatItems[0];
      if (item) goTo(item);
    }
  };

  const showPanel = open && query.trim().length >= MIN_QUERY_LENGTH;

  return (
    <div ref={rootRef} className={cn("relative", mobileExpanded ? "flex-1" : "shrink-0")}>
      {/* Mobile: icon-only trigger, mở rộng thành ô nhập khi bấm */}
      {!mobileExpanded && (
        <button
          type="button"
          onClick={() => {
            setMobileExpanded(true);
            setOpen(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          aria-label="Tìm kiếm toàn hệ thống"
          className="flex h-9 w-9 items-center justify-center rounded-full text-fg-secondary hover:bg-surface-hover hover:text-fg sm:hidden"
        >
          <Search className="h-[18px] w-[18px]" aria-hidden />
        </button>
      )}

      <div className={cn(mobileExpanded ? "block" : "hidden sm:block", "relative")}>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-haspopup="listbox"
          aria-controls="global-search-results"
          aria-label="Tìm lao động, CCCD, bộ phận, hồ sơ"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Tìm lao động, CCCD, bộ phận, hồ sơ... (Ctrl+K)"
          className="h-9 w-full rounded-full border border-border-strong bg-surface pl-9 pr-8 text-[13.5px] text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-primary focus:ring-2 focus:ring-primary/15 sm:w-72 lg:w-96"
        />
        {(query || mobileExpanded) && (
          <button
            type="button"
            onClick={closeAndClear}
            aria-label="Xoá tìm kiếm"
            className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-fg-muted hover:bg-surface-hover hover:text-fg sm:hidden"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

      {showPanel && (
        <div
          id="global-search-results"
          role="listbox"
          aria-label="Kết quả tìm kiếm"
          className="animate-menu-in absolute left-0 right-0 z-50 mt-2 max-h-[70vh] overflow-y-auto rounded-[12px] border border-border bg-surface shadow-lg sm:w-[420px]"
        >
          {loading && !groups ? (
            <div className="flex items-center gap-2 p-4 text-[13px] text-fg-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Đang tìm…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-2 p-5 text-center">
              <AlertTriangle className="h-5 w-5 text-danger" aria-hidden />
              <p className="text-[13px] text-fg-secondary">Không thể tải kết quả tìm kiếm.</p>
              <button
                type="button"
                onClick={() => void runSearch(query.trim())}
                className="text-[12.5px] font-semibold text-primary hover:underline"
              >
                Thử lại
              </button>
            </div>
          ) : !groups || groups.length === 0 ? (
            <p className="p-5 text-center text-[13px] text-fg-muted">Không tìm thấy kết quả</p>
          ) : (
            <div className="py-1.5">
              {groups.map((g) => (
                <div key={g.type} className="mb-1 last:mb-0">
                  <p className="px-3.5 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-wider text-fg-muted">{g.label}</p>
                  {g.items.map((item) => {
                    const flatIndex = flatItems.findIndex((f) => f === item);
                    const active = flatIndex === activeIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => setActiveIndex(flatIndex)}
                        onClick={() => goTo(item)}
                        className={cn(
                          "flex w-full flex-col items-start gap-0.5 px-3.5 py-2 text-left transition-colors",
                          active ? "bg-primary-tint" : "hover:bg-surface-hover",
                        )}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="truncate text-[13.5px] font-semibold text-fg">{item.title}</span>
                          {item.status ? (
                            <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[10.5px] font-semibold text-fg-secondary">
                              {statusLabel(item.status)}
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-[12px] text-fg-muted">{item.subtitle}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
