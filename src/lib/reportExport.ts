import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import PptxGenJS from "pptxgenjs";
import { escapeXml } from "./export/picture";
import { csvCell } from "./exporters";
import { writeXlsx } from "./import/xlsx";
import type { ReportResult } from "./reports";

/**
 * A report as a file: CSV, Excel, JSON, Markdown, a web page, PDF, Word or PowerPoint. Every
 * format carries the title, when it was made, the note, the chart's numbers and the table.
 */

export interface ReportDoc {
  title: string;
  description: string;
  workspace: string;
  result: ReportResult;
  at?: Date;
}

export const REPORT_FORMATS = [
  { id: "xlsx", label: "Excel", ext: "xlsx" },
  { id: "csv", label: "CSV", ext: "csv" },
  { id: "pdf", label: "PDF", ext: "pdf" },
  { id: "docx", label: "Word", ext: "docx" },
  { id: "pptx", label: "PowerPoint", ext: "pptx" },
  { id: "html", label: "Web page", ext: "html" },
  { id: "md", label: "Markdown", ext: "md" },
  { id: "json", label: "JSON", ext: "json" },
] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number]["id"];

const when = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const line = (doc: ReportDoc) => `${doc.workspace ? `${doc.workspace}, ` : ""}made ${when(doc.at ?? new Date())}`;

export function reportCsv(doc: ReportDoc): string {
  return [doc.result.columns, ...doc.result.rows].map((r) => r.map((c) => csvCell(text(c))).join(",")).join("\r\n") + "\r\n";
}

export function reportXlsx(doc: ReportDoc): Uint8Array {
  const sheets = [{ name: doc.title.slice(0, 31).replace(/[\\/?*[\]:]/g, " ") || "Report", rows: [doc.result.columns, ...doc.result.rows.map((r) => r.map(text))] }];
  if (doc.result.chart?.data.length) sheets.push({ name: "Summary", rows: [[doc.result.chart.title, "Count"], ...doc.result.chart.data.map((d) => [d.label, String(d.value)])] });
  return writeXlsx(sheets);
}

export function reportJson(doc: ReportDoc): string {
  return JSON.stringify(
    {
      title: doc.title,
      description: doc.description,
      workspace: doc.workspace,
      madeAt: (doc.at ?? new Date()).toISOString(),
      note: doc.result.note ?? null,
      chart: doc.result.chart ?? null,
      rows: doc.result.rows.map((r) => Object.fromEntries(doc.result.columns.map((c, i) => [c, r[i] ?? ""]))),
    },
    null,
    2,
  );
}

export function reportMarkdown(doc: ReportDoc): string {
  const cell = (v: unknown) => text(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const out = [`# ${doc.title}`, "", doc.description, "", `_${line(doc)}_`, ""];
  if (doc.result.note) out.push(doc.result.note, "");
  if (doc.result.chart?.data.length) {
    out.push(`## ${doc.result.chart.title}`, "", "| | Count |", "|---|---:|", ...doc.result.chart.data.map((d) => `| ${cell(d.label)} | ${d.value} |`), "");
  }
  out.push(`| ${doc.result.columns.map(cell).join(" | ")} |`, `|${doc.result.columns.map(() => "---").join("|")}|`, ...doc.result.rows.map((r) => `| ${doc.result.columns.map((_, i) => cell(r[i])).join(" | ")} |`));
  return out.join("\n") + "\n";
}

/** Bars for the chart, as SVG. */
function chartSvg(chart: NonNullable<ReportResult["chart"]>): string {
  const data = chart.data.slice(0, 15);
  const max = Math.max(1, ...data.map((d) => d.value));
  const row = 24;
  const labelW = 200;
  const barW = 360;
  const h = data.length * row + 8;
  const bars = data
    .map((d, i) => {
      const w = Math.max(2, (d.value / max) * barW);
      const y = i * row + 4;
      return `<text x="${labelW - 8}" y="${y + 15}" text-anchor="end" font-size="12" fill="#3B4658">${escapeXml(d.label.length > 30 ? `${d.label.slice(0, 29)}…` : d.label)}</text><rect x="${labelW}" y="${y + 3}" width="${w.toFixed(1)}" height="16" rx="3" fill="#2447D6" opacity="0.85"/><text x="${labelW + w + 6}" y="${y + 15}" font-size="12" fill="#16233A">${d.value}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${labelW + barW + 60}" height="${h}" viewBox="0 0 ${labelW + barW + 60} ${h}" font-family="IBM Plex Sans, Segoe UI, Arial, sans-serif">${bars}</svg>`;
}

export function reportHtml(doc: ReportDoc): string {
  const head = doc.result.columns.map((c) => `<th>${escapeXml(c)}</th>`).join("");
  const body = doc.result.rows.map((r) => `<tr>${doc.result.columns.map((_, i) => `<td${typeof r[i] === "number" ? ' class="n"' : ""}>${escapeXml(text(r[i]))}</td>`).join("")}</tr>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(doc.title)}</title>
<style>
body{font-family:"IBM Plex Sans","Segoe UI",Arial,sans-serif;color:#16233A;margin:32px auto;max-width:1200px;padding:0 24px;line-height:1.45}
h1{font-size:24px;margin:0 0 4px}p.meta{color:#5B6779;margin:0 0 16px;font-size:13px}p.note{background:#F3F5F8;border-left:3px solid #2447D6;padding:8px 12px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #DFE4EC;padding:6px 8px;text-align:left;vertical-align:top}th{background:#F3F5F8;position:sticky;top:0}td.n{text-align:right;font-variant-numeric:tabular-nums}
input{margin:12px 0;padding:6px 10px;border:1px solid #C3CBD8;border-radius:6px;width:280px}
</style></head><body>
<h1>${escapeXml(doc.title)}</h1>
<p class="meta">${escapeXml(doc.description)}<br>${escapeXml(line(doc))}</p>
${doc.result.note ? `<p class="note">${escapeXml(doc.result.note)}</p>` : ""}
${doc.result.chart?.data.length ? `<h2 style="font-size:16px">${escapeXml(doc.result.chart.title)}</h2>${chartSvg(doc.result.chart)}` : ""}
<input type="search" placeholder="Filter the rows" oninput="var q=this.value.toLowerCase();document.querySelectorAll('tbody tr').forEach(function(r){r.style.display=r.textContent.toLowerCase().indexOf(q)>-1?'':'none'})">
<table><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table>
<p class="meta">${doc.result.rows.length} rows.</p>
</body></html>
`;
}

export async function reportPdf(doc: ReportDoc): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: doc.result.columns.length > 5 ? "landscape" : "portrait", unit: "pt", format: "a4" });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 36;
  let y = M;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(16);
  pdf.text(doc.title, M, (y += 6));
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.setTextColor(91, 103, 121);
  for (const l of pdf.splitTextToSize(`${doc.description} ${line(doc)}`, W - 2 * M) as string[]) pdf.text(l, M, (y += 13));
  if (doc.result.note) for (const l of pdf.splitTextToSize(doc.result.note, W - 2 * M) as string[]) pdf.text(l, M, (y += 13));
  pdf.setTextColor(22, 35, 58);
  if (doc.result.chart?.data.length) {
    y += 14;
    pdf.setFont("helvetica", "bold");
    pdf.text(doc.result.chart.title, M, (y += 4));
    pdf.setFont("helvetica", "normal");
    const data = doc.result.chart.data.slice(0, 10);
    const max = Math.max(1, ...data.map((d) => d.value));
    for (const d of data) {
      y += 14;
      pdf.text(d.label.length > 34 ? `${d.label.slice(0, 33)}…` : d.label, M, y);
      pdf.setFillColor(36, 71, 214);
      pdf.rect(M + 170, y - 8, Math.max(2, (d.value / max) * 200), 9, "F");
      pdf.text(String(d.value), M + 176 + (d.value / max) * 200, y);
    }
  }
  y += 18;
  const cols = doc.result.columns;
  // Wider columns for longer text, within the page.
  const sample = [cols, ...doc.result.rows.slice(0, 60)].map((r) => r.map((c) => Math.min(40, text(c).length)));
  const weights = cols.map((_, i) => Math.max(6, ...sample.map((r) => r[i] ?? 0)));
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => ((W - 2 * M) * w) / total);
  const drawRow = (cells: string[], header: boolean) => {
    pdf.setFont("helvetica", header ? "bold" : "normal");
    pdf.setFontSize(8);
    const wrapped = cells.map((c, i) => (pdf.splitTextToSize(c, widths[i] - 6) as string[]).slice(0, 4));
    const h = Math.max(...wrapped.map((w) => w.length)) * 10 + 6;
    if (y + h > H - M) {
      pdf.addPage();
      y = M;
      if (!header) drawRow(cols, true);
    }
    if (header) {
      pdf.setFillColor(243, 245, 248);
      pdf.rect(M, y, W - 2 * M, h, "F");
    }
    let x = M;
    wrapped.forEach((w, i) => {
      w.forEach((l, j) => pdf.text(l, x + 3, y + 11 + j * 10));
      x += widths[i];
    });
    pdf.setDrawColor(223, 228, 236);
    pdf.line(M, y + h, W - M, y + h);
    y += h;
  };
  drawRow(cols, true);
  for (const r of doc.result.rows) drawRow(cols.map((_, i) => text(r[i])), false);
  return pdf.output("blob");
}

export async function reportDocx(doc: ReportDoc): Promise<Blob> {
  const border = { style: BorderStyle.SINGLE, size: 4, color: "DFE4EC" };
  const cell = (value: string, header = false) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: value, bold: header, size: 16, font: "Calibri" })] })],
      shading: header ? { type: ShadingType.CLEAR, color: "auto", fill: "F3F5F8" } : undefined,
      borders: { top: border, bottom: border, left: border, right: border },
    });
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: doc.result.columns.map((c) => cell(c, true)) }), ...doc.result.rows.map((r) => new TableRow({ children: doc.result.columns.map((_, i) => cell(text(r[i]))) }))],
  });
  const parts: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: doc.title })] }),
    new Paragraph({ children: [new TextRun({ text: doc.description, color: "5B6779" })] }),
    new Paragraph({ children: [new TextRun({ text: line(doc), color: "5B6779", size: 18 })] }),
  ];
  if (doc.result.note) parts.push(new Paragraph({ spacing: { before: 160 }, children: [new TextRun({ text: doc.result.note })] }));
  if (doc.result.chart?.data.length) {
    parts.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: doc.result.chart.title })] }));
    parts.push(
      new Table({
        width: { size: 60, type: WidthType.PERCENTAGE },
        rows: doc.result.chart.data.map((d) => new TableRow({ children: [cell(d.label), new TableCell({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: String(d.value), size: 16 })] })], borders: { top: border, bottom: border, left: border, right: border } })] })),
      }),
    );
  }
  parts.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: `The table (${doc.result.rows.length} rows)` })] }), table);
  const document = new Document({ creator: "ArchONE Diagrams", title: doc.title, sections: [{ properties: { page: { size: { orientation: doc.result.columns.length > 5 ? "landscape" : "portrait" } } }, children: parts }] } as never);
  return Packer.toBlob(document);
}

export async function reportPptx(doc: ReportDoc): Promise<Blob> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = doc.title;
  const W = 13.333;
  const FACE = "Calibri";
  const head = (title: string, sub: string) => {
    const s = pptx.addSlide();
    s.addText(title, { x: 0.5, y: 0.3, w: W - 1, h: 0.6, fontFace: FACE, fontSize: 24, bold: true, color: "16233A", fit: "shrink" });
    s.addText(sub, { x: 0.5, y: 0.85, w: W - 1, h: 0.35, fontFace: FACE, fontSize: 12, color: "5B6779" });
    return s;
  };
  const first = head(doc.title, `${doc.description} ${line(doc)}`);
  if (doc.result.note) first.addText(doc.result.note, { x: 0.5, y: 1.4, w: W - 1, h: 0.5, fontFace: FACE, fontSize: 14, color: "16233A" });
  if (doc.result.chart?.data.length) {
    const data = doc.result.chart.data.slice(0, 12);
    first.addChart(pptx.ChartType.bar, [{ name: doc.result.chart.title, labels: data.map((d) => d.label), values: data.map((d) => d.value) }], { x: 0.5, y: 2.0, w: W - 1, h: 5.0, barDir: "bar", chartColors: ["2447D6"], showValue: true, catAxisLabelFontSize: 11, valAxisHidden: true, showLegend: false });
  }
  const per = 14;
  const rows = doc.result.rows.map((r) => doc.result.columns.map((_, i) => text(r[i])));
  for (let i = 0; i < rows.length || i === 0; i += per) {
    const s = head(doc.title, `Rows ${rows.length ? i + 1 : 0} to ${Math.min(rows.length, i + per)} of ${rows.length}`);
    s.addTable(
      [doc.result.columns.map((c) => ({ text: c, options: { bold: true, fill: { color: "F3F5F8" } } })), ...rows.slice(i, i + per).map((r) => r.map((c) => ({ text: c.length > 80 ? `${c.slice(0, 79)}…` : c })))],
      { x: 0.5, y: 1.35, w: W - 1, fontFace: FACE, fontSize: 9, color: "16233A", border: { type: "solid", pt: 0.5, color: "DFE4EC" }, autoPage: false },
    );
    if (!rows.length) break;
  }
  return (await pptx.write({ outputType: "blob" })) as Blob;
}

/** The file for a format, with its name's extension and type. */
export async function reportFile(doc: ReportDoc, format: ReportFormat): Promise<{ blob: Blob; ext: string }> {
  switch (format) {
    case "csv":
      return { blob: new Blob(["﻿" + reportCsv(doc)], { type: "text/csv;charset=utf-8" }), ext: "csv" };
    case "xlsx":
      return { blob: new Blob([reportXlsx(doc) as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), ext: "xlsx" };
    case "json":
      return { blob: new Blob([reportJson(doc)], { type: "application/json" }), ext: "json" };
    case "md":
      return { blob: new Blob([reportMarkdown(doc)], { type: "text/markdown" }), ext: "md" };
    case "html":
      return { blob: new Blob([reportHtml(doc)], { type: "text/html" }), ext: "html" };
    case "pdf":
      return { blob: await reportPdf(doc), ext: "pdf" };
    case "docx":
      return { blob: await reportDocx(doc), ext: "docx" };
    case "pptx":
      return { blob: await reportPptx(doc), ext: "pptx" };
  }
}
