"use client";

/**
 * QUÉT QR CCCD — phiên bản ZXing
 * -------------------------------
 * Chuẩn QR trên CCCD gắn chip Việt Nam (Thông tư 59/2021/TT-BCA) là 1 chuỗi text
 * thuần, các trường cách nhau bằng dấu "|":
 *   Số CCCD|Số CMND cũ (nếu có)|Họ và tên|Ngày sinh (ddmmyyyy)|Giới tính|Địa chỉ thường trú|Ngày cấp (ddmmyyyy)
 *
 * Toàn bộ việc giải mã chạy NGAY TRÊN TRÌNH DUYỆT bằng "@zxing/browser" +
 * "@zxing/library" — không gọi server, không lưu ảnh CCCD ở đâu cả. ZXing tự
 * quản lý vòng lặp đọc khung hình video (không tự viết scan loop / vẽ canvas
 * thủ công như trước), nên ổn định hơn trên Android Chrome, Samsung Internet,
 * iPhone Safari và camera laptop.
 *
 * ZXing chỉ được tải (dynamic import) khi người dùng thực sự bấm "Quét QR
 * CCCD" / bật camera / tải ảnh lên — không nằm trong bundle tải trang ban đầu.
 */

// ============================== Imports ==============================
import { useEffect, useRef, useState } from "react";
import { Button, Modal, toast } from "@/components/ui";
import { Camera, ImageUp, ScanLine } from "lucide-react";

// ============================== Types ==============================
export type CccdQrData = {
  cccd: string;
  fullName: string;
  dob: string; // yyyy-MM-dd
  gender: string;
  address: string;
  issueDate: string; // yyyy-MM-dd
};

// Chỉ import KIỂU (type-only) — bị xoá hoàn toàn lúc build, không kéo theo
// runtime code của ZXing vào bundle ban đầu.
type ZxingBrowserModule = typeof import("@zxing/browser");
type ScannerControls = import("@zxing/browser").IScannerControls;
type DecodeResult = import("@zxing/library").Result;

// ============================== Parser ==============================
function toIsoDate(raw: string): string {
  const m = raw?.match(/^(\d{2})(\d{2})(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

function parseCccdQr(text: string): CccdQrData | null {
  const parts = text.split("|");
  if (parts.length < 6) return null;
  const [cccd, , fullName, dobRaw, gender, address, issueDateRaw] = parts;
  if (!/^\d{9,12}$/.test(cccd)) return null;
  return {
    cccd,
    fullName: (fullName || "").trim(),
    dob: toIsoDate(dobRaw || ""),
    gender: (gender || "").trim(),
    address: (address || "").trim(),
    issueDate: toIsoDate(issueDateRaw || ""),
  };
}

// ============================== Camera manager ==============================
// Chọn camera ưu tiên: camera sau (facingMode environment, nhận diện qua label
// thiết bị) — nếu không xác định được thì lấy camera đầu tiên trong danh sách.
async function pickPreferredDeviceId(zxing: ZxingBrowserModule): Promise<string | undefined> {
  try {
    const devices = await zxing.BrowserMultiFormatReader.listVideoInputDevices();
    if (devices.length === 0) return undefined;
    const rear = devices.find((d) => /back|rear|environment|sau/i.test(d.label));
    return (rear ?? devices[0]).deviceId;
  } catch {
    return undefined;
  }
}

// Bật autofocus liên tục nếu thiết bị/trình duyệt hỗ trợ — không throw nếu
// không hỗ trợ (nhiều laptop/browser không expose focusMode).
async function applyContinuousFocus(track: MediaStreamTrack | undefined) {
  if (!track) return;
  try {
    const capabilities = track.getCapabilities?.();
    const supportsContinuousFocus = (capabilities as { focusMode?: string[] } | undefined)?.focusMode?.includes(
      "continuous",
    );
    if (supportsContinuousFocus) {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] } as MediaTrackConstraints);
    }
  } catch {
    // Thiết bị không hỗ trợ điều khiển focus — bỏ qua, không ảnh hưởng việc quét.
  }
}

function getActiveVideoTrack(video: HTMLVideoElement | null): MediaStreamTrack | undefined {
  const stream = video?.srcObject as MediaStream | null;
  return stream?.getVideoTracks()[0];
}

// ============================== Component ==============================
export function CccdQrScanner({ onResult }: { onResult: (data: CccdQrData) => void }) {
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<InstanceType<ZxingBrowserModule["BrowserMultiFormatReader"]> | null>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  const torchTrackRef = useRef<MediaStreamTrack | null>(null);

  const handleDecoded = (rawText: string) => {
    const parsed = parseCccdQr(rawText);
    if (!parsed) {
      toast({ title: "Mã QR không đúng định dạng CCCD", variant: "destructive" });
      return;
    }
    stopCamera();
    setOpen(false);
    onResult(parsed);
    toast({ title: `✅ Đã đọc CCCD ${parsed.cccd} — tự động điền thông tin` });
  };

  // ---------- ZXing scanner (camera) ----------
  const startCamera = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const zxing: ZxingBrowserModule = await import("@zxing/browser");
      const reader = new zxing.BrowserMultiFormatReader();
      readerRef.current = reader;

      const deviceId = await pickPreferredDeviceId(zxing);

      const controls = await reader.decodeFromVideoDevice(
        deviceId,
        videoRef.current ?? undefined,
        (result: DecodeResult | undefined) => {
          // Callback này được ZXing gọi liên tục mỗi khung hình; khi chưa đọc
          // được QR nó trả về undefined kèm NotFoundException — bỏ qua, không
          // phải lỗi thật, không toast, không throw ra UI.
          if (result) handleDecoded(result.getText());
        },
      );
      controlsRef.current = controls;

      const track = getActiveVideoTrack(videoRef.current);
      torchTrackRef.current = track ?? null;
      await applyContinuousFocus(track);
    } catch {
      setScanning(false);
      toast({ title: "Không truy cập được camera — hãy dùng cách tải ảnh lên thay thế", variant: "destructive" });
    }
  };

  // Bật/tắt đèn flash (torch) nếu thiết bị hỗ trợ — API được chuẩn bị sẵn để
  // gắn nút bật đèn sau này, chưa thay đổi giao diện hiện tại.
  const setTorch = async (on: boolean) => {
    const track = torchTrackRef.current;
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] } as MediaTrackConstraints);
    } catch {
      // Thiết bị không hỗ trợ torch — bỏ qua, không throw ra UI.
    }
  };
  void setTorch;

  // ---------- Upload image scanner ----------
  const handleFileUpload = async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const zxing: ZxingBrowserModule = await import("@zxing/browser");
      const reader = new zxing.BrowserMultiFormatReader();
      const result = await reader.decodeFromImageUrl(url);
      handleDecoded(result.getText());
    } catch {
      toast({ title: "Không đọc được mã QR trong ảnh này", variant: "destructive" });
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  // ---------- Cleanup ----------
  const stopCamera = () => {
    try {
      controlsRef.current?.stop();
    } catch {
      // đã dừng rồi hoặc không còn control hợp lệ — bỏ qua.
    }
    try {
      readerRef.current?.reset();
    } catch {
      // không có reader đang chạy — bỏ qua.
    }
    // Phòng hờ: đảm bảo mọi track của MediaStream đang gắn vào <video> đều
    // được dừng hẳn, không để camera chạy nền dù ZXing đã tự dọn dẹp.
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;

    controlsRef.current = null;
    readerRef.current = null;
    torchTrackRef.current = null;
    setScanning(false);
  };

  useEffect(() => {
    if (!open) stopCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ============================== UI ==============================
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-[56px] items-center gap-2 rounded-[14px] border-2 border-hasfarm-700 bg-white px-4 text-sm font-bold text-hasfarm-700 hover:bg-hasfarm-50"
      >
        <ScanLine className="h-5 w-5" /> Quét QR CCCD
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Quét mã QR mặt sau CCCD">
        <div className="space-y-4">
          <p className="text-xs text-gray-500">
            Đưa mã QR ở mặt sau thẻ CCCD vào khung camera, hoặc tải ảnh chụp CCCD lên. Hệ thống chỉ đọc dữ liệu để
            điền form — không lưu ảnh.
          </p>
          <div className="overflow-hidden rounded-xl bg-black">
            <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={startCamera} disabled={scanning} className="gap-2">
              <Camera className="h-4 w-4" /> {scanning ? "Đang quét..." : "Bật camera"}
            </Button>
            <label className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full border-2 border-hasfarm-700 text-sm font-bold text-hasfarm-700 hover:bg-hasfarm-50">
              <ImageUp className="h-4 w-4" /> Tải ảnh lên
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f);
                }}
              />
            </label>
          </div>
        </div>
      </Modal>
    </>
  );
}
