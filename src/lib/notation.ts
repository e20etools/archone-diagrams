import { objectType } from "./catalog";
import { ARCHIMATE_ELEMENT } from "./import/archimate";
import type { Notation, RelationKind } from "./types";

/**
 * Notations (PRD FR-10). A notation changes how a diagram is drawn, never what the model
 * holds: the same objects and relationships can be shown as plain boxes, in ArchiMate or in
 * BPMN. The mapping is fixed per object type and relationship kind.
 */

export const NOTATION_INFO: Record<Notation, { label: string; hint: string }> = {
  plain: { label: "Boxes and lines", hint: "Plain boxes with the type written on them. Reads without training." },
  archimate: { label: "ArchiMate", hint: "Each box takes the colour of its ArchiMate layer and names its element; arrows are drawn as ArchiMate relationships." },
  bpmn: { label: "BPMN", hint: "For processes: tasks as rounded boxes, events as circles, decisions as diamonds, joined by sequence flows." },
};

export type ArchimateLayer = "business" | "application" | "technology" | "grouping";
const LAYER: Record<string, ArchimateLayer> = {
  Grouping: "grouping",
  BusinessActor: "business",
  BusinessProcess: "business",
  BusinessEvent: "business",
  ApplicationComponent: "application",
  SystemSoftware: "technology",
  Node: "technology",
  CommunicationNetwork: "technology",
};
/** The ArchiMate element an object type is drawn as, with the layer that gives it its colour. */
export function archimateElement(typeId: string): { name: string; layer: ArchimateLayer } {
  const element = ARCHIMATE_ELEMENT[typeId] ?? "ApplicationComponent";
  const words = element.replace(/([a-z])([A-Z])/g, "$1 $2");
  return { name: words.charAt(0) + words.slice(1).toLowerCase(), layer: LAYER[element] ?? "application" };
}

export interface ArrowStyle {
  /** What the arrow says when the relationship has no label of its own. */
  name: string;
  /** True when the arrowhead belongs at the source end: "A calls B" is drawn as "B serves A". */
  reversed: boolean;
  dashed: boolean;
  /** An open arrowhead (two strokes) or a filled one. */
  head: "open" | "filled";
}
export function archimateArrow(kind: RelationKind): ArrowStyle {
  if (kind === "flows_to") return { name: "triggers", reversed: false, dashed: false, head: "filled" };
  if (kind === "replicates_to" || kind === "routes_to") return { name: "flow", reversed: false, dashed: true, head: "filled" };
  return { name: "serves", reversed: true, dashed: false, head: "open" };
}

export type BpmnShape = "task" | "event" | "gateway" | "pool" | "participant" | "data" | "box";
/** The BPMN shape an object type is drawn as. Types BPMN has no shape for stay boxes. */
export function bpmnShape(typeId: string): { shape: BpmnShape; name: string } {
  if (typeId === "task") return { shape: "task", name: "Task" };
  if (typeId === "event") return { shape: "event", name: "Event" };
  if (typeId === "decision") return { shape: "gateway", name: "Gateway" };
  if (typeId === "process") return { shape: "pool", name: "Process" };
  if (typeId === "actor") return { shape: "participant", name: "Participant" };
  if (["database", "storage", "queue", "cache"].includes(typeId)) return { shape: "data", name: "Data store" };
  return { shape: "box", name: objectType(typeId).label };
}
/** In BPMN a sequence flow is a solid arrow; anything else between two shapes is an association, drawn dotted. */
export function bpmnArrow(kind: RelationKind): ArrowStyle {
  return kind === "flows_to" ? { name: "", reversed: false, dashed: false, head: "filled" } : { name: "", reversed: false, dashed: true, head: "open" };
}
