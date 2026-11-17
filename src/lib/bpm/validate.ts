import type { ProcessModel } from "../types";
import type { BpmnGraph, BpmnNode } from "./bpmn";

/**
 * Checks of a BPMN model, in the spirit of the rules BPMN tools ship (bpmnlint, Signavio's
 * verification): what makes a model wrong, and what makes it hard to read or to simulate.
 */
export interface ProcessFinding {
  severity: "error" | "warning" | "info";
  elementId: string | null;
  message: string;
}

const isSplit = (n: BpmnNode) => n.outgoing.length > 1;
const label = (n: BpmnNode) => n.name || n.type.replace(/([A-Z])/g, " $1").toLowerCase();

export function checkProcess(graph: BpmnGraph, process?: Pick<ProcessModel, "elements" | "decisions">): ProcessFinding[] {
  const out: ProcessFinding[] = [];
  const nodes = Object.values(graph.nodes);
  const add = (severity: ProcessFinding["severity"], n: BpmnNode | null, message: string) => out.push({ severity, elementId: n?.id ?? null, message });

  for (const p of graph.processes) {
    const own = nodes.filter((n) => n.processId === p.id);
    if (!own.length) continue;
    const name = p.participant || p.name || "The process";
    if (!own.some((n) => n.type === "startEvent" && !n.attachedTo)) add("error", null, `${name} has no start event: where does it begin?`);
    if (!own.some((n) => n.type === "endEvent")) add("error", null, `${name} has no end event: when is it done?`);
  }

  const lanesUsed = graph.lanes.length > 0;
  for (const n of nodes) {
    if (n.kind === "data" || n.kind === "other") continue;
    const start = n.type === "startEvent";
    const end = n.type === "endEvent";
    const boundary = n.type === "boundaryEvent";
    if (start && n.incoming.length) add("error", n, `The start event "${label(n)}" has a flow coming into it.`);
    if (end && n.outgoing.length) add("error", n, `The end event "${label(n)}" has a flow going out of it.`);
    if (!start && !boundary && !n.incoming.length && !n.attachedTo) add("error", n, `Nothing leads to "${label(n)}".`);
    if (!end && !n.outgoing.length) add("error", n, `"${label(n)}" leads nowhere: connect it to the next step or an end event.`);
    if (!n.name && n.kind === "activity") add("warning", n, `A ${label(n)} has no name. Name steps with a verb and an object: "Check the order".`);
    if (!n.name && n.kind === "event" && (start || end) && graph.processes.length) add("info", n, `Name the ${start ? "start" : "end"} event with what happened: "Order received".`);
    if (n.kind === "activity" && isSplit(n)) add("warning", n, `"${label(n)}" splits into ${n.outgoing.length} flows without a gateway. Add a gateway so readers see whether it is a choice or parallel work.`);
    if (lanesUsed && !n.laneId && n.processId === graph.lanes[0]?.processId && !boundary) add("warning", n, `"${label(n)}" is in no lane: who does it?`);

    if (n.kind === "gateway") {
      if (n.incoming.length > 1 && n.outgoing.length > 1) add("warning", n, `The gateway "${label(n)}" both joins and splits. Use one gateway to join and another to split.`);
      if (n.outgoing.length === 1 && n.incoming.length === 1) add("info", n, `The gateway "${label(n)}" has one flow in and one out, so it does nothing.`);
      if ((n.type === "exclusiveGateway" || n.type === "inclusiveGateway") && isSplit(n)) {
        const unnamed = n.outgoing.filter((f) => f !== n.defaultFlow && !graph.flows[f]?.name && !graph.flows[f]?.condition);
        if (unnamed.length) add("warning", n, `${unnamed.length} of the flows out of the decision "${label(n)}" say nothing about when they are taken. Name each one ("Yes", "Amount over 10,000").`);
        if (process) {
          const given = n.outgoing.map((f) => process.elements[f]?.probability).filter((p): p is number => typeof p === "number");
          const sum = given.reduce((a, b) => a + b, 0);
          if (given.length === n.outgoing.length && Math.abs(sum - 100) > 0.5) add("warning", n, `The chances of the flows out of "${label(n)}" add up to ${sum}%, not 100%.`);
        }
      }
    }
    if (process && n.type === "businessRuleTask" && !process.elements[n.id]?.decisionId) add("info", n, `"${label(n)}" is a business rule step: link the decision table it applies.`);
    if (process && n.type === "callActivity" && !process.elements[n.id]?.calledProcessId && !n.calledElement) add("info", n, `"${label(n)}" calls another process: say which.`);
  }

  for (const f of Object.values(graph.flows)) {
    if (f.type !== "messageFlow") continue;
    const a = graph.nodes[f.sourceId];
    const b = graph.nodes[f.targetId];
    if (a && b && a.processId === b.processId) add("error", null, `A message flow joins "${label(a)}" and "${label(b)}" inside one pool. Within a pool, use a sequence flow.`);
  }

  const order = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
