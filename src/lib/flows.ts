import { newId, nowIso } from "./model";
import type { Diagram, Flow, FlowStep, Workspace } from "./types";
import { visibleEdges } from "./views";

/**
 * A flow tells one use case step by step over a diagram: who talks to whom, in what order.
 * It belongs to the diagram and points at the boxes on it, so the same picture can carry
 * several stories without being redrawn. Steps do not change the model.
 */

export const MAX_FLOWS = 30;
export const MAX_STEPS = 60;
const MAX_NAME = 120;
const MAX_TEXT = 400;

export const flowsOf = (diagram: Diagram): Flow[] => diagram.flows ?? [];

function withFlows(ws: Workspace, diagramId: string, change: (flows: Flow[]) => Flow[]): Workspace {
  const diagram = ws.diagrams[diagramId];
  if (!diagram) return ws;
  const flows = change(flowsOf(diagram));
  const { flows: _old, ...rest } = diagram;
  // A diagram without flows carries no empty list, so it compares equal to one that never had any.
  const next: Diagram = { ...rest, ...(flows.length ? { flows } : {}), updatedAt: nowIso() };
  return { ...ws, diagrams: { ...ws.diagrams, [diagramId]: next }, updatedAt: nowIso() };
}

const patchFlow = (ws: Workspace, diagramId: string, flowId: string, change: (flow: Flow) => Flow) =>
  withFlows(ws, diagramId, (flows) => flows.map((f) => (f.id === flowId ? change(f) : f)));

export function addFlow(ws: Workspace, diagramId: string, name: string): { ws: Workspace; flow: Flow | null } {
  const diagram = ws.diagrams[diagramId];
  if (!diagram || flowsOf(diagram).length >= MAX_FLOWS) return { ws, flow: null };
  const flow: Flow = { id: newId("flow"), name: name.trim().slice(0, MAX_NAME) || `Flow ${flowsOf(diagram).length + 1}`, description: "", steps: [] };
  return { ws: withFlows(ws, diagramId, (flows) => [...flows, flow]), flow };
}

export function updateFlow(ws: Workspace, diagramId: string, flowId: string, patch: Partial<Pick<Flow, "name" | "description">>): Workspace {
  return patchFlow(ws, diagramId, flowId, (f) => ({
    ...f,
    name: patch.name !== undefined ? patch.name.trim().slice(0, MAX_NAME) || f.name : f.name,
    description: patch.description !== undefined ? patch.description.trim().slice(0, MAX_TEXT) : f.description,
  }));
}

export const deleteFlow = (ws: Workspace, diagramId: string, flowId: string) => withFlows(ws, diagramId, (flows) => flows.filter((f) => f.id !== flowId));

/** Adds a step at the end. Both ends have to be boxes on the diagram; the same box twice means something happens inside it. */
export function addStep(ws: Workspace, diagramId: string, flowId: string, fromId: string, toId: string, text = ""): { ws: Workspace; step: FlowStep | null } {
  const diagram = ws.diagrams[diagramId];
  const flow = diagram && flowsOf(diagram).find((f) => f.id === flowId);
  if (!diagram || !flow || flow.steps.length >= MAX_STEPS || !(fromId in diagram.nodes) || !(toId in diagram.nodes)) return { ws, step: null };
  const step: FlowStep = { id: newId("step"), fromId, toId, text: text.trim().slice(0, MAX_TEXT) };
  return { ws: patchFlow(ws, diagramId, flowId, (f) => ({ ...f, steps: [...f.steps, step] })), step };
}

export function updateStep(ws: Workspace, diagramId: string, flowId: string, stepId: string, patch: Partial<Pick<FlowStep, "fromId" | "toId" | "text">>): Workspace {
  const diagram = ws.diagrams[diagramId];
  if (!diagram) return ws;
  const on = (id: string | undefined, fallback: string) => (id !== undefined && id in diagram.nodes ? id : fallback);
  return patchFlow(ws, diagramId, flowId, (f) => ({
    ...f,
    steps: f.steps.map((s) => (s.id === stepId ? { ...s, fromId: on(patch.fromId, s.fromId), toId: on(patch.toId, s.toId), text: patch.text !== undefined ? patch.text.trim().slice(0, MAX_TEXT) : s.text } : s)),
  }));
}

export function moveStep(ws: Workspace, diagramId: string, flowId: string, stepId: string, by: -1 | 1): Workspace {
  return patchFlow(ws, diagramId, flowId, (f) => {
    const at = f.steps.findIndex((s) => s.id === stepId);
    const to = at + by;
    if (at < 0 || to < 0 || to >= f.steps.length) return f;
    const steps = [...f.steps];
    [steps[at], steps[to]] = [steps[to], steps[at]];
    return { ...f, steps };
  });
}

export const deleteStep = (ws: Workspace, diagramId: string, flowId: string, stepId: string) =>
  patchFlow(ws, diagramId, flowId, (f) => ({ ...f, steps: f.steps.filter((s) => s.id !== stepId) }));

export interface StepView {
  /** Boxes to bring forward. Everything else on the diagram is dimmed. */
  nodes: string[];
  /** The arrows drawn between the two boxes, in either direction. Empty when the diagram draws none. */
  edges: string[];
  /** A box of the step is no longer on the diagram. */
  missing: boolean;
}

/** What one step lights up on the diagram. */
export function stepView(ws: Workspace, diagram: Diagram, step: FlowStep): StepView {
  const here = (id: string) => id in diagram.nodes && !!ws.objects[id];
  const missing = !here(step.fromId) || !here(step.toId);
  const nodes = [...new Set([step.fromId, step.toId])].filter(here);
  const edges =
    step.fromId === step.toId || missing
      ? []
      : visibleEdges(ws, diagram)
          .filter((e) => (e.sourceId === step.fromId && e.targetId === step.toId) || (e.sourceId === step.toId && e.targetId === step.fromId))
          .map((e) => e.id);
  return { nodes, edges, missing };
}

/** "Billing service to Ledger database", or the one name for a step inside a box. */
export function stepRoute(ws: Workspace, step: FlowStep): string {
  const name = (id: string) => ws.objects[id]?.name || "a box that is gone";
  return step.fromId === step.toId ? `Inside ${name(step.fromId)}` : `${name(step.fromId)} to ${name(step.toId)}`;
}

/** The step as one line of plain text, for a document or a screen reader. */
export const stepLine = (ws: Workspace, step: FlowStep, index: number) => `${index + 1}. ${stepRoute(ws, step)}${step.text ? `: ${step.text}` : ""}`;
