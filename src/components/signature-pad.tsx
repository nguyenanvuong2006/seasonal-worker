"use client";

import { useEffect, useRef, useState } from "react";

type Point = { x: number; y: number };

export function SignaturePad({
  value,
  onChange,
  disabled = false,
  className = "",
}: {
  value?: string;
  onChange: (dataUrl: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<Point | null>(null);
  const [isEmpty, setIsEmpty] = useState(!value);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * ratio);
    canvas.height = Math.floor(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0F3D23";
    ctx.lineWidth = 2.2;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);

    if (value) {
      const image = new Image();
      image.onload = () => {
        ctx.drawImage(image, 0, 0, rect.width, rect.height);
        setIsEmpty(false);
      };
      image.src = value;
    }
  }, [value, disabled]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const emit = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onChange(canvas.toDataURL("image/png"));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    last.current = pointFromEvent(event);
    setIsEmpty(false);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const next = pointFromEvent(event);
    if (!ctx || !last.current) return;
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    last.current = next;
  };

  const onPointerUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    emit();
  };

  const clear = () => {
    if (disabled) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    setIsEmpty(true);
    onChange("");
  };

  return (
    <div className={className}>
      <div className="overflow-hidden rounded-[14px] border-2 border-dashed border-emerald-700/40 bg-white">
        <canvas
          ref={canvasRef}
          className="h-40 w-full touch-none bg-white"
          style={{ touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-fg-muted">
        <span>{isEmpty ? "Ký bằng chuột hoặc cảm ứng trong khung trên." : "Đã nhận chữ ký — có thể ký lại nếu cần."}</span>
        <button
          type="button"
          onClick={clear}
          disabled={disabled || isEmpty}
          className="font-bold text-emerald-800 underline-offset-2 hover:underline disabled:opacity-40"
        >
          Xoá chữ ký
        </button>
      </div>
    </div>
  );
}
