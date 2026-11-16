import { escapeXml } from "./import/xml";
import { bpmnShape } from "./notation";
import type { Diagram, Workspace } from "./types";
import { visibleEdges } from "./views";

/**
 * A diagram as a BPMN 2.0 file (PRD FR-10), with the layout, for tools such as Camunda
 * Modeler, bpmn.io and Signavio. Tasks, events and decisions become their BPMN elements and
 * "then" relationships become sequence flows. A BPMN file holds one process, so anything on
 * the diagram that BPMN has no step for is left out, apart from data stores; what was left
 * out is counted in the result.
 */
export function writeBpmn(ws: Workspace, diagram: Diagram): { xml: string; leftOut: string[] } {
  const id = (kind: string, raw: string) => `${kind}_${raw.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const edges = visibleEdges(ws, diagram).filter((e) => !e.implied);
  const flows = edges.filter((e) => e.kind === "flows_to");
  const leftOut: string[] = [];
  const kept = new Map<string, { tag: string; w: number; h: number }>();

  for (const objectId of Object.keys(diagram.nodes)) {
    const o = ws.objects[objectId];
    if (!o) continue;
    const { shape } = bpmnShape(o.typeId);
    if (shape === "task") kept.set(objectId, { tag: "task", w: 216, h: 78 });
    else if (shape === "gateway") kept.set(objectId, { tag: "exclusiveGateway", w: 50, h: 50 });
    else if (shape === "data") kept.set(objectId, { tag: "dataStoreReference", w: 50, h: 50 });
    else if (shape === "event") {
      // Nothing leads to a start event; nothing follows an end event.
      const incoming = flows.some((f) => f.targetId === objectId);
      const outgoing = flows.some((f) => f.sourceId === objectId);
      kept.set(objectId, { tag: !incoming ? "startEvent" : !outgoing ? "endEvent" : "intermediateThrowEvent", w: 36, h: 36 });
    } else if (shape === "pool") {
      // A process drawn as a step of another process is a call to it.
      kept.set(objectId, { tag: "callActivity", w: 216, h: 78 });
    } else leftOut.push(o.name);
  }

  const sequence = flows.filter((f) => kept.has(f.sourceId) && kept.has(f.targetId) && kept.get(f.sourceId)!.tag !== "dataStoreReference" && kept.get(f.targetId)!.tag !== "dataStoreReference");
  const associations = edges.filter((e) => !sequence.includes(e) && kept.has(e.sourceId) && kept.has(e.targetId));
  // Each shape is centred where its box was, so the drawing keeps its arrangement.
  const bounds = (objectId: string) => {
    const { w, h } = kept.get(objectId)!;
    const at = diagram.nodes[objectId];
    return { x: Math.round(at.x + (216 - w) / 2), y: Math.round(at.y + (78 - h) / 2), w, h };
  };
  const centre = (objectId: string) => {
    const b = bounds(objectId);
    return `<di:waypoint x="${b.x + b.w / 2}" y="${b.y + b.h / 2}"/>`;
  };

  const nodes = [...kept.entries()].map(([objectId, { tag }]) => {
    const o = ws.objects[objectId];
    const inner = [
      o.description.trim() ? `<documentation>${escapeXml(o.description)}</documentation>` : "",
      ...sequence.filter((f) => f.targetId === objectId).map((f) => `<incoming>${id("Flow", f.id)}</incoming>`),
      ...sequence.filter((f) => f.sourceId === objectId).map((f) => `<outgoing>${id("Flow", f.id)}</outgoing>`),
    ].join("");
    return `<${tag} id="${id("Node", objectId)}" name="${escapeXml(o.name)}">${inner}</${tag}>`;
  });
  const process = [
    ...nodes,
    ...sequence.map((f) => `<sequenceFlow id="${id("Flow", f.id)}"${f.label.trim() ? ` name="${escapeXml(f.label.trim())}"` : ""} sourceRef="${id("Node", f.sourceId)}" targetRef="${id("Node", f.targetId)}"/>`),
    ...associations.map((a) => `<association id="${id("Assoc", a.id)}" sourceRef="${id("Node", a.sourceId)}" targetRef="${id("Node", a.targetId)}"/>`),
  ];
  const shapes = [
    ...[...kept.keys()].map((objectId) => {
      const b = bounds(objectId);
      return `<bpmndi:BPMNShape id="${id("Shape", objectId)}" bpmnElement="${id("Node", objectId)}"><dc:Bounds x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/></bpmndi:BPMNShape>`;
    }),
    ...[...sequence.map((f) => ["Flow", f] as const), ...associations.map((a) => ["Assoc", a] as const)].map(
      ([kind, e]) => `<bpmndi:BPMNEdge id="${id("Edge", e.id)}" bpmnElement="${id(kind, e.id)}">${centre(e.sourceId)}${centre(e.targetId)}</bpmndi:BPMNEdge>`,
    ),
  ];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="${id("Definitions", diagram.id)}" targetNamespace="https://archone.example/bpmn" exporter="ArchONE Diagrams">`,
    `<process id="${id("Process", diagram.id)}" name="${escapeXml(diagram.name)}" isExecutable="false">${process.join("")}</process>`,
    `<bpmndi:BPMNDiagram id="${id("Diagram", diagram.id)}"><bpmndi:BPMNPlane id="${id("Plane", diagram.id)}" bpmnElement="${id("Process", diagram.id)}">${shapes.join("")}</bpmndi:BPMNPlane></bpmndi:BPMNDiagram>`,
    "</definitions>",
  ].join("\n");
  return { xml, leftOut: leftOut.sort() };
}
