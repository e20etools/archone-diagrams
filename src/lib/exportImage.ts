import { getNodesBounds, getViewportForBounds, type Node } from "@xyflow/react";
import { toPng, toSvg } from "html-to-image";
import { downloadBlob } from "./exporters";

/** Picture exports of the canvas: PNG, SVG and PDF (PRD FR-32). Browser only. */

const PADDING = 56;
const MAX_SIDE = 6000;

interface Capture {
  dataUrl: string;
  width: number;
  height: number;
}

async function capture(container: HTMLElement, nodes: Node[], format: "png" | "svg"): Promise<Capture> {
  const viewportElement = container.querySelector<HTMLElement>(".react-flow__viewport");
  if (!viewportElement || !nodes.length) throw new Error("There is nothing on the diagram to export.");
  const bounds = getNodesBounds(nodes);
  const width = Math.min(MAX_SIDE, Math.max(480, Math.ceil(bounds.width + PADDING * 2)));
  const height = Math.min(MAX_SIDE, Math.max(320, Math.ceil(bounds.height + PADDING * 2)));
  const viewport = getViewportForBounds(bounds, width, height, 0.1, 1, 0.06);
  const options = {
    backgroundColor: "#ffffff",
    width,
    height,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
    },
    // Handles and other on-hover controls are editing aids, not part of the picture.
    filter: (node: HTMLElement) => !node.classList?.contains("react-flow__handle"),
  };
  const dataUrl = format === "png" ? await toPng(viewportElement, { ...options, pixelRatio: 2 }) : await toSvg(viewportElement, options);
  return { dataUrl, width, height };
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

/**
 * What a picture says about itself once it has left the app: what it shows, when it was
 * exported, and a code that opens the diagram with that date, so the reader of a printed or
 * pasted copy can see whether the model has moved on since.
 */
export interface Stamp {
  title: string;
  line: string;
  url: string;
}

export function stampFor(diagram: { id: string; name: string }, workspaceName: string, by: string, origin: string, at = new Date()): Stamp {
  const when = at.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return {
    title: diagram.name,
    line: `Exported ${when}${by.trim() ? ` by ${by.trim()}` : ""}${workspaceName.trim() ? ` from ${workspaceName.trim()}` : ""}. Scan to see whether it is still current.`,
    url: `${origin}/diagram/${encodeURIComponent(diagram.id)}?asof=${encodeURIComponent(at.toISOString())}`,
  };
}

const STAMP_SCALE = 2; // the capture is drawn at twice its size
const QUIET = 4;

/** Adds a strip under the picture with the stamp's text and its code. */
async function withStamp(shot: Capture, stamp: Stamp): Promise<Capture> {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(stamp.url);
  qr.make();
  const count = qr.getModuleCount();
  // A large picture is usually shown small, so the code grows with it to stay readable by a phone.
  const MODULE = Math.max(2, Math.round(shot.width / 600));
  const side = (count + QUIET * 2) * MODULE;
  const strip = side + 16;
  const image = new Image();
  await new Promise<void>((done, failed) => {
    image.onload = () => done();
    image.onerror = () => failed(new Error("The picture could not be stamped."));
    image.src = shot.dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = shot.width * STAMP_SCALE;
  canvas.height = (shot.height + strip) * STAMP_SCALE;
  const g = canvas.getContext("2d");
  if (!g) return shot;
  g.scale(STAMP_SCALE, STAMP_SCALE);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, shot.width, shot.height + strip);
  g.drawImage(image, 0, 0, shot.width, shot.height);
  g.fillStyle = "#dfe4ec";
  g.fillRect(0, shot.height, shot.width, 1);
  const left = shot.width - side - 16;
  g.fillStyle = "#16233a";
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (qr.isDark(row, column)) g.fillRect(left + (column + QUIET) * MODULE, shot.height + 8 + (row + QUIET) * MODULE, MODULE, MODULE);
    }
  }
  const room = left - 40;
  const fit = (text: string) => {
    if (g.measureText(text).width <= room) return text;
    let cut = text;
    while (cut.length > 4 && g.measureText(`${cut}…`).width > room) cut = cut.slice(0, -1);
    return `${cut}…`;
  };
  g.textBaseline = "middle";
  g.font = "600 14px 'IBM Plex Sans', system-ui, sans-serif";
  g.fillText(fit(stamp.title), 24, shot.height + strip / 2 - 10);
  g.fillStyle = "#5b6678";
  g.font = "12px 'IBM Plex Sans', system-ui, sans-serif";
  g.fillText(fit(stamp.line), 24, shot.height + strip / 2 + 11);
  return { dataUrl: canvas.toDataURL("image/png"), width: shot.width, height: shot.height + strip };
}

export async function exportPng(container: HTMLElement, nodes: Node[], filename: string, stamp?: Stamp) {
  let shot = await capture(container, nodes, "png");
  if (stamp) shot = await withStamp(shot, stamp);
  downloadBlob(`${filename}.png`, await dataUrlToBlob(shot.dataUrl));
}

export async function exportSvg(container: HTMLElement, nodes: Node[], filename: string) {
  const shot = await capture(container, nodes, "svg");
  downloadBlob(`${filename}.svg`, await dataUrlToBlob(shot.dataUrl));
}

export async function exportPdf(container: HTMLElement, nodes: Node[], filename: string, title: string, stamp?: Stamp) {
  let shot = await capture(container, nodes, "png");
  if (stamp) shot = await withStamp(shot, stamp);
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: shot.width >= shot.height ? "landscape" : "portrait", unit: "px", format: [shot.width, shot.height + 40], hotfixes: ["px_scaling"] });
  pdf.setFontSize(14);
  pdf.text(title, 24, 26);
  pdf.addImage(shot.dataUrl, "PNG", 0, 40, shot.width, shot.height);
  pdf.save(`${filename}.pdf`);
}
