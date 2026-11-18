import { z } from "zod";
import type { ProcessElementInfo } from "../types";
import type { ProcessSpec, SpecStep, StepType } from "./bpmn";

/**
 * A process drafted from a description: by an AI model when the server has one, and by plain
 * rules otherwise (numbered steps, "Role: step" or "step (Role)" for who does it, and "If ...,
 * ...; otherwise ..." for a decision). Either way it becomes a BPMN model to check and change.
 */

export const STEP_TYPES: StepType[] = [
  "startEvent",
  "endEvent",
  "intermediateThrowEvent",
  "intermediateCatchEvent",
  "task",
  "userTask",
  "serviceTask",
  "manualTask",
  "scriptTask",
  "businessRuleTask",
  "sendTask",
  "receiveTask",
  "subProcess",
  "callActivity",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "eventBasedGateway",
];

export interface ProcessDraft {
  spec: ProcessSpec;
  /** Typical minutes per step id, when the draft says. */
  minutes: Record<string, number>;
  /** Percent per flow, by its place in spec.flows. */
  chances: Record<number, number>;
  notes: string;
}

export const PROCESS_SYSTEM_PROMPT = `You turn a description of a business process into a BPMN 2.0 process model.
Answer with one JSON object and nothing else, in this shape:
{"name": "Order to cash", "lanes": ["Sales", "Finance"],
 "steps": [{"id": "s1", "name": "Order received", "type": "startEvent", "lane": "Sales", "trigger": "message"},
           {"id": "s2", "name": "Check the order", "type": "userTask", "lane": "Sales", "minutes": 15},
           {"id": "g1", "name": "Order complete?", "type": "exclusiveGateway", "lane": "Sales"}],
 "flows": [{"from": "s1", "to": "s2"}, {"from": "g1", "to": "s3", "name": "Yes", "probability": 80}],
 "notes": "What you assumed."}
Rules:
- type is one of: ${STEP_TYPES.join(", ")}.
- trigger, for events only, is one of: message, timer, error, signal, conditional, escalation, terminate.
- One start event (or one per way the process can start) and at least one end event, each named with a state: "Invoice paid".
- Name tasks with a verb and an object: "Approve the request". Name decisions as a question; name each flow out of a decision with its answer.
- A step done by a person is a userTask, one done by software a serviceTask, sending a message a sendTask, waiting for one a receiveTask or an intermediateCatchEvent with a message trigger, applying rules a businessRuleTask, physical work a manualTask.
- Use a lane for each role or department that does steps. Use a parallelGateway to split work done at the same time and another to join it.
- Every step except the end events has a flow out of it, and every step except the start events a flow into it.
- minutes is a typical time for the step, when the description says or it is obvious; probability is the percent of cases taking each flow out of a decision, adding up to 100.
- At most 60 steps. Ids are short and unique. Keep the language of the description.`;

export const processUserText = (text: string) => `Model this process:\n\n${text.trim()}`;

/** For a picture: a BPMN diagram, a flowchart, a swimlane chart, a whiteboard, a hand drawing or a page about a process. */
export const processImageText = (note: string) =>
  `Model the business process this picture shows. It may be a BPMN diagram, a flowchart, a swimlane chart, a whiteboard, a hand drawing, or a page of a document that describes a process. Read every box, diamond and circle as a step, every arrow as a flow, and every band or column as a lane. Keep the names as they are written, in their language.${note.trim() ? `\n\nWhat the person who sent it says, and any text that came with it:\n${note.trim().slice(0, 11000)}` : ""}`;

const text = z.union([z.string(), z.number(), z.null(), z.undefined()]).transform((v) => (v === null || v === undefined ? "" : String(v)));
const num = z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((v) => (v === null || v === undefined || v === "" ? undefined : Number(v)));
const rawSchema = z.object({
  name: text,
  lanes: z.array(text).max(20).default([]),
  steps: z.array(z.object({ id: text, name: text, type: text, lane: text, trigger: text, minutes: num })).max(200),
  flows: z.array(z.object({ from: text, to: text, name: text, probability: num })).max(400).default([]),
  notes: text,
});

const TYPE_ALIAS: Record<string, StepType> = { start: "startEvent", end: "endEvent", gateway: "exclusiveGateway", decision: "exclusiveGateway", xor: "exclusiveGateway", and: "parallelGateway", parallel: "parallelGateway", or: "inclusiveGateway", activity: "task", user: "userTask", service: "serviceTask", manual: "manualTask", script: "scriptTask", rule: "businessRuleTask", send: "sendTask", receive: "receiveTask" };
const TRIGGERS = new Set(["message", "timer", "error", "signal", "conditional", "escalation", "terminate", "compensate", "link"]);

/** Makes whatever a model answered into a process that holds together, or null. */
export function normalizeProcessDraft(raw: unknown): ProcessDraft | null {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const ids = new Map<string, string>();
  const steps: SpecStep[] = [];
  const minutes: Record<string, number> = {};
  d.steps.forEach((s, i) => {
    const t = s.type.trim();
    const type = (STEP_TYPES as string[]).includes(t) ? (t as StepType) : TYPE_ALIAS[t.toLowerCase().replace(/(event|task|gateway)$/i, "")] ?? "task";
    let id = (s.id.trim() || `step${i + 1}`).replace(/[^A-Za-z0-9_-]/g, "_");
    if (!/^[A-Za-z_]/.test(id)) id = `s_${id}`;
    while (steps.some((x) => x.id === id)) id = `${id}_${i}`;
    ids.set(s.id.trim() || id, id);
    const trigger = s.trigger.trim().toLowerCase();
    steps.push({ id, name: s.name.trim().slice(0, 200), type, lane: s.lane.trim() || undefined, trigger: TRIGGERS.has(trigger) && /Event$/.test(type) ? trigger : undefined });
    if (s.minutes !== undefined && Number.isFinite(s.minutes) && s.minutes > 0) minutes[id] = Math.min(s.minutes, 525600);
  });
  if (!steps.some((s) => s.type !== "startEvent" && s.type !== "endEvent")) return null;
  const flows: ProcessSpec["flows"] = [];
  const chances: Record<number, number> = {};
  for (const f of d.flows) {
    const from = ids.get(f.from.trim());
    const to = ids.get(f.to.trim());
    if (!from || !to || from === to || flows.some((x) => x.from === from && x.to === to)) continue;
    flows.push({ from, to, name: f.name.trim() || undefined });
    if (f.probability !== undefined && Number.isFinite(f.probability) && f.probability >= 0 && f.probability <= 100) chances[flows.length - 1] = f.probability;
  }
  // A start where nothing leads in and an end where nothing leads out, when the model left them out.
  const into = new Set(flows.map((f) => f.to));
  const outOf = new Set(flows.map((f) => f.from));
  if (!steps.some((s) => s.type === "startEvent")) {
    const first = steps.find((s) => !into.has(s.id)) ?? steps[0];
    steps.unshift({ id: "Start", name: "Start", type: "startEvent", lane: first.lane });
    flows.unshift({ from: "Start", to: first.id });
    shiftChances(chances);
  }
  if (!steps.some((s) => s.type === "endEvent")) {
    const ends = steps.filter((s) => !outOf.has(s.id) && s.type !== "startEvent");
    steps.push({ id: "End", name: "Done", type: "endEvent", lane: ends[0]?.lane });
    for (const e of ends.length ? ends : [steps[steps.length - 2]]) flows.push({ from: e.id, to: "End" });
  }
  const lanes = [...new Set([...d.lanes.map((l) => l.trim()).filter(Boolean), ...steps.map((s) => s.lane ?? "").filter(Boolean)])];
  return { spec: { name: d.name.trim().slice(0, 200) || "New process", lanes: lanes.length >= 2 ? lanes : undefined, steps: lanes.length >= 2 ? steps : steps.map((s) => ({ ...s, lane: undefined })), flows }, minutes, chances, notes: d.notes.trim().slice(0, 2000) };
}

/** A draft as the server sends it, checked again on the way in. */
export function reviveProcessDraft(value: unknown): ProcessDraft | null {
  const d = value as Partial<ProcessDraft> | null;
  if (!d || typeof d !== "object" || !d.spec || !Array.isArray(d.spec.steps) || !Array.isArray(d.spec.flows)) return null;
  const minutes = d.minutes ?? {};
  const chances = d.chances ?? {};
  return normalizeProcessDraft({
    name: d.spec.name,
    lanes: d.spec.lanes ?? [],
    steps: d.spec.steps.map((s) => ({ ...s, minutes: minutes[s.id] })),
    flows: d.spec.flows.map((f, i) => ({ ...f, probability: chances[i] })),
    notes: d.notes,
  });
}

function shiftChances(chances: Record<number, number>) {
  const copy = { ...chances };
  for (const k of Object.keys(chances)) delete chances[Number(k)];
  for (const [k, v] of Object.entries(copy)) chances[Number(k) + 1] = v;
}

/* ---------- Without a model ---------- */

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s: string) => capital(s.trim().replace(/^[-*•\d.)\s]+/, "").replace(/[.;,]+$/, "").trim());

function guessType(name: string): StepType {
  const n = name.toLowerCase();
  if (/\b(send|email|e-mail|notify|inform|tell|publish|post)\b/.test(n)) return "sendTask";
  if (/\b(wait for|receive|receives|gets? the)\b/.test(n)) return "receiveTask";
  if (/\b(score|rule|eligib|calculate the risk|classif)/.test(n)) return "businessRuleTask";
  if (/\b(system|automatic|automatically|generate|sync|import|export|update the record|create the account|api)\b/.test(n)) return "serviceTask";
  if (/\b(pick|pack|ship|deliver|print|sign|install|repair|inspect)\b/.test(n)) return "manualTask";
  return "userTask";
}

/** "Sales: check the order", "Check the order (Sales)", or "check the order". */
function splitRole(raw: string): { name: string; lane?: string } {
  const s = clean(raw);
  const paren = s.match(/^(.*?)\s*\(([^()]{2,40})\)$/);
  if (paren) return { name: clean(paren[1]), lane: paren[2].trim() };
  const colon = s.match(/^([^:]{2,40}):\s*(.+)$/);
  if (colon) return { name: clean(colon[2]), lane: colon[1].trim() };
  return { name: s };
}

const isEnd = (s: string) => /^(the )?(end|stop|finish|done)( the process| here)?[.!]?$/i.test(s.trim());

/** Builds a process from a plain description, one step per line or sentence. */
export function draftProcessFromText(description: string, name = ""): ProcessDraft {
  const lines = description
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const items = (lines.length > 1 ? lines : description.split(/(?<=[.!?])\s+|;\s+|,?\s+then\s+/i)).map((l) => l.trim()).filter((l) => l.replace(/[^\p{L}\p{N}]/gu, "").length > 1);
  const steps: SpecStep[] = [{ id: "Start", name: "Start", type: "startEvent" }];
  const flows: ProcessSpec["flows"] = [];
  let open: { id: string; name?: string }[] = [{ id: "Start" }];
  let n = 0;
  let g = 0;
  const link = (to: string) => {
    for (const o of open) flows.push({ from: o.id, to, name: o.name });
  };
  const addStep = (raw: string) => {
    const { name: stepName, lane } = splitRole(raw);
    const id = `Task_${++n}`;
    steps.push({ id, name: stepName, type: guessType(stepName), lane });
    return id;
  };
  for (const item of items) {
    const decision = item.match(/^(?:\d+[.)]\s*)?(?:if|when|in case)\s+(.+?)(?:,|\bthen\b)\s*(.+?)(?:[;,.]?\s*(?:otherwise|else|if not)[,:]?\s*(.+))?$/i);
    if (decision) {
      const gateway = `Gateway_${++g}`;
      steps.push({ id: gateway, name: `${capital(decision[1].trim().replace(/\?$/, ""))}?`, type: "exclusiveGateway", lane: steps.find((x) => x.id === open[0]?.id)?.lane });
      link(gateway);
      const next: { id: string; name?: string }[] = [];
      for (const [branch, answer] of [
        [decision[2], "Yes"],
        [decision[3], "No"],
      ] as const) {
        if (!branch) {
          next.push({ id: gateway, name: answer });
          continue;
        }
        if (isEnd(branch)) {
          const end = `End_${++n}`;
          steps.push({ id: end, name: answer === "No" ? "Stopped" : "Done", type: "endEvent" });
          flows.push({ from: gateway, to: end, name: answer });
          continue;
        }
        const id = addStep(branch.replace(/\s*(and end|and stop|then end)$/i, ""));
        flows.push({ from: gateway, to: id, name: answer });
        if (/(and end|and stop|then end)$/i.test(branch.trim())) {
          const end = `End_${++n}`;
          steps.push({ id: end, name: "Stopped", type: "endEvent", lane: steps[steps.length - 1].lane });
          flows.push({ from: id, to: end });
        } else next.push({ id });
      }
      open = next;
      continue;
    }
    if (isEnd(item)) break;
    const id = addStep(item);
    link(id);
    open = [{ id }];
  }
  const end = { id: "End", name: "Done", type: "endEvent" as const, lane: steps[steps.length - 1]?.lane };
  steps.push(end);
  link("End");
  // Where two ways meet again, a gateway joins them, as BPMN asks.
  const merged = joinMerges(steps, flows, () => `Gateway_${++g}`);
  const lanes = [...new Set(steps.map((s) => s.lane ?? "").filter(Boolean))];
  if (lanes.length) for (const s of merged.steps) if (!s.lane) s.lane = lanes[0];
  return {
    spec: { name: name.trim() || "New process", lanes: lanes.length >= 2 ? lanes : undefined, steps: lanes.length >= 2 ? merged.steps : merged.steps.map((s) => ({ ...s, lane: undefined })), flows: merged.flows },
    minutes: {},
    chances: {},
    notes: "Drafted with the built-in rules: one step per line, a decision for each \"If ..., ...; otherwise ...\". Check the steps and who does them.",
  };
}

function joinMerges(steps: SpecStep[], flows: ProcessSpec["flows"], gatewayId: () => string) {
  const out = [...flows];
  const added = [...steps];
  for (const s of steps) {
    if (/Gateway$/.test(s.type)) continue;
    const ins = out.filter((f) => f.to === s.id);
    if (ins.length < 2) continue;
    const join = gatewayId();
    added.splice(added.indexOf(s), 0, { id: join, name: "", type: "exclusiveGateway", lane: s.lane });
    for (const f of ins) f.to = join;
    out.push({ from: join, to: s.id });
  }
  return { steps: added, flows: out };
}

/** What a draft says about its steps, as the app keeps it. */
export function draftElements(draft: ProcessDraft): Record<string, ProcessElementInfo> {
  const elements: Record<string, ProcessElementInfo> = {};
  for (const [id, m] of Object.entries(draft.minutes)) elements[id] = { objectIds: [], raci: {}, duration: { min: Math.round(m * 0.5 * 10) / 10, mode: m, max: Math.round(m * 2 * 10) / 10 } };
  for (const [i, p] of Object.entries(draft.chances)) elements[`Flow_${Number(i) + 1}`] = { objectIds: [], raci: {}, probability: p };
  return elements;
}
