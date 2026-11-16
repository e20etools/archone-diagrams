import { describe, expect, it } from "vitest";
import { demoWorkspace } from "../demo";
import { sortedDiagrams } from "../model";
import { diagramWorkspace, drawioXml, interactiveHtml, structurizrDsl } from "./formats";
import { diagramPicture, pictureFrames, pictureSvg } from "./picture";

const ws = demoWorkspace("Sara");
const diagram = sortedDiagrams(ws).find((d) => d.viewType === "container")!;

describe("exports drawn from the model", () => {
  it("draws every box and line of the diagram, with the system as a boundary", () => {
    const p = diagramPicture(ws, diagram);
    expect(p.nodes).toHaveLength(Object.keys(diagram.nodes).length);
    expect(p.edges.length).toBeGreaterThan(0);
    expect(p.boundary?.label).toBe(ws.objects[diagram.scopeId!].name);
    const svg = pictureSvg(p);
    expect(svg.startsWith("<svg")).toBe(true);
    expect((svg.match(/<g>/g) ?? []).length).toBe(p.nodes.length);
  });

  it("moves: flow steps one by one, or dashes along the lines", () => {
    const p = diagramPicture(ws, diagram);
    expect(pictureFrames(p).length).toBe(16);
    const withFlow = { ...p, flows: [{ name: "Checkout", steps: [{ from: p.edges[0].from, to: p.edges[0].to, text: "Pays" }] }] };
    const frames = pictureFrames(withFlow);
    expect(frames).toHaveLength(2);
    expect(frames[1].svg).toContain("Checkout: 1. Pays");
    expect(frames[1].svg).toContain('stroke="#E0662B"');
  });

  it("writes draw.io, Structurizr and an offline page", () => {
    const p = diagramPicture(ws, diagram);
    const drawio = drawioXml(diagram, p);
    expect((drawio.match(/vertex="1"/g) ?? []).length).toBe(p.nodes.length + 1);
    expect((drawio.match(/edge="1"/g) ?? []).length).toBe(p.edges.length);
    const dsl = structurizrDsl(ws, diagram);
    expect(dsl).toMatch(/^workspace "/);
    // A C4 Level 2 diagram becomes a container view of its system.
    expect(dsl).toMatch(/\n {8}container \w+ "[^"]+" \{/);
    expect(dsl).toMatch(/= container "/);
    const html = interactiveHtml(ws, diagram, p);
    expect(html).toContain('<script type="application/json" id="data">');
    // Nothing in the data can close the script early.
    expect(html.split('id="data">')[1].split("</script>")[0]).not.toContain("<");
  });

  it("keeps only what the diagram shows for whole-model formats", () => {
    const sub = diagramWorkspace(ws, diagram);
    expect(Object.keys(sub.objects).sort()).toEqual(Object.keys(diagram.nodes).filter((id) => ws.objects[id]).sort());
    expect(Object.keys(sub.diagrams)).toEqual([diagram.id]);
  });
});
