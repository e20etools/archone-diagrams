import dagre from "@dagrejs/dagre";
import { escapeXml, parseXml, type XmlNode } from "../import/xml";

/**
 * BPMN 2.0 files: read into a small graph the app can check, simulate and compare with an event
 * log, and written from a plain list of steps and flows (with its diagram laid out), so drafts,
 * templates and models discovered from a log open in any BPMN tool.
 */

export type NodeKind = "event" | "activity" | "gateway" | "data" | "other";

export interface BpmnNode {
  id: string;
  /** The BPMN element, without its prefix: task, userTask, exclusiveGateway, startEvent... */
  type: string;
  name: string;
  kind: NodeKind;
  /** For an event: message, timer, error, signal, conditional, escalation, terminate, compensate, link. */
  trigger?: string;
  processId: string;
  laneId?: string;
  /** For a boundary event: the activity it sits on. */
  attachedTo?: string;
  /** For a gateway: its default flow. */
  defaultFlow?: string;
  /** For a call activity: what it calls. */
  calledElement?: string;
  incoming: string[];
  outgoing: string[];
}

export interface BpmnFlow {
  id: string;
  type: "sequenceFlow" | "messageFlow" | "association";
  sourceId: string;
  targetId: string;
  name: string;
  condition: string;
}

export interface BpmnGraph {
  processes: { id: string; name: string; participant: string }[];
  nodes: Record<string, BpmnNode>;
  flows: Record<string, BpmnFlow>;
  lanes: { id: string; name: string; processId: string; nodeIds: string[] }[];
}

export class BpmnError extends Error {}

const local = (name: string) => name.slice(name.indexOf(":") + 1);
const kindOf = (type: string): NodeKind =>
  /Event$/.test(type) ? "event" : /Gateway$/.test(type) ? "gateway" : /(Task|^task|subProcess|transaction|callActivity|adHocSubProcess)$/.test(type) ? "activity" : /^data(Object|Store)/.test(type) ? "data" : "other";
const FLOW_NODES = /Event$|Gateway$|Task$|^task$|^subProcess$|^transaction$|^callActivity$|^adHocSubProcess$|^dataObjectReference$|^dataStoreReference$/;

export function parseBpmn(source: string): BpmnGraph {
  let root: XmlNode;
  try {
    root = parseXml(source);
  } catch {
    throw new BpmnError("This is not a BPMN file: it could not be read as XML.");
  }
  if (local(root.name) !== "definitions") throw new BpmnError("This is not a BPMN 2.0 file: it has no definitions element.");
  const graph: BpmnGraph = { processes: [], nodes: {}, flows: {}, lanes: [] };
  const participants = new Map<string, string>();
  for (const c of root.children.filter((n) => local(n.name) === "collaboration")) {
    for (const p of c.children.filter((n) => local(n.name) === "participant")) if (p.attrs.processRef) participants.set(p.attrs.processRef, p.attrs.name ?? "");
    for (const f of c.children.filter((n) => local(n.name) === "messageFlow")) {
      graph.flows[f.attrs.id] = { id: f.attrs.id, type: "messageFlow", sourceId: f.attrs.sourceRef ?? "", targetId: f.attrs.targetRef ?? "", name: f.attrs.name ?? "", condition: "" };
    }
  }
  const walk = (container: XmlNode, processId: string) => {
    for (const n of container.children) {
      const type = local(n.name);
      if (FLOW_NODES.test(type) && n.attrs.id) {
        const trigger = n.children.map((c) => local(c.name)).find((c) => c.endsWith("EventDefinition"));
        graph.nodes[n.attrs.id] = {
          id: n.attrs.id,
          type,
          name: (n.attrs.name ?? "").replace(/\s+/g, " ").trim(),
          kind: kindOf(type),
          trigger: trigger ? trigger.replace("EventDefinition", "") : undefined,
          processId,
          attachedTo: n.attrs.attachedToRef,
          defaultFlow: n.attrs.default,
          calledElement: n.attrs.calledElement,
          incoming: [],
          outgoing: [],
        };
        if (type === "subProcess" || type === "transaction" || type === "adHocSubProcess") walk(n, processId);
      } else if (type === "sequenceFlow" && n.attrs.id) {
        const condition = n.children.find((c) => local(c.name) === "conditionExpression");
        graph.flows[n.attrs.id] = { id: n.attrs.id, type: "sequenceFlow", sourceId: n.attrs.sourceRef ?? "", targetId: n.attrs.targetRef ?? "", name: n.attrs.name ?? "", condition: condition?.text?.trim() ?? "" };
      } else if (type === "association" && n.attrs.id) {
        graph.flows[n.attrs.id] = { id: n.attrs.id, type: "association", sourceId: n.attrs.sourceRef ?? "", targetId: n.attrs.targetRef ?? "", name: "", condition: "" };
      } else if (type === "laneSet") {
        const lanes = (set: XmlNode) => {
          for (const lane of set.children.filter((c) => local(c.name) === "lane")) {
            const refs = lane.children.filter((c) => local(c.name) === "flowNodeRef").map((c) => (c.text ?? "").trim());
            const nested = lane.children.find((c) => local(c.name) === "childLaneSet");
            if (nested) lanes(nested);
            else graph.lanes.push({ id: lane.attrs.id, name: lane.attrs.name ?? "", processId, nodeIds: refs });
          }
        };
        lanes(n);
      }
    }
  };
  for (const p of root.children.filter((n) => local(n.name) === "process")) {
    graph.processes.push({ id: p.attrs.id, name: p.attrs.name ?? "", participant: participants.get(p.attrs.id) ?? "" });
    walk(p, p.attrs.id);
  }
  if (!graph.processes.length) throw new BpmnError("This BPMN file has no process in it.");
  for (const lane of graph.lanes) for (const id of lane.nodeIds) if (graph.nodes[id]) graph.nodes[id].laneId = lane.id;
  for (const f of Object.values(graph.flows)) {
    if (f.type !== "sequenceFlow") continue;
    graph.nodes[f.sourceId]?.outgoing.push(f.id);
    graph.nodes[f.targetId]?.incoming.push(f.id);
  }
  return graph;
}

/** The lane a node is in, by name, or "". */
export const laneName = (graph: BpmnGraph, nodeId: string) => graph.lanes.find((l) => l.id === graph.nodes[nodeId]?.laneId)?.name ?? "";

/** Activities in the order a reader meets them, from the start events along the flows. */
export function activitiesInOrder(graph: BpmnGraph): BpmnNode[] {
  const seen = new Set<string>();
  const order: BpmnNode[] = [];
  const queue = Object.values(graph.nodes).filter((n) => n.type === "startEvent" && !n.attachedTo);
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (n.kind === "activity") order.push(n);
    for (const f of n.outgoing) {
      const next = graph.nodes[graph.flows[f]?.targetId];
      if (next && !seen.has(next.id)) queue.push(next);
    }
    for (const b of Object.values(graph.nodes)) if (b.attachedTo === n.id && !seen.has(b.id)) queue.push(b);
  }
  for (const n of Object.values(graph.nodes)) if (n.kind === "activity" && !seen.has(n.id)) order.push(n);
  return order;
}

/* ---------- Writing ---------- */

export type StepType =
  | "startEvent"
  | "endEvent"
  | "intermediateThrowEvent"
  | "intermediateCatchEvent"
  | "boundaryEvent"
  | "task"
  | "userTask"
  | "serviceTask"
  | "manualTask"
  | "scriptTask"
  | "businessRuleTask"
  | "sendTask"
  | "receiveTask"
  | "subProcess"
  | "callActivity"
  | "exclusiveGateway"
  | "parallelGateway"
  | "inclusiveGateway"
  | "eventBasedGateway";

export interface SpecStep {
  id: string;
  name: string;
  type: StepType;
  lane?: string;
  /** For an event: message, timer, error, signal, conditional, escalation, terminate. */
  trigger?: string;
  /** For a boundary event: the activity it sits on. */
  attachedTo?: string;
  /** For a boundary event: false when the activity goes on (a dashed circle). */
  interrupting?: boolean;
}
export interface SpecFlow {
  from: string;
  to: string;
  name?: string;
}
/** A data object (a document of this case) or a data store (kept beyond it), and the steps that read and write it. */
export interface SpecData {
  id: string;
  name: string;
  kind: "object" | "store";
  reads?: string[];
  writes?: string[];
}
/** A note on a step. */
export interface SpecNote {
  id: string;
  text: string;
  on: string;
}
/** Someone outside the process, drawn as a closed pool above it. */
export interface SpecPartner {
  id: string;
  name: string;
}
/** A message between a partner and a step, either way. */
export interface SpecMessage {
  from: string;
  to: string;
  name?: string;
}
/** A process as a reader would list it: its steps, who does them, and what follows what. */
export interface ProcessSpec {
  name: string;
  lanes?: string[];
  steps: SpecStep[];
  flows: SpecFlow[];
  data?: SpecData[];
  notes?: SpecNote[];
  partners?: SpecPartner[];
  messages?: SpecMessage[];
}

const SIZE: Record<string, { w: number; h: number }> = { event: { w: 36, h: 36 }, gateway: { w: 50, h: 50 }, activity: { w: 110, h: 80 } };
const sizeOf = (type: string) => SIZE[kindOf(type)] ?? SIZE.activity;
const ncname = (raw: string) => {
  const clean = raw.replace(/[^A-Za-z0-9_.-]/g, "_");
  return /^[A-Za-z_]/.test(clean) ? clean : `_${clean}`;
};
type Box = { x: number; y: number; w: number; h: number };

/**
 * Writes a process as BPMN 2.0 with its diagram: lanes as rows of one pool, flows from left to right,
 * boundary events on the edge of their activity, partners as closed pools above with their messages,
 * notes above the steps they explain, and data objects and stores below the pool.
 */
export function buildBpmn(spec: ProcessSpec): string {
  const lanes = (spec.lanes ?? []).filter((l, i, all) => l && all.indexOf(l) === i);
  const laneOf = (s: { lane?: string }) => (lanes.length ? (s.lane && lanes.includes(s.lane) ? s.lane : lanes[0]) : "");
  const raw = spec.steps.map((s) => ({ ...s, id: ncname(s.id), attachedTo: s.attachedTo ? ncname(s.attachedTo) : undefined }));
  const ids0 = new Set(raw.map((s) => s.id));
  // A boundary event needs an activity to sit on, and sits in its lane.
  const steps = raw
    .filter((s) => s.type !== "boundaryEvent" || (s.attachedTo && ids0.has(s.attachedTo) && kindOf(raw.find((h) => h.id === s.attachedTo)!.type) === "activity"))
    .map((s) => (s.type === "boundaryEvent" ? { ...s, lane: raw.find((h) => h.id === s.attachedTo)!.lane } : s));
  const ids = new Set(steps.map((s) => s.id));
  const isBoundary = (id: string) => steps.find((x) => x.id === id)?.type === "boundaryEvent";
  const flows = spec.flows.map((f, i) => ({ ...f, id: `Flow_${i + 1}`, from: ncname(f.from), to: ncname(f.to) })).filter((f) => ids.has(f.from) && ids.has(f.to) && !isBoundary(f.to));
  const placed = steps.filter((s) => s.type !== "boundaryEvent");
  const hostOf = (id: string) => steps.find((x) => x.id === id)?.attachedTo;
  // Steps reached only from a boundary event: the exception path, drawn below the main one.
  const exception = new Set(placed.filter((s) => flows.some((f) => f.to === s.id && isBoundary(f.from)) && !flows.some((f) => f.to === s.id && !isBoundary(f.from))).map((s) => s.id));

  // Columns from a left-to-right layering; within a lane, steps in one column stack.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 60 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const s of placed) g.setNode(s.id, { width: sizeOf(s.type).w, height: sizeOf(s.type).h });
  for (const f of flows) g.setEdge(isBoundary(f.from) ? hostOf(f.from)! : f.from, f.to);
  dagre.layout(g);
  const xs = [...new Set(placed.map((s) => Math.round(g.node(s.id).x)))].sort((a, b) => a - b);
  const column = new Map(placed.map((s) => [s.id, xs.indexOf(Math.round(g.node(s.id).x))]));
  const laneRows = new Map<string, Map<number, string[]>>();
  for (const s of [...placed].sort((a, b) => Number(exception.has(a.id)) - Number(exception.has(b.id)) || g.node(a.id).y - g.node(b.id).y)) {
    const lane = laneOf(s);
    const cols = laneRows.get(lane) ?? new Map<number, string[]>();
    const col = column.get(s.id)!;
    cols.set(col, [...(cols.get(col) ?? []), s.id]);
    laneRows.set(lane, cols);
  }
  const partners = (spec.partners ?? []).map((p) => ({ ...p, id: ncname(`Partner_${p.id}`), key: p.id }));
  const partnerId = new Map(partners.map((p) => [p.key, p.id]));
  const notes = (spec.notes ?? []).map((n) => ({ ...n, id: ncname(n.id), on: ncname(n.on) })).filter((n) => ids.has(n.on));
  const data = (spec.data ?? []).map((d) => ({
    ...d,
    id: ncname(d.id),
    reads: (d.reads ?? []).map(ncname).filter((id) => ids.has(id) && kindOf(steps.find((x) => x.id === id)!.type) === "activity"),
    writes: (d.writes ?? []).map(ncname).filter((id) => ids.has(id) && kindOf(steps.find((x) => x.id === id)!.type) === "activity"),
  }));
  const pooled = lanes.length > 0 || partners.length > 0;

  const ROW = 110;
  const COL = 150;
  const LANE_LABEL = lanes.length ? 30 : 0;
  const POOL_LABEL = pooled ? 30 : 0;
  const left = 160 + POOL_LABEL + LANE_LABEL;
  const PARTNER_H = 60;
  const top = 80 + partners.length * (PARTNER_H + 30) + (notes.length ? 80 : 0);
  const pos = new Map<string, Box>();
  const laneBounds: { name: string; y: number; h: number }[] = [];
  let y = top;
  for (const lane of lanes.length ? lanes : [""]) {
    const cols = laneRows.get(lane) ?? new Map<number, string[]>();
    const rows = Math.max(1, ...[...cols.values()].map((v) => v.length));
    const h = rows * ROW + 20;
    for (const [col, list] of cols) {
      list.forEach((id, i) => {
        const s = steps.find((x) => x.id === id)!;
        const { w, h: sh } = sizeOf(s.type);
        const cx = left + 40 + col * COL;
        const cy = y + 10 + i * ROW + ROW / 2;
        pos.set(id, { x: cx - w / 2, y: cy - sh / 2, w, h: sh });
      });
    }
    laneBounds.push({ name: lane, y, h });
    y += h;
  }
  // Boundary events on the lower edge of their activity, from the right.
  const onHost = new Map<string, number>();
  for (const s of steps.filter((x) => x.type === "boundaryEvent")) {
    const host = pos.get(s.attachedTo!)!;
    const k = onHost.get(s.attachedTo!) ?? 0;
    onHost.set(s.attachedTo!, k + 1);
    pos.set(s.id, { x: host.x + host.w - 28 - k * 40, y: host.y + host.h - 18, w: 36, h: 36 });
  }
  const width = Math.max(600, (xs.length || 1) * COL + 100);
  const poolX = 160;
  const poolW = width + POOL_LABEL + LANE_LABEL;
  const poolBottom = y;

  const partnerBox = new Map(partners.map((p, i) => [p.id, { x: poolX, y: 80 + i * (PARTNER_H + 30), w: poolW, h: PARTNER_H }]));
  const noteRow = 80 + partners.length * (PARTNER_H + 30);
  const noteBox = new Map<string, Box>();
  const noteCount = new Map<string, number>();
  for (const n of notes) {
    const on = pos.get(n.on)!;
    const k = noteCount.get(n.on) ?? 0;
    noteCount.set(n.on, k + 1);
    noteBox.set(n.id, { x: on.x + k * 180, y: noteRow, w: 170, h: 50 });
  }
  const dataBox = new Map<string, Box>();
  const taken: number[] = [];
  for (const d of data) {
    const users = [...d.writes, ...d.reads].map((id) => pos.get(id)!).filter(Boolean);
    const want = users.length ? users.reduce((n, b) => n + b.x + b.w / 2, 0) / users.length : left + 40;
    let x = Math.round(want - 25);
    // Far enough apart that their names do not run into each other.
    while (taken.some((t) => Math.abs(t - x) < 120)) x += 120;
    taken.push(x);
    dataBox.set(d.id, d.kind === "store" ? { x, y: poolBottom + 50, w: 50, h: 50 } : { x: x + 7, y: poolBottom + 50, w: 36, h: 50 });
  }

  const process = "Process_1";
  const flowXml = (f: (typeof flows)[number]) => `    <bpmn:sequenceFlow id="${f.id}" sourceRef="${f.from}" targetRef="${f.to}"${f.name ? ` name="${escapeXml(f.name)}"` : ""} />`;
  const reads = data.flatMap((d) => d.reads.map((stepId, i) => ({ id: ncname(`${d.id}_in_${i + 1}`), data: d.id, step: stepId })));
  const writes = data.flatMap((d) => d.writes.map((stepId, i) => ({ id: ncname(`${d.id}_out_${i + 1}`), data: d.id, step: stepId })));
  const stepXml = (s: (typeof steps)[number]) => {
    const inc = flows.filter((f) => f.to === s.id).map((f) => `      <bpmn:incoming>${f.id}</bpmn:incoming>`);
    const out = flows.filter((f) => f.from === s.id).map((f) => `      <bpmn:outgoing>${f.id}</bpmn:outgoing>`);
    const ins = reads.filter((r) => r.step === s.id);
    const property = ins.length ? [`      <bpmn:property id="${s.id}_input" name="__targetRef_placeholder" />`] : [];
    const dataIn = ins.map((r) => `      <bpmn:dataInputAssociation id="${r.id}">\n        <bpmn:sourceRef>${r.data}</bpmn:sourceRef>\n        <bpmn:targetRef>${s.id}_input</bpmn:targetRef>\n      </bpmn:dataInputAssociation>`);
    const dataOut = writes.filter((w) => w.step === s.id).map((w) => `      <bpmn:dataOutputAssociation id="${w.id}">\n        <bpmn:targetRef>${w.data}</bpmn:targetRef>\n      </bpmn:dataOutputAssociation>`);
    const trigger = s.trigger && kindOf(s.type) === "event" ? [`      <bpmn:${s.trigger}EventDefinition id="${s.id}_def" />`] : [];
    const inner = [...inc, ...out, ...property, ...dataIn, ...dataOut, ...trigger];
    const attrs = s.type === "boundaryEvent" ? ` attachedToRef="${s.attachedTo}"${s.interrupting === false ? ' cancelActivity="false"' : ""}` : "";
    return `    <bpmn:${s.type} id="${s.id}" name="${escapeXml(s.name)}"${attrs}${inner.length ? `>\n${inner.join("\n")}\n    </bpmn:${s.type}>` : " />"}`;
  };
  const dataXml = data.map((d) =>
    d.kind === "store" ? `    <bpmn:dataStoreReference id="${d.id}" name="${escapeXml(d.name)}" />` : `    <bpmn:dataObjectReference id="${d.id}" name="${escapeXml(d.name)}" dataObjectRef="${d.id}_object" />\n    <bpmn:dataObject id="${d.id}_object" />`,
  );
  const noteXml = notes.flatMap((n) => [`    <bpmn:textAnnotation id="${n.id}">\n      <bpmn:text>${escapeXml(n.text)}</bpmn:text>\n    </bpmn:textAnnotation>`, `    <bpmn:association id="${n.id}_link" sourceRef="${n.on}" targetRef="${n.id}" />`]);
  const laneSet = lanes.length
    ? [
        `    <bpmn:laneSet id="LaneSet_1">`,
        ...lanes.map((lane, i) => [`      <bpmn:lane id="Lane_${i + 1}" name="${escapeXml(lane)}">`, ...steps.filter((s) => laneOf(s) === lane).map((s) => `        <bpmn:flowNodeRef>${s.id}</bpmn:flowNodeRef>`), `      </bpmn:lane>`].join("\n")),
        `    </bpmn:laneSet>`,
      ]
    : [];
  const end = (id: string) => partnerId.get(id) ?? ncname(id);
  const messages = (spec.messages ?? [])
    .map((m, i) => ({ ...m, id: `Message_${i + 1}`, from: end(m.from), to: end(m.to) }))
    .filter((m) => (partnerBox.has(m.from) && ids.has(m.to)) || (ids.has(m.from) && partnerBox.has(m.to)));
  const isGateway = (id: string) => kindOf(steps.find((x) => x.id === id)!.type) === "gateway";
  const edge = (f: (typeof flows)[number]) => {
    const a = pos.get(f.from)!;
    const b = pos.get(f.to)!;
    const sx = a.x + a.w;
    const sy = a.y + a.h / 2;
    const tx = b.x;
    const ty = b.y + b.h / 2;
    const acx = a.x + a.w / 2;
    const bcx = b.x + b.w / 2;
    const below = Math.max(a.y + a.h, b.y + b.h) + 30;
    const points = isBoundary(f.from)
      ? // Out of a boundary event: down from it, then across.
        ty > a.y + a.h
        ? [[acx, a.y + a.h], [acx, ty], [tx, ty]]
        : [[acx, a.y + a.h], [acx, below], [bcx, below], [bcx, b.y + b.h]]
      : tx > sx + 10
        ? sy === ty
          ? [[sx, sy], [tx, ty]]
          : isGateway(f.from)
            ? // Out of a decision to another row: from its top or bottom corner, then across, as modelers draw it.
              [[acx, ty < sy ? a.y : a.y + a.h], [acx, ty], [tx, ty]]
            : isGateway(f.to)
              ? // Into a join from another row: across, then into its top or bottom corner.
                [[sx, sy], [bcx, sy], [bcx, sy < ty ? b.y : b.y + b.h]]
              : [[sx, sy], [Math.round((sx + tx) / 2), sy], [Math.round((sx + tx) / 2), ty], [tx, ty]]
        : // Back to an earlier step: round underneath.
          [[acx, a.y + a.h], [acx, below], [bcx, below], [bcx, b.y + b.h]];
    return line(f.id, points);
  };
  const line = (id: string, points: number[][]) => [`      <bpmndi:BPMNEdge id="${id}_di" bpmnElement="${id}">`, ...points.map(([px, py]) => `        <di:waypoint x="${Math.round(px)}" y="${Math.round(py)}" />`), `      </bpmndi:BPMNEdge>`].join("\n");
  const bounds = (b: Box) => `<dc:Bounds x="${Math.round(b.x)}" y="${Math.round(b.y)}" width="${Math.round(b.w)}" height="${Math.round(b.h)}" />`;
  const shape = (id: string, b: Box, extra = "", label?: Box) =>
    `      <bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}"${extra}>\n        ${bounds(b)}${label ? `\n        <bpmndi:BPMNLabel>\n          ${bounds(label)}\n        </bpmndi:BPMNLabel>` : ""}\n      </bpmndi:BPMNShape>`;
  // A decision's name goes above it when a flow leaves from its bottom, so the two do not cross.
  const gatewayLabel = (s: (typeof steps)[number]) => {
    const p = pos.get(s.id)!;
    if (!s.name || !flows.some((f) => f.from === s.id && pos.get(f.to)!.y > p.y + p.h && pos.get(f.to)!.x > p.x + p.w)) return undefined;
    return { x: p.x + p.w / 2 - 50, y: p.y - 30, w: 100, h: 27 };
  };
  const diShapes = [
    ...(pooled ? [shape("Participant_1", { x: poolX, y: top, w: poolW, h: y - top }, ' isHorizontal="true"')] : []),
    ...partners.map((p) => shape(p.id, partnerBox.get(p.id)!, ' isHorizontal="true"')),
    ...laneBounds.filter((l) => l.name).map((l, i) => shape(`Lane_${i + 1}`, { x: poolX + POOL_LABEL, y: l.y, w: poolW - POOL_LABEL, h: l.h }, ' isHorizontal="true"')),
    ...placed.map((s) => (kindOf(s.type) === "gateway" ? shape(s.id, pos.get(s.id)!, ' isMarkerVisible="true"', gatewayLabel(s)) : shape(s.id, pos.get(s.id)!))),
    // Boundary events after their activities, so they are drawn on top.
    ...steps.filter((s) => s.type === "boundaryEvent").map((s) => shape(s.id, pos.get(s.id)!)),
    ...notes.map((n) => shape(n.id, noteBox.get(n.id)!)),
    ...data.map((d) => shape(d.id, dataBox.get(d.id)!)),
  ];
  const otherEdges = [
    ...notes.map((n) => {
      const on = pos.get(n.on)!;
      const box = noteBox.get(n.id)!;
      return line(`${n.id}_link`, [[on.x + on.w / 2, on.y], [box.x + 20, box.y + box.h]]);
    }),
    ...reads.map((r) => {
      const d = dataBox.get(r.data)!;
      const s = pos.get(r.step)!;
      return line(r.id, [[d.x + d.w / 2 - 6, d.y], [s.x + s.w / 2 - 12, s.y + s.h]]);
    }),
    ...writes.map((w) => {
      const d = dataBox.get(w.data)!;
      const s = pos.get(w.step)!;
      return line(w.id, [[s.x + s.w / 2 + 12, s.y + s.h], [d.x + d.w / 2 + 6, d.y]]);
    }),
    ...messages.map((m, i) => {
      const fromPartner = partnerBox.get(m.from);
      const step = pos.get(fromPartner ? m.to : m.from)!;
      const partner = fromPartner ?? partnerBox.get(m.to)!;
      // Two messages on one step stand apart.
      const x = step.x + step.w / 2 + (fromPartner ? -10 : 10) + (messages.slice(0, i).some((o) => o.from === m.from && o.to === m.to) ? 14 : 0);
      const near = partner.y + partner.h;
      return line(m.id, fromPartner ? [[x, near], [x, step.y]] : [[x, step.y], [x, near]]);
    }),
  ];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn" exporter="ArchONE Diagrams" exporterVersion="1">`,
    ...(pooled
      ? [
          `  <bpmn:collaboration id="Collaboration_1">`,
          `    <bpmn:participant id="Participant_1" name="${escapeXml(spec.name)}" processRef="${process}" />`,
          ...partners.map((p) => `    <bpmn:participant id="${p.id}" name="${escapeXml(p.name)}" />`),
          ...messages.map((m) => `    <bpmn:messageFlow id="${m.id}" sourceRef="${m.from}" targetRef="${m.to}"${m.name ? ` name="${escapeXml(m.name)}"` : ""} />`),
          `  </bpmn:collaboration>`,
        ]
      : []),
    `  <bpmn:process id="${process}" name="${escapeXml(spec.name)}" isExecutable="false">`,
    ...laneSet,
    ...steps.map(stepXml),
    ...flows.map(flowXml),
    ...dataXml,
    ...noteXml,
    `  </bpmn:process>`,
    `  <bpmndi:BPMNDiagram id="BPMNDiagram_1">`,
    `    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${pooled ? "Collaboration_1" : process}">`,
    ...diShapes,
    ...flows.map(edge),
    ...otherEdges,
    `    </bpmndi:BPMNPlane>`,
    `  </bpmndi:BPMNDiagram>`,
    `</bpmn:definitions>`,
    "",
  ].join("\n");
}

/** A new process: a start, one step and an end, ready to model. */
export const blankBpmn = (name: string) =>
  buildBpmn({
    name,
    steps: [
      { id: "Start", name: "Start", type: "startEvent" },
      { id: "Task_1", name: "First step", type: "userTask" },
      { id: "End", name: "Done", type: "endEvent" },
    ],
    flows: [
      { from: "Start", to: "Task_1" },
      { from: "Task_1", to: "End" },
    ],
  });
