import { describe, expect, it } from "vitest";
import { handleAiRequest, checkAiRequest } from "../ai/server-core";
import { createDiagram, emptyWorkspace } from "../model";
import { writeZip } from "../import/zip";
import type { ImportedPage } from "../import/diagramFile";
import { parseBpmn, buildBpmn } from "./bpmn";
import { blockFromStep, blockInfo, elementOf, ownBlocks, removeBlock, saveBlock } from "./elements";
import { fileKind, sheetLines, slidesText, specFromPage, wordText } from "./fromFile";
import { createProcess, diagramsOfProcess, linkProcessDiagram, processesOfDiagram } from "./processes";
import { checkProcess } from "./validate";

describe("a process from a file made before", () => {
  it("knows the kinds of file it reads", () => {
    expect(["a.bpmn", "b.PNG", "c.pdf", "d.docx", "e.pptx", "f.md", "g.xlsx", "h.drawio", "i.vsdx"].map((n) => fileKind(n))).toEqual(["bpmn", "image", "pdf", "word", "slides", "text", "sheet", "drawio", "visio"]);
    expect(fileKind("x.exe")).toBeNull();
  });

  it("reads the words of Word and PowerPoint files, and a spreadsheet of steps as lines with their roles", async () => {
    const docx = writeZip({ "word/document.xml": '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Sales: check </w:t></w:r><w:r><w:t>the order</w:t></w:r></w:p><w:p><w:r><w:t>المالية: إصدار الفاتورة</w:t></w:r></w:p></w:body></w:document>' });
    expect(await wordText(docx)).toBe("Sales: check the order\nالمالية: إصدار الفاتورة");
    const pptx = writeZip({ "ppt/slides/slide2.xml": '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Ship it</a:t></a:r></a:p></p:sld>', "ppt/slides/slide1.xml": '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Take the order</a:t></a:r></a:p></p:sld>' });
    expect(await slidesText(pptx)).toBe("Take the order\n\nShip it");
    expect(sheetLines([["Step", "Who"], ["Check the order", "Sales"], ["Pay", ""], ["", ""]])).toBe("Sales: Check the order\nPay");
    expect(sheetLines([["الخطوة", "القسم"], ["مراجعة الطلب", "المبيعات"]])).toBe("المبيعات: مراجعة الطلب");
  });

  it("turns a flowchart into lanes, steps, decisions and flows, adding a start and an end when the chart has none", () => {
    const box = (id: string, text: string, x: number, y: number, hint = "rounded", parentId: string | null = null) => ({ id, text, x, y, width: 120, height: 60, parentId, hint });
    const page: ImportedPage = {
      name: "Page 1",
      shapes: [
        { id: "lane1", text: "Sales", x: 0, y: 0, width: 900, height: 200, parentId: null, hint: "swimlane" },
        { id: "lane2", text: "Finance", x: 0, y: 200, width: 900, height: 200, parentId: null, hint: "swimlane" },
        box("a", "Check the order", 50, 50, "rounded", "lane1"),
        { ...box("b", "In stock?", 250, 50, "rhombus", "lane1"), width: 80, height: 80 },
        box("c", "Ship it", 450, 50, "rounded", "lane1"),
        box("d", "Refund", 450, 250, "rounded", "lane2"),
      ],
      connectors: [
        { id: "e1", sourceId: "a", targetId: "b", text: "" },
        { id: "e2", sourceId: "b", targetId: "c", text: "Yes" },
        { id: "e3", sourceId: "b", targetId: "d", text: "No" },
      ],
      skipped: { unlabelled: 0, loose: 0, notes: 0 },
    };
    const { spec, shapes, flows } = specFromPage(page, "Orders");
    expect([shapes, flows]).toEqual([4, 3]);
    expect(spec.lanes).toEqual(["Sales", "Finance"]);
    expect(spec.steps.find((s) => s.name === "In stock?")?.type).toBe("exclusiveGateway");
    expect(spec.steps.find((s) => s.name === "Refund")?.lane).toBe("Finance");
    expect(spec.steps.filter((s) => s.type === "startEvent")).toHaveLength(1);
    expect(spec.steps.filter((s) => s.type === "endEvent")).toHaveLength(2);
    expect(spec.flows.find((f) => f.name === "No")).toMatchObject({ from: "S_b", to: "S_d" });
    const errors = checkProcess(parseBpmn(buildBpmn(spec))).filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("the AI model reading a picture of a process", () => {
  const image = { mime: "image/png", data: "A".repeat(200) };
  it("sends the picture to the vision model with what came with it, and counts it as a picture", async () => {
    expect(checkAiRequest({ mode: "process", text: "", image })).toEqual({ ok: true, kind: "image" });
    expect(checkAiRequest({ mode: "process", text: "Sales: check" })).toEqual({ ok: true, kind: "text" });
    expect(checkAiRequest({ mode: "process", text: "" }).ok).toBe(false);
    const seen: any[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      const process = { name: "From a whiteboard", steps: [{ id: "s", name: "Start", type: "startEvent" }, { id: "a", name: "Check", type: "userTask" }, { id: "e", name: "Done", type: "endEvent" }], flows: [{ from: "s", to: "a" }, { from: "a", to: "e" }] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(process) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await handleAiRequest({ mode: "process", text: "Two lanes: Sales and Finance", image }, { AI_PROVIDER: "groq", AI_API_KEY: "gsk_test" }, fake);
    expect(r.status).toBe(200);
    expect((r.body.process as { spec: { name: string } }).spec.name).toBe("From a whiteboard");
    expect(seen[0].model).toBe("qwen/qwen3.8-27b");
    const parts = seen[0].messages[1].content;
    expect(parts[0].text).toContain("Model the business process this picture shows");
    expect(parts[0].text).toContain("Two lanes: Sales and Finance");
    expect(parts[1].image_url.url).toMatch(/^data:image\/png;base64,A+$/);
  });
});

describe("processes linked to diagrams, and the BPMN library's own building blocks", () => {
  it("links any process to any diagram, many to many, and forgets diagrams that are gone", () => {
    let ws = emptyWorkspace();
    const d1 = createDiagram(ws, { name: "Network" });
    ws = d1.ws;
    const d2 = createDiagram(ws, { name: "Servers" });
    ws = d2.ws;
    const p1 = createProcess(ws, { name: "Order to cash" });
    ws = p1.ws;
    const p2 = createProcess(ws, { name: "Refunds" });
    ws = p2.ws;
    ws = linkProcessDiagram(ws, p1.process.id, d1.diagram.id, true);
    ws = linkProcessDiagram(ws, p1.process.id, d2.diagram.id, true);
    ws = linkProcessDiagram(ws, p2.process.id, d1.diagram.id, true);
    expect(linkProcessDiagram(ws, p1.process.id, d1.diagram.id, true)).toBe(ws);
    expect(diagramsOfProcess(ws, ws.processes[p1.process.id]).map((d) => d.name)).toEqual(["Network", "Servers"]);
    expect(processesOfDiagram(ws, d1.diagram.id).map((p) => p.name)).toEqual(["Order to cash", "Refunds"]);
    ws = linkProcessDiagram(ws, p1.process.id, d1.diagram.id, false);
    expect(processesOfDiagram(ws, d1.diagram.id).map((p) => p.name)).toEqual(["Refunds"]);
    const { [d2.diagram.id]: _gone, ...rest } = ws.diagrams;
    expect(diagramsOfProcess({ ...ws, diagrams: rest }, ws.processes[p1.process.id])).toEqual([]);
  });

  it("keeps building blocks apart from the diagram components, and brings their details into a step", () => {
    let ws = emptyWorkspace();
    const block = blockFromStep({ type: "userTask", name: "Approve the invoice in the ERP" }, "Finance", { objectIds: ["obj_erp"], raci: {}, duration: { min: 2, mode: 5, max: 15 }, automation: "partly" });
    expect(block).toMatchObject({ element: "user-task", role: "Finance", info: { objectIds: ["obj_erp"], duration: { mode: 5 }, automation: "partly" } });
    const saved = saveBlock(ws, block);
    ws = saved.ws;
    expect(ws.library[saved.id]).toMatchObject({ type: "bpmn", bpmn: { name: "Approve the invoice in the ERP" } });
    expect(ownBlocks(ws).map((b) => b.id)).toEqual([saved.id]);
    expect(blockInfo(block)).toMatchObject({ objectIds: ["obj_erp"], raci: { Finance: "R" }, resource: "Finance", duration: { min: 2, mode: 5, max: 15 } });
    expect(saveBlock(ws, { ...block, name: "Approve in SAP" }, saved.id).ws.library[saved.id].bpmn?.name).toBe("Approve in SAP");
    expect(ownBlocks(removeBlock(ws, saved.id))).toEqual([]);
    expect(elementOf("boundaryEvent", "timer")?.id).toBe("boundary-timer");
    expect(elementOf("startEvent", "message")?.id).toBe("start-message");
    expect(elementOf("exclusiveGateway")?.id).toBe("exclusive-gateway");
  });
});
