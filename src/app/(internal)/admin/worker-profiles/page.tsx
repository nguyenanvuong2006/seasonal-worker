"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button, Card, CardContent, EmptyState, Input, PageHeader, toast } from "@/components/ui";
import { RefreshCw, Search, UserX } from "lucide-react";
import { CCCD_ERROR_MESSAGE, isValidCccd } from "@/lib/validators";

type SearchResult = { workerId: string; fullName: string; cccdMasked: string; phoneMasked: string | null };

/**
 * "Hồ sơ Tập nghề" — canonical entry point for a person's 360° profile
 * (PR follow-up mission, 2026-09-10+). This page is now SEARCH ONLY: it
 * never renders profile detail inline (that moved to the canonical
 * /admin/worker-profiles/[workerId] route, addressed by the OPAQUE
 * worker_profiles.id — never CCCD/phone in a URL). Two search paths:
 *   - exact CCCD (pre-existing, via the CCCD-keyed /api/worker-profiles/[cccd]
 *     lookup — kept unchanged so existing deep-links/workflows never break)
 *   - name/phone fuzzy search (new, /api/worker-profiles/search — mirrors
 *     global-search's own worker_profile.view scoping/masking rules)
 */
export default function WorkerProfilesPage() {
  const searchParams = useSearchParams();
  const [cccd, setCccd] = useState(() => searchParams.get("cccd") ?? "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [searched, setSearched] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const searchByCccd = async (value: string) => {
    if (!isValidCccd(value)) {
      toast({ title: CCCD_ERROR_MESSAGE, variant: "destructive" });
      return;
    }
    setLoading(true);
    setNotFound(false);
    setSearched(true);
    try {
      const res = await fetch(`/api/worker-profiles/${value.trim()}`);
      if (!res.ok) {
        setResults([]);
        setNotFound(true);
        return;
      }
      const data = await res.json();
      setResults([{ workerId: data.profile.id, fullName: data.profile.fullName, cccdMasked: data.profile.cccd, phoneMasked: data.profile.phone ?? null }]);
    } finally {
      setLoading(false);
    }
  };

  const searchByName = async () => {
    if (query.trim().length < 2) {
      toast({ title: "Nhập ít nhất 2 ký tự để tìm kiếm.", variant: "destructive" });
      return;
    }
    setLoading(true);
    setNotFound(false);
    setSearched(true);
    try {
      const res = await fetch(`/api/worker-profiles/search?q=${encodeURIComponent(query.trim())}`);
      const data = await res.json();
      const found: SearchResult[] = data.results ?? [];
      setResults(found);
      setNotFound(found.length === 0);
    } finally {
      setLoading(false);
    }
  };

  // Deep-link từ Tìm kiếm toàn hệ thống (?cccd=...) — tự tra cứu ngay khi vào trang
  useEffect(() => {
    if (searchParams.get("cccd")) void searchByCccd(searchParams.get("cccd")!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runBackfill = async () => {
    setBackfilling(true);
    try {
      const res = await fetch("/api/admin/worker-profiles/backfill", { method: "POST" });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Lỗi đồng bộ", variant: "destructive" });
        return;
      }
      toast({
        title: `Đã đồng bộ: ${d.profilesFromApps} hồ sơ Tập nghề, ${d.sessionsCreated} đợt Tập nghề mới được liên kết`,
      });
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Hồ sơ Tập nghề (Digital Internship Profile)"
        description="Mỗi người tập nghề chỉ có 1 hồ sơ duy nhất, gộp toàn bộ lịch sử các lần đăng ký và đợt Tập nghề — không tạo trùng hồ sơ mỗi khi quay lại."
        actions={
          <Button variant="outline" onClick={runBackfill} loading={backfilling}>
            <RefreshCw className="h-4 w-4" /> Đồng bộ dữ liệu cũ
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex flex-wrap gap-2">
            <Input
              value={cccd}
              inputMode="numeric"
              maxLength={12}
              onChange={(e) => setCccd(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && searchByCccd(cccd)}
              placeholder="Nhập đúng số CCCD..."
              className="h-11 flex-1 basis-64"
            />
            <Button onClick={() => searchByCccd(cccd)} loading={loading}>
              <Search className="h-4 w-4" /> Tra cứu theo CCCD
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchByName()}
              placeholder="Hoặc tìm theo họ tên / số điện thoại..."
              className="h-11 flex-1 basis-64"
            />
            <Button variant="outline" onClick={searchByName} loading={loading}>
              <Search className="h-4 w-4" /> Tìm theo tên/SĐT
            </Button>
          </div>
        </CardContent>
      </Card>

      {notFound && searched && (
        <Card>
          <EmptyState
            icon={<UserX className="h-5 w-5" aria-hidden />}
            title="Không tìm thấy hồ sơ Tập nghề"
            description="Chưa có hồ sơ Tập nghề điện tử khớp với thông tin tìm kiếm, hoặc nằm ngoài phạm vi dữ liệu được cấp."
          />
        </Card>
      )}

      {results.length > 0 && (
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {results.map((r) => (
              <li key={r.workerId} className="flex items-center justify-between gap-3 p-4 text-sm">
                <div>
                  <p className="font-semibold text-fg">{r.fullName}</p>
                  <p className="text-[12.5px] text-fg-muted">
                    CCCD: {r.cccdMasked}
                    {r.phoneMasked && ` • SĐT: ${r.phoneMasked}`}
                  </p>
                </div>
                <Link href={`/admin/worker-profiles/${r.workerId}`} className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-semibold text-accent hover:bg-surface-hover">
                  Xem hồ sơ →
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
