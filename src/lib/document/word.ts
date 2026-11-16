import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { fit, type DocImage, type DocOutline } from "./outline";

/** The architecture document as a Word file. Headings are real headings, so Word can build a table of contents from them. */

const INK = "16233A";
const SOFT = "4A5870";
const LINE = "D5DBE5";
const TINT = "EEF1F6";
/** A4 with 2.5 cm margins leaves this much across, in twentieths of a point. */
const MARGIN = 1417;
const ACROSS = 11906 - MARGIN * 2;
const ACROSS_PX = (ACROSS / 1440) * 96;

const bytes = (dataUrl: string): Uint8Array => {
  const raw = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

const text = (value: string, more: { bold?: boolean; color?: string; size?: number; italics?: boolean } = {}) => new TextRun({ text: value, ...more });
const para = (value: string, more: { color?: string; after?: number; italics?: boolean } = {}) => new Paragraph({ spacing: { after: more.after ?? 120 }, children: [text(value, { color: more.color, italics: more.italics })] });
/** Text a person wrote, with its line breaks kept. */
const prose = (value: string) => value.split(/\n+/).filter((line) => line.trim()).map((line) => para(line.trim()));
const h1 = (value: string, pageBreak = true) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: pageBreak, spacing: { after: 160 }, children: [text(value)] });
const h2 = (value: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 100 }, children: [text(value)] });
const h3 = (value: string) => new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 80 }, children: [text(value)] });

const BORDER = { style: BorderStyle.SINGLE, size: 4, color: LINE };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

/** A table with a shaded heading row that repeats on each page. `shares` divide the width between the columns. */
function table(headings: string[], rows: string[][], shares: number[]): Table {
  const total = shares.reduce((a, b) => a + b, 0);
  const widths = shares.map((s) => Math.round((ACROSS * s) / total));
  const cell = (value: string, i: number, heading: boolean) =>
    new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      borders: BORDERS,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      shading: heading ? { type: ShadingType.CLEAR, fill: TINT, color: "auto" } : undefined,
      children: [new Paragraph({ children: [text(value, { bold: heading, size: 19 })] })],
    });
  return new Table({
    width: { size: ACROSS, type: WidthType.DXA },
    columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, cantSplit: true, children: headings.map((h, i) => cell(h, i, true)) }), ...rows.map((row) => new TableRow({ cantSplit: true, children: row.map((value, i) => cell(value, i, false)) }))],
  });
}
const gap = () => new Paragraph({ spacing: { after: 80 }, children: [] });
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function wordDocument(outline: DocOutline, images: Record<string, DocImage>): Document {
  const body: (Paragraph | Table)[] = [
    new Paragraph({ spacing: { before: 3200, after: 200 }, children: [text(outline.title, { bold: true, size: 56, color: INK })] }),
    new Paragraph({ spacing: { after: 80 }, children: [text(outline.workspace, { size: 28, color: SOFT })] }),
    new Paragraph({ children: [text([outline.date, outline.author && `prepared by ${outline.author}`].filter(Boolean).join(", "), { color: SOFT })] }),

    h1("At a glance"),
    para(`This document describes the architecture recorded in the workspace "${outline.workspace}" as it stood on ${outline.date}. Its diagrams, tables and findings are read from one model, so they agree with each other.`),
    table(["", "In the model"], outline.counts.map((c) => [c.label, String(c.value)]), [3, 1]),
  ];

  outline.diagrams.forEach((d) => {
    body.push(h1(d.name));
    body.push(para(d.view, { color: SOFT, after: 160 }));
    const image = images[d.id];
    if (image) {
      const size = fit(image, ACROSS_PX, 560);
      body.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new ImageRun({ type: "png", data: bytes(image.dataUrl), transformation: { width: Math.round(size.width), height: Math.round(size.height) }, altText: { title: d.name, description: `Diagram: ${d.name}`, name: d.name } })],
        }),
      );
    } else body.push(para("This diagram has nothing on it yet.", { italics: true, color: SOFT }));
    body.push(...prose(d.description));
    if (d.elements.length) {
      body.push(h2("What it shows"));
      body.push(table(["Name", "Kind", "Owner", "Description"], d.elements.map((e) => [e.name, e.type, e.owner, e.description]), [3, 2, 2, 5]));
    }
    if (d.connections.length) {
      body.push(h2("How the parts connect"));
      body.push(table(["From", "To", "Connection"], d.connections.map((c) => [c.from, c.to, c.what]), [3, 3, 4]));
    }
    for (const flow of d.flows) {
      body.push(h2(`Flow: ${flow.name}`));
      body.push(...prose(flow.description));
      body.push(table(["Step", "Between", "What happens"], flow.steps.map((s, i) => [String(i + 1), s.route, s.text]), [1, 4, 6]));
    }
  });

  if (outline.inventory) {
    body.push(h1("Inventory"));
    body.push(para(`Every object in the model: ${count(outline.inventory.length, "object")}.`));
    body.push(table(["Name", "Kind", "Owner", "Lifecycle", "Technology"], outline.inventory.map((o) => [o.name, o.type, o.owner, o.lifecycle, o.technology]), [4, 3, 3, 2, 3]));
  }

  if (outline.decisions) {
    body.push(h1("Decisions"));
    if (!outline.decisions.length) body.push(para("No decision has been recorded."));
    for (const a of outline.decisions) {
      body.push(h2(`${a.label}: ${a.title}`));
      body.push(para([a.status, a.date, a.about && `about ${a.about}`].filter(Boolean).join(", "), { color: SOFT }));
      for (const [label, value] of [["Context", a.context], ["Decision", a.decision], ["Consequences", a.consequences]] as const) {
        if (!value) continue;
        body.push(h3(label));
        body.push(...prose(value));
      }
    }
  }

  if (outline.findings) {
    body.push(h1("Findings"));
    body.push(
      para(
        outline.findings.length
          ? `${count(outline.rulesRun, "rule")} were run against the whole model. ${count(outline.findings.length, "rule")} found something. The rules see only what the model records, so a clean result is not a certificate of compliance.`
          : `${count(outline.rulesRun, "rule")} were run against the whole model and none of them found anything.`,
      ),
    );
    if (outline.findings.length) {
      body.push(table(["Severity", "Rule", "Found", "For example"], outline.findings.map((f) => [f.severity[0].toUpperCase() + f.severity.slice(1), f.title, String(f.count), f.examples.join(" ")]), [2, 4, 1, 6]));
    }
  }

  if (outline.data) {
    const { regions, unstated, processors, transfers } = outline.data;
    body.push(h1("Personal data"));
    body.push(h2("Where it is kept"));
    if (!regions.length && !unstated) body.push(para("No system is recorded as holding personal data."));
    else body.push(table(["Region", "Systems"], [...regions.map((r) => [r.region, String(r.systems)]), ...(unstated ? [["Not recorded", String(unstated)]] : [])], [3, 1]));
    body.push(h2("Outside parties that receive it"));
    if (!processors.length) body.push(para("No outside system is connected to a system that holds personal data."));
    else body.push(table(["Party", "Purpose", "Region", "Connected systems"], processors.map((p) => [p.name, p.purpose, p.region, String(p.systems)]), [3, 4, 2, 2]));
    body.push(h2("Movement between regions"));
    if (!transfers.length) body.push(para("No connection carries personal data from one region to another."));
    else body.push(table(["Between", "Connections"], transfers.map((t) => [`${t.regions[0]} and ${t.regions[1]}`, String(t.connections)]), [3, 1]));
  }
  body.push(gap());

  return new Document({
    creator: outline.author || "ArchONE Diagrams",
    title: outline.title,
    description: `Architecture of ${outline.workspace}, exported ${outline.date}`,
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22, color: INK } },
        heading1: { run: { font: "Calibri", size: 36, bold: true, color: INK }, paragraph: { spacing: { after: 160 } } },
        heading2: { run: { font: "Calibri", size: 26, bold: true, color: INK } },
        heading3: { run: { font: "Calibri", size: 22, bold: true, color: SOFT } },
      },
    },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: `${outline.title}, ${outline.date}    `, color: SOFT, size: 17 }), new TextRun({ children: [PageNumber.CURRENT], color: SOFT, size: 17 })],
              }),
            ],
          }),
        },
        children: body,
      },
    ],
  });
}

export const wordBlob = (outline: DocOutline, images: Record<string, DocImage>): Promise<Blob> => Packer.toBlob(wordDocument(outline, images));
