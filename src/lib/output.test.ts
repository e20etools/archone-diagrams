import { describe, expect, it } from "vitest";
import { demoWorkspace } from "./demo";
import { csvCell, diagramJson, objectsCsv, relationshipsCsv, toMermaid, toPlantUml } from "./exporters";
import { buildSharePayload, decodeShare, encodeShare, isProtectedShare, payloadToWorkspace, ShareError } from "./share";
import { visibleEdges } from "./views";

const ws = demoWorkspace("Khaled");
const inside = Object.values(ws.diagrams).find((d) => d.name === "Inside Online store")!;

describe("text exports (FR-32)", () => {
  it("escapes CSV cells and neutralises spreadsheet formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a "quoted", value')).toBe('"a ""quoted"", value"');
    expect(csvCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("exports objects and relationships as CSV with one row each", () => {
    const objects = Object.values(ws.objects);
    const csv = objectsCsv(ws, objects).trim().split("\r\n");
    expect(csv).toHaveLength(objects.length + 1);
    expect(csv[0].startsWith("ID,Name,Type,Level,Part of,Owner")).toBe(true);
    expect(csv.some((row) => row.includes("Order service") && row.includes("Online store"))).toBe(true);
    const rels = Object.values(ws.relationships);
    expect(relationshipsCsv(ws, rels).trim().split("\r\n")).toHaveLength(rels.length + 1);
  });

  it("exports a diagram as JSON with only the objects it shows", () => {
    const data = JSON.parse(diagramJson(ws, inside));
    expect(data.format).toBe("archone-diagram");
    expect(data.objects).toHaveLength(Object.keys(inside.nodes).length);
  });

  it("writes Mermaid with a boundary for the scope and one line per edge", () => {
    const text = toMermaid(ws, inside);
    expect(text.startsWith("flowchart TB")).toBe(true);
    expect(text).toContain('subgraph scope["Online store"]');
    expect(text).toMatch(/n\d+\[\("Orders database<br\/>Database"\)\]/);
    const edgeLines = text.split("\n").filter((l) => /-->|-\.->/.test(l));
    expect(edgeLines).toHaveLength(visibleEdges(ws, inside).length);
  });

  it("writes PlantUML that opens and closes correctly", () => {
    const text = toPlantUml(ws, inside);
    expect(text.startsWith("@startuml")).toBe(true);
    expect(text.trim().endsWith("@enduml")).toBe(true);
    expect(text).toContain('package "Online store" {');
    expect(text).toMatch(/database "Orders database\\n\[Database\]" as n\d+/);
  });
});

describe("share links (FR-31)", () => {
  it("round-trips an open link and rebuilds a read-only workspace", async () => {
    const token = await encodeShare(buildSharePayload(ws, inside));
    expect(isProtectedShare(token)).toBe(false);
    const payload = await decodeShare(token);
    expect(payload.diagram.name).toBe("Inside Online store");
    expect(payload.sharedBy).toBe("Khaled");
    const view = payloadToWorkspace(payload);
    expect(Object.keys(view.diagrams)).toEqual([inside.id]);
    expect(visibleEdges(view, view.diagrams[inside.id]).length).toBe(visibleEdges(ws, inside).length);
  });

  it("does not put drafting prompts into the link", async () => {
    const withPrompt = structuredClone(ws);
    const first = Object.keys(inside.nodes)[0];
    withPrompt.objects[first].provenance = { origin: "ai-prompt", source: "secret prompt text", approvedBy: "Khaled" };
    const payload = buildSharePayload(withPrompt, inside);
    expect(JSON.stringify(payload)).not.toContain("secret prompt text");
  });

  it("needs the right password for a protected link", async () => {
    const token = await encodeShare(buildSharePayload(ws, inside), "correct horse");
    expect(isProtectedShare(token)).toBe(true);
    expect(token).not.toContain("Online");
    await expect(decodeShare(token)).rejects.toMatchObject({ code: "password-required" });
    await expect(decodeShare(token, "wrong")).rejects.toMatchObject({ code: "wrong-password" });
    expect((await decodeShare(token, "correct horse")).diagram.id).toBe(inside.id);
  });

  it("rejects damaged or made-up links", async () => {
    await expect(decodeShare("nonsense")).rejects.toBeInstanceOf(ShareError);
    await expect(decodeShare("1p.AAAA")).rejects.toMatchObject({ code: "invalid" });
    const token = await encodeShare(buildSharePayload(ws, inside));
    await expect(decodeShare(token.slice(0, -12))).rejects.toMatchObject({ code: "invalid" });
  });
});
