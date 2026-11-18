import { useEffect, useState } from "react";
import { downloadBlob } from "@/lib/exporters";

/** The dark modules of a QR code for a text, with its size in modules. */
export async function qrModules(text: string): Promise<{ count: number; dark: (row: number, column: number) => boolean }> {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return { count: qr.getModuleCount(), dark: (row, column) => qr.isDark(row, column) };
}

const QUIET = 4;

/** A QR code drawn as SVG, sharp at any size. */
export function QrCode({ text, size = 132, label }: { text: string; size?: number; label: string }) {
  const [path, setPath] = useState<{ d: string; side: number } | null>(null);
  useEffect(() => {
    let live = true;
    void qrModules(text).then(({ count, dark }) => {
      let d = "";
      for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (dark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
      if (live) setPath({ d, side: count + QUIET * 2 });
    });
    return () => {
      live = false;
    };
  }, [text]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={path ? `0 0 ${path.side} ${path.side}` : "0 0 1 1"} shapeRendering="crispEdges" className="rounded bg-white" data-qr={text}>
      <rect width="100%" height="100%" fill="#ffffff" />
      {path && <path d={path.d} fill="#16233a" />}
    </svg>
  );
}

/** Saves a QR code for a text as a PNG, large enough to print. */
export async function downloadQrPng(text: string, filename: string) {
  const { count, dark } = await qrModules(text);
  const cell = 12;
  const side = (count + QUIET * 2) * cell;
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, side, side);
  g.fillStyle = "#16233a";
  for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (dark(r, c)) g.fillRect((c + QUIET) * cell, (r + QUIET) * cell, cell, cell);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
  if (blob) downloadBlob(`${filename}.png`, blob);
}
