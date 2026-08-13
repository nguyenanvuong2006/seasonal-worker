"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImageOff, Loader2, Sparkles, Trash2, UploadCloud } from "lucide-react";
import { Button, Card, CardContent, CardHeader, FormField, Input, Textarea, toast } from "@/components/ui";

const MAX_SLOGAN_LENGTH = 160;
const MAX_SUBTITLE_LENGTH = 160;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

type BrandingRow = {
  yearThemeImage: string | null;
  yearSlogan: string | null;
  themeYear: string | null;
  themeSubtitle: string | null;
  updatedAt?: string;
  updatedBy?: string | null;
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function BrandingSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [row, setRow] = useState<BrandingRow | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [slogan, setSlogan] = useState("");
  const [themeYear, setThemeYear] = useState("");
  const [themeSubtitle, setThemeSubtitle] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/branding");
    if (res.ok) {
      const data = await res.json();
      const r: BrandingRow = data.row;
      setRow(r);
      setImagePreview(r.yearThemeImage);
      setSlogan(r.yearSlogan ?? "");
      setThemeYear(r.themeYear ?? "");
      setThemeSubtitle(r.themeSubtitle ?? "");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast({ title: "Chỉ chấp nhận ảnh PNG, JPEG hoặc WEBP.", variant: "destructive" });
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast({ title: "Ảnh quá lớn — vui lòng chọn ảnh dưới 2MB.", variant: "destructive" });
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    setImagePreview(dataUrl);
  };

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/branding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Lưu thất bại.", variant: "destructive" });
        return false;
      }
      setRow(data.row);
      toast({ title: "Đã lưu cấu hình Thương hiệu & Chủ đề năm." });
      return true;
    } finally {
      setSaving(false);
    }
  };

  const saveImage = () => save({ yearThemeImage: imagePreview });
  const removeImage = async () => {
    const ok = await save({ yearThemeImage: null });
    if (ok) setImagePreview(null);
  };
  const saveText = () =>
    save({ yearSlogan: slogan, themeYear: themeYear, themeSubtitle: themeSubtitle });

  const imageChanged = imagePreview !== (row?.yearThemeImage ?? null);
  const textChanged =
    slogan !== (row?.yearSlogan ?? "") ||
    themeYear !== (row?.themeYear ?? "") ||
    themeSubtitle !== (row?.themeSubtitle ?? "");

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" aria-hidden />
            Thương hiệu &amp; Chủ đề năm
          </span>
        }
        subtitle="Cấu hình ảnh chủ đề và slogan hiển thị trên trang đăng nhập, sidebar và Dashboard. Không ảnh hưởng logo chính thức của Dalat Hasfarm."
      />
      <CardContent className="space-y-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Đang tải cấu hình…
          </div>
        ) : (
          <>
            <div>
              <p className="mb-2 text-[13px] font-semibold text-fg">Ảnh chủ đề năm (Year Theme Image)</p>
              <div className="flex flex-wrap items-start gap-4">
                <div className="flex h-28 w-48 shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-dashed border-border-strong bg-surface-hover">
                  {imagePreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imagePreview} alt="Xem trước ảnh chủ đề năm" className="h-full w-full object-contain" />
                  ) : (
                    <div className="flex flex-col items-center gap-1 text-fg-muted">
                      <ImageOff className="h-6 w-6" aria-hidden />
                      <span className="text-[11px]">Chưa cấu hình</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={onPickImage}
                    aria-label="Chọn ảnh chủ đề năm"
                  />
                  <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                    <UploadCloud className="h-4 w-4" aria-hidden />
                    {row?.yearThemeImage || imagePreview ? "Thay ảnh khác" : "Tải ảnh lên"}
                  </Button>
                  {imagePreview ? (
                    <Button variant="ghost" size="sm" onClick={removeImage} disabled={saving}>
                      <Trash2 className="h-4 w-4" aria-hidden /> Gỡ ảnh
                    </Button>
                  ) : null}
                  {imageChanged ? (
                    <Button size="sm" onClick={saveImage} loading={saving}>
                      Lưu ảnh
                    </Button>
                  ) : null}
                  <p className="max-w-[32ch] text-[11.5px] text-fg-muted">
                    PNG/JPEG/WEBP, tối đa 2MB. Nếu không cấu hình, giao diện vẫn hiển thị bình thường (không có
                    khung ảnh vỡ).
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Năm chủ đề (tuỳ chọn)" helper="Ví dụ: 2026">
                <Input value={themeYear} onChange={(e) => setThemeYear(e.target.value)} placeholder="2026" maxLength={4} />
              </FormField>
              <FormField label="Phụ đề chủ đề (tuỳ chọn)" helper={`${themeSubtitle.length}/${MAX_SUBTITLE_LENGTH} ký tự`}>
                <Input
                  value={themeSubtitle}
                  onChange={(e) => setThemeSubtitle(e.target.value.slice(0, MAX_SUBTITLE_LENGTH))}
                  placeholder="Ví dụ: Mùa vụ 2026"
                />
              </FormField>
            </div>

            <FormField label="Slogan năm" helper={`${slogan.length}/${MAX_SLOGAN_LENGTH} ký tự — hiển thị nổi bật trên trang đăng nhập.`}>
              <Textarea
                value={slogan}
                onChange={(e) => setSlogan(e.target.value.slice(0, MAX_SLOGAN_LENGTH))}
                rows={2}
                placeholder="Ví dụ: Cùng Dalat Hasfarm vun đắp mùa vụ bội thu 2026"
              />
            </FormField>

            <div className="flex justify-end">
              <Button onClick={saveText} loading={saving} disabled={!textChanged}>
                Lưu Slogan &amp; Năm chủ đề
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
