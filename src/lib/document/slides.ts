import PptxGenJS from "pptxgenjs";
import { fit, type DocImage, type DocOutline } from "./outline";

/** The architecture as a slide deck: one diagram to a slide, with its description in the speaker notes. */

const INK = "16233A";
const SOFT = "4A5870";
const LINE = "D5DBE5";
const TINT = "EEF1F6";
const ACCENT = "2447D6";
const FACE = "Calibri";
/** A 16:9 slide, in inches. */
const W = 13.333;
const H = 7.5;
const LEFT = 0.6;
const ACROSS = W - LEFT * 2;
const ROWS_PER_SLIDE = 9;

type Slide = ReturnType<PptxGenJS["addSlide"]>;
type Cell = { text: string; options?: Record<string, unknown> };

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
const short = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

export function slideDeck(outline: DocOutline, images: Record<string, DocImage>): PptxGenJS {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = outline.title;
  pptx.author = outline.author || "ArchONE Diagrams";
  pptx.company = outline.workspace;
  const footer = `${outline.workspace}, ${outline.date}`;

  const titled = (title: string, subtitle = ""): Slide => {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(title, { x: LEFT, y: 0.35, w: ACROSS, h: 0.7, fontFace: FACE, fontSize: 28, bold: true, color: INK, fit: "shrink" });
    if (subtitle) slide.addText(subtitle, { x: LEFT, y: 1.0, w: ACROSS, h: 0.35, fontFace: FACE, fontSize: 14, color: SOFT });
    slide.addText(footer, { x: LEFT, y: H - 0.45, w: ACROSS - 1, h: 0.3, fontFace: FACE, fontSize: 10, color: SOFT });
    slide.slideNumber = { x: W - 1.1, y: H - 0.45, w: 0.5, h: 0.3, fontFace: FACE, fontSize: 10, color: SOFT, align: "right" };
    return slide;
  };
  const table = (title: string, subtitle: string, headings: string[], rows: string[][], shares: number[]) => {
    const total = shares.reduce((a, b) => a + b, 0);
    const colW = shares.map((s) => (ACROSS * s) / total);
    const pages = chunks(rows, ROWS_PER_SLIDE);
    pages.forEach((page, i) => {
      const slide = titled(pages.length > 1 ? `${title} (${i + 1} of ${pages.length})` : title, subtitle);
      const head: Cell[] = headings.map((h) => ({ text: h, options: { bold: true, fill: { color: TINT }, color: INK } }));
      slide.addTable([head, ...page.map((row) => row.map((value): Cell => ({ text: short(value, 160) })))], {
        x: LEFT, y: 1.5, w: ACROSS, colW, fontFace: FACE, fontSize: 12, color: INK, valign: "middle", border: { type: "solid", pt: 0.75, color: LINE }, margin: [4, 8, 4, 8],
      });
    });
  };

  // Title
  const first = pptx.addSlide();
  first.background = { color: INK };
  first.addShape(pptx.ShapeType.rect, { x: LEFT, y: 2.55, w: 0.9, h: 0.08, fill: { color: ACCENT }, line: { color: ACCENT } });
  first.addText(outline.title, { x: LEFT, y: 2.8, w: ACROSS, h: 1.3, fontFace: FACE, fontSize: 40, bold: true, color: "FFFFFF", valign: "top", fit: "shrink" });
  first.addText([outline.workspace, outline.date, outline.author && `prepared by ${outline.author}`].filter(Boolean).join(", "), { x: LEFT, y: 4.2, w: ACROSS, h: 0.5, fontFace: FACE, fontSize: 16, color: "C3CBD8" });

  // At a glance
  const glance = titled("At a glance", `The model as it stood on ${outline.date}`);
  const each = ACROSS / outline.counts.length;
  outline.counts.forEach((c, i) => {
    glance.addText(String(c.value), { x: LEFT + each * i, y: 2.5, w: each - 0.3, h: 1.2, fontFace: FACE, fontSize: 60, bold: true, color: INK });
    glance.addText(c.label, { x: LEFT + each * i, y: 3.7, w: each - 0.3, h: 0.4, fontFace: FACE, fontSize: 16, color: SOFT });
  });

  for (const d of outline.diagrams) {
    const slide = titled(d.name, d.view);
    const image = images[d.id];
    const top = 1.5;
    const room = H - top - 0.65;
    if (image) {
      const size = fit(image, ACROSS, room);
      slide.addImage({ data: image.dataUrl, x: LEFT + (ACROSS - size.width) / 2, y: top + (room - size.height) / 2, w: size.width, h: size.height, altText: `Diagram: ${d.name}` });
    } else slide.addText("This diagram has nothing on it yet.", { x: LEFT, y: top, w: ACROSS, h: 0.5, fontFace: FACE, fontSize: 16, italic: true, color: SOFT });
    const notes = [d.description, d.elements.length ? `Shows: ${d.elements.map((e) => e.name).join(", ")}.` : ""].filter(Boolean).join("\n\n");
    if (notes) slide.addNotes(notes);
  }

  if (outline.decisions?.length) table("Decisions", "", ["", "Decision", "Status", "Date"], outline.decisions.map((a) => [a.label, a.title, a.status, a.date]), [1.2, 6, 1.6, 2.2]);
  if (outline.findings) {
    if (outline.findings.length) table("Findings", `${outline.rulesRun} rules run against the whole model`, ["Severity", "Rule", "Found"], outline.findings.map((f) => [f.severity[0].toUpperCase() + f.severity.slice(1), f.title, String(f.count)]), [1.5, 8, 1]);
    else titled("Findings", `${outline.rulesRun} rules were run against the whole model and none of them found anything.`);
  }
  if (outline.data) {
    const { regions, unstated, processors } = outline.data;
    const where = [...regions.map((r) => [r.region, String(r.systems)]), ...(unstated ? [["Not recorded", String(unstated)]] : [])];
    if (where.length) table("Where personal data is kept", "", ["Region", "Systems"], where, [5, 1]);
    if (processors.length) table("Outside parties that receive personal data", "", ["Party", "Purpose", "Region"], processors.map((p) => [p.name, p.purpose, p.region]), [3, 5, 2]);
  }
  return pptx;
}

export const slidesBlob = async (outline: DocOutline, images: Record<string, DocImage>): Promise<Blob> => (await slideDeck(outline, images).write({ outputType: "blob" })) as Blob;
