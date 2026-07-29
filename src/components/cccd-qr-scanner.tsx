"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Modal, toast } from "@/components/ui";
import {
  Camera,
  ImageUp,
  ScanLine,
  Loader2,
} from "lucide-react";

export type CccdQrData = {
  cccd: string;
  fullName: string;
  dob: string;
  gender: string;
  address: string;
  issueDate: string;
};

type DecodeResult = {
  rawText: string;
  data: CccdQrData;
};

function toIsoDate(value?: string) {
  if (!value) return "";

  const m = value.match(/^(\d{2})(\d{2})(\d{4})$/);

  if (!m) return "";

  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseCccdQr(text: string): CccdQrData | null {
  const parts = text.split("|");

  if (parts.length < 6) return null;

  const [
    cccd,
    ,
    fullName,
    dob,
    gender,
    address,
    issueDate,
  ] = parts;

  if (!/^\d{9,12}$/.test(cccd.trim())) {
    return null;
  }

  return {
    cccd: cccd.trim(),
    fullName: (fullName ?? "").trim(),
    dob: toIsoDate(dob),
    gender: (gender ?? "").trim(),
    address: (address ?? "").trim(),
    issueDate: toIsoDate(issueDate),
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadJsQR() {
  return (await import("jsqr")).default;
}

function drawToCanvas(
  source: HTMLVideoElement | HTMLImageElement,
  canvas: HTMLCanvasElement,
  crop = false
) {
  const ctx = canvas.getContext("2d");

  if (!ctx) return;

  const sw =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source.width;

  const sh =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source.height;

  if (!crop) {
    canvas.width = sw;
    canvas.height = sh;

    ctx.drawImage(source, 0, 0);

    return;
  }

  const size = Math.min(sw, sh) * 0.7;

  const sx = (sw - size) / 2;
  const sy = (sh - size) / 2;

  canvas.width = size;
  canvas.height = size;

  ctx.drawImage(
    source,
    sx,
    sy,
    size,
    size,
    0,
    0,
    size,
    size
  );
}

async function decodeBarcodeDetector(
  canvas: HTMLCanvasElement
): Promise<string | null> {
  if (!("BarcodeDetector" in window)) {
    return null;
  }

  try {
    // @ts-ignore
    const detector = new BarcodeDetector({
      formats: ["qr_code"],
    });

    const result =
      await detector.detect(canvas);

    if (!result.length) return null;

    return result[0].rawValue ?? null;
  } catch {
    return null;
  }
}

async function decodeJsQR(
  canvas: HTMLCanvasElement
): Promise<string | null> {
  const ctx = canvas.getContext("2d");

  if (!ctx) return null;

  const image = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height
  );

  const jsQR = await loadJsQR();

  const code = jsQR(
    image.data,
    image.width,
    image.height,
    {
      inversionAttempts: "attemptBoth",
    }
  );

  return code?.data ?? null;
}

async function decodeCanvas(
  canvas: HTMLCanvasElement
): Promise<DecodeResult | null> {
  let text = await decodeBarcodeDetector(canvas);

  if (!text) {
    text = await decodeJsQR(canvas);
  }

  if (!text) return null;

  const parsed = parseCccdQr(text);

  if (!parsed) return null;

  return {
    rawText: text,
    data: parsed,
  };
}

async function enhanceAndDecode(
  canvas: HTMLCanvasElement
): Promise<DecodeResult | null> {
  let result = await decodeCanvas(canvas);

  if (result) return result;

  const ctx = canvas.getContext("2d");

  if (!ctx) return null;

  const img = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height
  );

  const pixels = img.data;

  for (let i = 0; i < pixels.length; i += 4) {
    const gray =
      pixels[i] * 0.299 +
      pixels[i + 1] * 0.587 +
      pixels[i + 2] * 0.114;

    const bw = gray > 145 ? 255 : 0;

    pixels[i] = bw;
    pixels[i + 1] = bw;
    pixels[i + 2] = bw;
  }

  ctx.putImageData(img, 0, 0);

  result = await decodeCanvas(canvas);

  return result;
}

async function setupCamera(
  video: HTMLVideoElement
): Promise<MediaStream> {
  const stream =
    await navigator.mediaDevices.getUserMedia({
      audio: false,

      video: {
        facingMode: {
          ideal: "environment",
        },

        width: {
          ideal: 1920,
        },

        height: {
          ideal: 1080,
        },
      },
    });

  video.srcObject = stream;

  await video.play();

  const track =
    stream.getVideoTracks()[0];

  const caps: any =
    track.getCapabilities?.() ?? {};

  const settings: any = {};

  if (caps.focusMode?.includes("continuous")) {
    settings.focusMode = "continuous";
  }

  if (
    typeof caps.zoom?.max === "number"
  ) {
    settings.zoom = Math.min(
      2,
      caps.zoom.max
    );
  }

  try {
    if (Object.keys(settings).length) {
      await track.applyConstraints({
        advanced: [settings],
      });
    }
  } catch {}

  return stream;
}

async function scanVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement
): Promise<DecodeResult | null> {
  drawToCanvas(
    video,
    canvas,
    true
  );

  let result =
    await enhanceAndDecode(canvas);

  if (result) return result;

  drawToCanvas(
    video,
    canvas,
    false
  );

  result =
    await enhanceAndDecode(canvas);

  return result;
}

export function CccdQrScanner({
  onResult,
}: {
  onResult: (data: CccdQrData) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loadingCamera, setLoadingCamera] = useState(false);
  const [scanning, setScanning] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);

  const stopCamera = () => {
    runningRef.current = false;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });

    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    setScanning(false);
    setLoadingCamera(false);
  };

  const handleSuccess = (result: DecodeResult) => {
    stopCamera();

    setOpen(false);

    onResult(result.data);

    toast({
      title: "Đã đọc thành công mã QR CCCD",
      description: result.data.fullName,
    });
  };

  const scanLoop = async () => {
    if (!runningRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (
      !video ||
      !canvas ||
      video.readyState !== video.HAVE_ENOUGH_DATA
    ) {
      rafRef.current =
        requestAnimationFrame(scanLoop);

      return;
    }

    try {
      const result =
        await scanVideoFrame(video, canvas);

      if (result) {
        handleSuccess(result);
        return;
      }
    } catch {}

    await sleep(60);

    rafRef.current =
      requestAnimationFrame(scanLoop);
  };

  const startCamera = async () => {
    if (runningRef.current) return;

    const video = videoRef.current;

    if (!video) return;

    try {
      setLoadingCamera(true);

      const stream =
        await setupCamera(video);

      streamRef.current = stream;

      runningRef.current = true;

      setLoadingCamera(false);
      setScanning(true);

      rafRef.current =
        requestAnimationFrame(scanLoop);
    } catch {
      setLoadingCamera(false);

      toast({
        title: "Không thể mở camera",
        description:
          "Hãy kiểm tra quyền truy cập camera hoặc sử dụng chức năng tải ảnh.",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    if (!open) {
      stopCamera();
    }

    return () => stopCamera();
  }, [open]);

  const handleImageUpload = async (file: File) => {
    try {
      const url = URL.createObjectURL(file);

      const img = new Image();

      img.onload = async () => {
        try {
          const canvas =
            document.createElement("canvas");

          // Lần 1: Ảnh gốc
          drawToCanvas(
            img,
            canvas,
            false
          );

          let result =
            await enhanceAndDecode(canvas);

          // Lần 2: Crop vùng giữa
          if (!result) {
            drawToCanvas(
              img,
              canvas,
              true
            );

            result =
              await enhanceAndDecode(canvas);
          }

          // Lần 3: Thu nhỏ nếu ảnh quá lớn
          if (!result) {
            const ctx =
              canvas.getContext("2d");

            if (ctx) {
              const max = 1200;

              const ratio = Math.min(
                max / img.width,
                max / img.height,
                1
              );

              canvas.width =
                img.width * ratio;

              canvas.height =
                img.height * ratio;

              ctx.drawImage(
                img,
                0,
                0,
                canvas.width,
                canvas.height
              );

              result =
                await enhanceAndDecode(
                  canvas
                );
            }
          }

          URL.revokeObjectURL(url);

          if (!result) {
            toast({
              title:
                "Không đọc được mã QR",
              description:
                "Hãy thử ảnh rõ nét hơn hoặc sử dụng camera.",
              variant:
                "destructive",
            });

            return;
          }

          handleSuccess(result);
        } catch {
          URL.revokeObjectURL(url);

          toast({
            title:
              "Không thể xử lý ảnh",
            variant:
              "destructive",
          });
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);

        toast({
          title:
            "Ảnh không hợp lệ",
          variant:
            "destructive",
        });
      };

      img.src = url;
    } catch {
      toast({
        title:
          "Không thể đọc ảnh",
        variant:
          "destructive",
      });
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-14 gap-2 rounded-2xl border-2 border-hasfarm-700 px-5 font-bold text-hasfarm-700 hover:bg-hasfarm-50"
      >
        <ScanLine className="h-5 w-5" />
        Quét QR CCCD
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Quét mã QR trên CCCD"
      >
        <div className="space-y-6">

          <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 text-sm leading-6 text-slate-600">
            <p className="font-semibold text-slate-800">
              Hướng dẫn
            </p>

            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Sử dụng mặt sau CCCD có mã QR.</li>
              <li>Đưa mã QR vào giữa khung hình.</li>
              <li>Giữ điện thoại ổn định khoảng 20–30 cm.</li>
              <li>Thông tin chỉ được đọc để điền biểu mẫu, ảnh không được lưu lên máy chủ.</li>
            </ul>
          </div>

          <div className="relative overflow-hidden rounded-3xl bg-black">

            <video
              ref={videoRef}
              className="aspect-video w-full object-cover"
              playsInline
              muted
            />

            {!scanning && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60">

                <div className="text-center text-white">

                  <Camera className="mx-auto mb-3 h-10 w-10" />

                  <p className="font-semibold">
                    Camera chưa được bật
                  </p>

                </div>

              </div>
            )}

            {scanning && (
              <>

                <div className="pointer-events-none absolute left-1/2 top-1/2 h-60 w-60 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-4 border-green-400 shadow-[0_0_0_9999px_rgba(0,0,0,.35)]" />

                <div className="absolute left-0 top-1/2 h-1 w-full -translate-y-1/2 animate-pulse bg-green-400/80" />

                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-2 text-xs font-semibold text-white">
                  Đang tìm mã QR...
                </div>

              </>
            )}

          </div>

          <canvas
            ref={canvasRef}
            className="hidden"
          />

          <div className="grid gap-3 md:grid-cols-2">

            <Button
              type="button"
              onClick={startCamera}
              disabled={loadingCamera || scanning}
              className="h-12 gap-2"
            >
              {loadingCamera ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Đang mở camera...
                </>
              ) : (
                <>
                  <Camera className="h-4 w-4" />
                  {scanning ? "Đang quét..." : "Bật camera"}
                </>
              )}
            </Button>

            <label className="flex h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-hasfarm-700 bg-white font-semibold text-hasfarm-700 transition hover:bg-hasfarm-50">

              <ImageUp className="h-4 w-4" />

              Chọn ảnh CCCD

              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const file =
                    e.target.files?.[0];

                  if (file) {
                    void handleImageUpload(file);
                  }

                  e.currentTarget.value = "";
                }}
              />

            </label>

          </div>

          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-6 text-slate-700">

            <span className="font-bold text-emerald-800">
              Bảo mật:
            </span>

            {" "}
            Việc nhận dạng QR được thực hiện hoàn toàn trên trình duyệt của bạn.
            Ảnh CCCD không được tải lên hoặc lưu trữ trên máy chủ.

          </div>

        </div>
      </Modal>
    </>
  );
}
