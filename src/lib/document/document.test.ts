import JSZip from "jszip";
import { Packer } from "docx";
import { describe, expect, it } from "vitest";
import { demoWorkspace } from "../demo";
import { sortedDiagrams } from "../model";
import { buildOutline, documentFileName, fit, type DocImage, type DocOptions } from "./outline";
import { slideDeck } from "./slides";
import { wordDocument } from "./word";

// A 1x1 PNG stands in for the picture of a diagram.
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ws = demoWorkspace("Sara Ahmed");
const diagrams = sortedDiagrams(ws);
const options: DocOptions = { title: "", diagramIds: diagrams.slice(0, 2).map((d) => d.id), inventory: true, decisions: true, packs: ["practice", "security", "privacy"], data: true };
const at = new Date("2026-11-16T09:00:00Z");
const images: Record<string, DocImage> = { [diagrams[0].id]: { dataUrl: PIXEL, width: 1200, height: 700 } };

describe("the architecture document", () => {
  it("reads its content from the model", () => {
    const outline = buildOutline(ws, options, at);
    expect(outline.title).toBe(`${ws.name}: architecture`);
    expect(outline.date).toBe("16 November 2026");
    expect(outline.author).toBe("Sara Ahmed");
    expect(outline.counts.map((c) => c.value)).toEqual([Object.keys(ws.objects).length, Object.keys(ws.relationships).length, Object.keys(ws.diagrams).length, Object.keys(ws.adrs).length]);
    expect(outline.diagrams.map((d) => d.name)).toEqual(diagrams.slice(0, 2).map((d) => d.name));
    expect(outline.diagrams[0].elements.length).toBe(Object.keys(diagrams[0].nodes).length);
    expect(outline.diagrams[0].connections.every((c) => c.from && c.to && c.what)).toBe(true);
    expect(outline.inventory).toHaveLength(Object.keys(ws.objects).length);
    expect(outline.decisions?.[0].label).toMatch(/^ADR-\d+$/);
    expect(outline.rulesRun).toBeGreaterThan(5);
    expect(outline.findings?.every((f) => f.count >= f.examples.length && f.examples.length <= 3)).toBe(true);
    expect(outline.data).not.toBeNull();
  });

  it("leaves out the sections that were not asked for, and diagrams that no longer exist", () => {
    const outline = buildOutline(ws, { title: " Payments review ", diagramIds: ["gone", diagrams[0].id], inventory: false, decisions: false, packs: [], data: false }, at);
    expect(outline).toMatchObject({ title: "Payments review", inventory: null, decisions: null, findings: null, data: null, rulesRun: 0 });
    expect(outline.diagrams).toHaveLength(1);
    expect(documentFileName(outline, at)).toBe("payments-review-2026-11-16");
    expect(fit({ width: 1200, height: 600 }, 600, 600)).toEqual({ width: 600, height: 300 });
    expect(fit({ width: 300, height: 900 }, 600, 600)).toEqual({ width: 200, height: 600 });
  });

  it("is written as a Word file with real headings, tables and the diagram pictures", async () => {
    const outline = buildOutline(ws, options, at);
    const zip = await JSZip.loadAsync(await Packer.toBuffer(wordDocument(outline, images)));
    const xml = await zip.file("word/document.xml")!.async("string");
    for (const heading of ["At a glance", diagrams[0].name, "What it shows", "How the parts connect", "Inventory", "Decisions", "Findings", "Personal data"]) expect(xml, heading).toContain(heading.replace(/&/g, "&amp;"));
    expect(xml.match(/<w:pStyle w:val="Heading1"\/>/g)!.length).toBe(1 + 2 + 4);
    expect(xml.match(/<w:tbl>/g)!.length).toBeGreaterThan(5);
    expect(Object.keys(zip.files).filter((f) => f.startsWith("word/media/"))).toHaveLength(1);
    expect(xml).toContain("This diagram has nothing on it yet.");
  });

  it("is written as slides, one diagram to a slide", async () => {
    const outline = buildOutline(ws, options, at);
    const zip = await JSZip.loadAsync((await slideDeck(outline, images).write({ outputType: "nodebuffer" })) as Buffer);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides.length).toBeGreaterThanOrEqual(2 + 2 + 2);
    const all = (await Promise.all(slides.map((f) => zip.file(f)!.async("string")))).join("\n");
    for (const title of ["At a glance", diagrams[0].name, diagrams[1].name, "Decisions", "Findings"]) expect(all, title).toContain(title.replace(/&/g, "&amp;"));
    expect(Object.keys(zip.files).some((f) => f.startsWith("ppt/media/"))).toBe(true);
  });
});
