import { getNodesBounds, getViewportForBounds, type Node } from "@xyflow/react";
import { toPng, toSvg } from "html-to-image";
import type { BoxView } from "./approvals";
import { downloadBlob } from "./exporters";

/** Picture exports of the canvas: PNG, SVG and PDF (PRD FR-32). Browser only. */

const PADDING = 56;
const MAX_SIDE = 6000;

export interface Capture {
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

/** The picture of a diagram as data, for exports that place it inside a document. */
export const capturePng = (container: HTMLElement, nodes: Node[]): Promise<Capture> => capture(container, nodes, "png");

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

const TONE_COLOR = { ok: "#1f8a4c", warn: "#b7791f", muted: "#7c889c" } as const;
const INK = "#16233a";
const SOFT = "#5b6678";

const loadImage = (src: string) =>
  new Promise<HTMLImageElement | null>((done) => {
    const image = new Image();
    image.onload = () => done(image);
    image.onerror = () => done(null);
    image.src = src;
  });

/**
 * Adds the diagram's information box under the picture, as a title block: company and logo, the
 * box's cells, the authenticity seal and a QR code that opens the verified copy (or the diagram).
 */
async function withTitleBlock(shot: Capture, box: { view: BoxView; url: string }): Promise<Capture> {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(box.url);
  qr.make();
  const count = qr.getModuleCount();
  // Text and code grow with the picture, so they stay readable when a large picture is shown small.
  const k = Math.max(1, shot.width / 900);
  // The code takes up to a fifth of the width, and no more than the box is high, so a phone reads it from a print.
  const modules = count + QUIET * 2;
  let MODULE = Math.max(3, Math.floor(Math.min(260 * k, shot.width * 0.2) / modules));
  const pad = 12 * k;
  const header = box.view.company ? 34 * k : 0;
  const cellH = 38 * k;
  const sealH = 34 * k;
  const room = shot.width - modules * MODULE - pad * 3;
  const cells = box.view.cells.filter((c) => c.field !== "seal");
  const seal = box.view.cells.find((c) => c.field === "seal");
  const columns = Math.max(2, Math.min(5, Math.floor(room / (170 * k))));
  const rows = Math.ceil(cells.length / columns);
  const content = header + rows * cellH + (seal ? sealH : 0);
  if (modules * MODULE > content) MODULE = Math.max(3, Math.floor(content / modules));
  const side = modules * MODULE;
  const strip = Math.max(side, content) + pad * 2;
  const [image, logo] = await Promise.all([loadImage(shot.dataUrl), box.view.company?.logo ? loadImage(box.view.company.logo) : Promise.resolve(null)]);
  if (!image) throw new Error("The picture could not be finished.");
  const canvas = document.createElement("canvas");
  canvas.width = shot.width * STAMP_SCALE;
  canvas.height = (shot.height + strip) * STAMP_SCALE;
  const g = canvas.getContext("2d");
  if (!g) return shot;
  g.scale(STAMP_SCALE, STAMP_SCALE);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, shot.width, shot.height + strip);
  g.drawImage(image, 0, 0, shot.width, shot.height);
  const top = shot.height + pad;
  const left = pad;
  const width = room;
  const fit = (text: string, max: number) => {
    if (g.measureText(text).width <= max) return text;
    let cut = text;
    while (cut.length > 2 && g.measureText(`${cut}…`).width > max) cut = cut.slice(0, -1);
    return `${cut}…`;
  };
  g.textBaseline = "middle";
  g.strokeStyle = INK;
  g.lineWidth = Math.max(1, k);
  g.strokeRect(left, top, width, content);
  let y = top;
  if (box.view.company) {
    let x = left + 8 * k;
    if (logo) {
      const s = 24 * k;
      const scale = Math.min(s / logo.width, s / logo.height);
      g.drawImage(logo, x, y + (header - logo.height * scale) / 2, logo.width * scale, logo.height * scale);
      x += s + 8 * k;
    }
    g.fillStyle = INK;
    g.font = `600 ${13 * k}px 'IBM Plex Sans', system-ui, sans-serif`;
    g.fillText(fit(box.view.company.name, left + width - x - 8 * k), x, y + header / 2);
    y += header;
    g.beginPath();
    g.moveTo(left, y);
    g.lineTo(left + width, y);
    g.stroke();
  }
  const cellW = width / columns;
  g.strokeStyle = "#b9c1cf";
  cells.forEach((cell, i) => {
    const cx = left + (i % columns) * cellW;
    const cy = y + Math.floor(i / columns) * cellH;
    if (i % columns) {
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx, cy + cellH);
      g.stroke();
    }
    if (i >= columns) {
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + cellW, cy);
      g.stroke();
    }
    g.fillStyle = SOFT;
    g.font = `${10.5 * k}px 'IBM Plex Sans', system-ui, sans-serif`;
    g.fillText(fit(cell.label, cellW - 14 * k), cx + 7 * k, cy + 12 * k);
    let x = cx + 7 * k;
    if (cell.mark) {
      const r = 6 * k;
      g.fillStyle = cell.mark === "yes" ? "#1f8a4c" : "#b4321f";
      g.beginPath();
      g.arc(x + r, cy + 26 * k, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#ffffff";
      g.lineWidth = 1.6 * k;
      g.beginPath();
      if (cell.mark === "yes") {
        g.moveTo(x + r * 0.5, cy + 26 * k);
        g.lineTo(x + r * 0.9, cy + 26 * k + r * 0.4);
        g.lineTo(x + r * 1.5, cy + 26 * k - r * 0.4);
      } else {
        g.moveTo(x + r * 0.6, cy + 26 * k - r * 0.4);
        g.lineTo(x + r * 1.4, cy + 26 * k + r * 0.4);
        g.moveTo(x + r * 1.4, cy + 26 * k - r * 0.4);
        g.lineTo(x + r * 0.6, cy + 26 * k + r * 0.4);
      }
      g.stroke();
      g.strokeStyle = "#b9c1cf";
      g.lineWidth = Math.max(1, k);
      x += 2 * r + 5 * k;
    }
    g.fillStyle = cell.tone ? TONE_COLOR[cell.tone] : INK;
    g.font = `600 ${11.5 * k}px 'IBM Plex Sans', system-ui, sans-serif`;
    g.fillText(fit(cell.value, cx + cellW - x - 7 * k), x, cy + 26 * k);
  });
  y += rows * cellH;
  if (seal) {
    g.strokeStyle = INK;
    g.beginPath();
    g.moveTo(left, y);
    g.lineTo(left + width, y);
    g.stroke();
    g.fillStyle = box.view.sealTone === "ok" ? "#e4f4ea" : box.view.sealTone === "warn" ? "#fdf3dc" : "#f3f5f8";
    g.fillRect(left + 0.5, y + 0.5, width - 1, sealH - 1);
    g.fillStyle = SOFT;
    g.font = `${10.5 * k}px 'IBM Plex Sans', system-ui, sans-serif`;
    g.fillText(seal.label, left + 7 * k, y + sealH / 2);
    g.fillStyle = TONE_COLOR[box.view.sealTone];
    g.font = `600 ${12 * k}px 'IBM Plex Mono', ui-monospace, monospace`;
    g.fillText(fit(seal.value, width - 110 * k), left + 90 * k, y + sealH / 2);
  }
  const qrLeft = shot.width - side - pad;
  const qrTop = shot.height + (strip - side) / 2;
  g.fillStyle = INK;
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (qr.isDark(row, column)) g.fillRect(qrLeft + (column + QUIET) * MODULE, qrTop + (row + QUIET) * MODULE, MODULE, MODULE);
    }
  }
  return { dataUrl: canvas.toDataURL("image/png"), width: shot.width, height: shot.height + strip };
}

/** What goes under an exported picture: the information box with its QR code, or else the stamp. */
export interface PictureExtras {
  stamp?: Stamp;
  box?: { view: BoxView; url: string };
}

async function finished(container: HTMLElement, nodes: Node[], extras: PictureExtras): Promise<Capture> {
  const shot = await capture(container, nodes, "png");
  if (extras.box) return withTitleBlock(shot, extras.box);
  if (extras.stamp) return withStamp(shot, extras.stamp);
  return shot;
}

/** The PNG or PDF of a diagram as a file, so it can be fingerprinted before it is saved. */
export async function pictureBlob(container: HTMLElement, nodes: Node[], kind: "png" | "pdf", title: string, extras: PictureExtras = {}): Promise<Blob> {
  const shot = await finished(container, nodes, extras);
  if (kind === "png") return dataUrlToBlob(shot.dataUrl);
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: shot.width >= shot.height ? "landscape" : "portrait", unit: "px", format: [shot.width, shot.height + 40], hotfixes: ["px_scaling"] });
  pdf.setFontSize(14);
  pdf.text(title, 24, 26);
  pdf.addImage(shot.dataUrl, "PNG", 0, 40, shot.width, shot.height);
  return pdf.output("blob");
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
