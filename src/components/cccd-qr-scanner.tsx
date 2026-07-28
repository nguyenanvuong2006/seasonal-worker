"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Modal, toast } from "@/components/ui";
import { Camera, ImageUp, ScanLine } from "lucide-react";

/**
 * QUÉT QR CCCD (#11)
 * -------------------
 * Chuẩn QR trên CCCD gắn chip Việt Nam (Thông tư 59/2021/TT-BCA) là 1 chuỗi text
 * thuần, các trường cách nhau bằng dấu "|":
 *   Số CCCD|Số CMND cũ (nếu có)|Họ và tên|Ngày sinh (ddmmyyyy)|Giới tính|Địa chỉ thường trú|Ngày cấp (ddmmyyyy)
 * Toàn bộ việc giải mã chạy NGAY TRÊN TRÌNH DUYỆT bằng thư viện "jsqr" (JS thuần,
 * không gọi server, không cần API ngoài) — vì vậy hoạt động được cả với camera
 * điện thoại/laptop lẫn ảnh tải lên, và không lưu ảnh CCCD ở đâu cả (đúng yêu cầu
 * "Không lưu ảnh nếu không cần" — ảnh chỉ tồn tại tạm trong bộ nhớ trình duyệt để
 * giải mã rồi bỏ đi ngay, không upload lên server).
 */

export type CccdQrData = {
  cccd: string;
  fullName: string;
  dob: string; // yyyy-mm-dd
  gender: string;
  address: string;
  issueDate: string; // yyyy-mm-dd
};

function parseCccdQr(text: string): CccdQrData | null {
  const parts = text.split("|");
  if (parts.length < 6) return null;
  const [cccd, , fullName, dobRaw, gender, address, issueDateRaw] = parts;
  if (!/^\d{9,12}$/.test(cccd)) return null;
  const toIso = (d: string) => {
    const m = d?.match(/^(\d{2})(\d{2})(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
  };
  return {
    cccd,
    fullName: (fullName || "").trim(),
    dob: toIso(dobRaw || ""),
    gender: (gender || "").trim(),
    address: (address || "").trim(),
    issueDate: toIso(issueDateRaw || ""),
  };
}

export function CccdQrScanner({ onResult }: { onResult: (data: CccdQrData) => void }) {
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopCamera = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  };

  const handleDecoded = (data: CccdQrData) => {
    stopCamera();
    setOpen(false);
    onResult(data);
    toast({ title: `✅ Đã đọc CCCD ${data.cccd} — tự động điền thông tin` });
  };

  const tryDecodeFrame = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      rafRef.current = requestAnimationFrame(tryDecodeFrame);
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const jsQR = (await import("jsqr")).default;
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    if (code) {
      const parsed = parseCccdQr(code.data);
      if (parsed) {
        handleDecoded(parsed);
        return;
      }
    }
    rafRef.current = requestAnimationFrame(tryDecodeFrame);
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setScanning(true);
      rafRef.current = requestAnimationFrame(tryDecodeFrame);
    } catch {
      toast({ title: "Không truy cập được camera — hãy dùng cách tải ảnh lên thay thế", variant: "destructive" });
    }
  };

  const handleFileUpload = async (file: File) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const jsQR = (await import("jsqr")).default;
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      URL.revokeObjectURL(url);
      if (!code) {
        toast({ title: "Không đọc được mã QR trong ảnh này", variant: "destructive" });
        return;
      }
      const parsed = parseCccdQr(code.data);
      if (!parsed) {
        toast({ title: "Mã QR không đúng định dạng CCCD", variant: "destructive" });
        return;
      }
      handleDecoded(parsed);
    };
    img.src = url;
  };

  useEffect(() => {
    if (!open) stopCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
          <canvas ref={canvasRef} className="hidden" />
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
