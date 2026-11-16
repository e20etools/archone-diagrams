import { describe, expect, it } from "vitest";
import { writeBpmn } from "./bpmn";
import { OBJECT_TYPES } from "./catalog";
import { descendants, parseXml } from "./import/xml";
import { createDiagram, createObject, createRelationship, emptyWorkspace, placeNodes, updateDiagram } from "./model";
import { archimateArrow, archimateElement, bpmnArrow, bpmnShape } from "./notation";
import { RELATION_KINDS, diagramSchema, type Workspace } from "./types";

describe("ArchiMate notation", () => {
  it("gives every object type an element and a layer", () => {
    for (const t of OBJECT_TYPES) expect(archimateElement(t.id).name, t.id).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    expect(archimateElement("database")).toEqual({ name: "System software", layer: "technology" });
    expect(archimateElement("service")).toEqual({ name: "Application component", layer: "application" });
    expect(archimateElement("actor")).toEqual({ name: "Business actor", layer: "business" });
    expect(archimateElement("domain").layer).toBe("grouping");
    expect(archimateElement("task")).toEqual({ name: "Business process", layer: "business" });
  });
  it("draws a call as 'serves', pointing at the caller, and a copy as a dashed flow", () => {
    expect(archimateArrow("calls")).toEqual({ name: "serves", reversed: true, dashed: false, head: "open" });
    expect(archimateArrow("replicates_to")).toMatchObject({ name: "flow", reversed: false, dashed: true });
    expect(archimateArrow("flows_to")).toMatchObject({ name: "triggers", reversed: false, head: "filled" });
    for (const kind of RELATION_KINDS) expect(archimateArrow(kind).name).toBeTruthy();
  });
});

describe("BPMN", () => {
  function claim() {
    let ws: Workspace = emptyWorkspace();
    const ids: Record<string, string> = {};
    const add = (name: string, typeId: string) => {
      const made = createObject(ws, { name, typeId });
      ws = made.ws;
      ids[name] = made.object.id;
    };
    for (const [name, type] of [["Claim received", "event"], ["Check policy", "task"], ["Covered?", "decision"], ["Pay claim", "task"], ["Reject <claim>", "task"], ["Done", "event"], ["Claims DB", "database"], ["Clerk", "actor"]] as const) add(name, type);
    const then = (a: string, b: string, label = "") => {
      ws = createRelationship(ws, { sourceId: ids[a], targetId: ids[b], kind: "flows_to", label }).ws;
    };
    then("Claim received", "Check policy");
    then("Check policy", "Covered?");
    then("Covered?", "Pay claim", "yes");
    then("Covered?", "Reject <claim>", "no");
    then("Pay claim", "Done");
    ws = createRelationship(ws, { sourceId: ids["Check policy"], targetId: ids["Claims DB"], kind: "reads_writes" }).ws;
    const made = createDiagram(ws, { name: "Claims & payouts", viewType: "custom" });
    ws = placeNodes(updateDiagram(made.ws, made.diagram.id, { notation: "bpmn" }), made.diagram.id, Object.fromEntries(Object.values(ids).map((id, i) => [id, { x: i * 260, y: 100, pinned: true }])));
    return { ws, ids, diagram: ws.diagrams[made.diagram.id] };
  }

  it("gives process steps their shapes and leaves other types as boxes", () => {
    expect([bpmnShape("task").shape, bpmnShape("event").shape, bpmnShape("decision").shape, bpmnShape("process").shape, bpmnShape("database").shape, bpmnShape("service").shape]).toEqual(["task", "event", "gateway", "pool", "data", "box"]);
    expect(bpmnArrow("flows_to")).toMatchObject({ dashed: false, head: "filled" });
    expect(bpmnArrow("calls").dashed).toBe(true);
  });
  it("keeps the chosen notation on the diagram, and a diagram without one is plain", () => {
    const { diagram } = claim();
    expect(diagram.notation).toBe("bpmn");
    const { notation: _gone, ...old } = diagram;
    expect(diagramSchema.parse(old).notation).toBeUndefined();
  });
  it("exports a process with start and end events, a gateway, sequence flows and the layout", () => {
    const { ws, ids, diagram } = claim();
    const { xml, leftOut } = writeBpmn(ws, diagram);
    const root = parseXml(xml);
    expect(root.name).toBe("definitions");
    expect(root.attrs.xmlns).toBe("http://www.omg.org/spec/BPMN/20100524/MODEL");
    const names = (tag: string) => descendants(root, tag).map((n) => n.attrs.name);
    expect(names("startEvent")).toEqual(["Claim received"]);
    expect(names("endEvent")).toEqual(["Done"]);
    expect(names("exclusiveGateway")).toEqual(["Covered?"]);
    expect(names("task")).toEqual(["Check policy", "Pay claim", "Reject <claim>"]);
    expect(names("dataStoreReference")).toEqual(["Claims DB"]);
    expect(descendants(root, "process")[0].attrs.name).toBe("Claims & payouts");
    const flows = descendants(root, "sequenceFlow");
    expect(flows).toHaveLength(5);
    expect(flows.map((f) => f.attrs.name).filter(Boolean).sort()).toEqual(["no", "yes"]);
    // Every reference resolves, and every element has a shape or an edge.
    const elementIds = new Set(descendants(root, "process")[0].children.map((c) => c.attrs.id));
    expect(flows.every((f) => elementIds.has(f.attrs.sourceRef) && elementIds.has(f.attrs.targetRef))).toBe(true);
    expect(descendants(root, "association")).toHaveLength(1);
    const drawn = [...descendants(root, "BPMNShape"), ...descendants(root, "BPMNEdge")].map((s) => s.attrs.bpmnElement);
    expect(new Set(drawn)).toEqual(elementIds);
    const start = descendants(root, "BPMNShape").find((s) => s.attrs.bpmnElement === `Node_${ids["Claim received"]}`)!;
    expect(start.children[0].attrs).toMatchObject({ x: "90", y: "121", width: "36", height: "36" });
    expect(leftOut).toEqual(["Clerk"]);
  });
});
