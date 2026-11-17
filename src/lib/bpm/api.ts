import type { ProcessElementInfo, ProcessModel, SimScenario } from "../types";
import { activitiesInOrder, blankBpmn, buildBpmn, laneName, parseBpmn, type BpmnGraph } from "./bpmn";
import { STEP_TYPES, draftElements, normalizeProcessDraft } from "./draft";
import { baseScenario, roleOf, simulate, type SimResult } from "./simulate";
import { checkProcess } from "./validate";

/**
 * Processes through the REST API and the MCP server. A request may send the steps of a process
 * as a list instead of a BPMN file; it is laid out here, the same way the app lays out a
 * template, and the database checks and stores the result. The answers an assistant reads are
 * worked out here too: the steps in order, who does them, the systems they use, the checks, and
 * a what-if simulation.
 */

export class ProcessRequestError extends Error {}

const TYPE_WORDS = new Set<string>([...STEP_TYPES, "start", "end", "decision", "parallel"]);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** Turns "steps" (and "flows", "lanes") into the BPMN file and step details the app keeps. */
export function processRequestBody(body: unknown, creating: boolean): unknown {
  if (!isObject(body)) return body;
  const b: Record<string, unknown> = { ...body };
  const name = str(b.name);
  if (b.steps !== undefined) {
    if (b.xml !== undefined) throw new ProcessRequestError('Send either "steps" (with "flows") or "xml", not both.');
    if (!Array.isArray(b.steps) || !b.steps.length || b.steps.length > 200) throw new ProcessRequestError('"steps" has to be a list of 1 to 200 steps, each {"id", "name", "type"}.');
    if (b.flows !== undefined && !Array.isArray(b.flows)) throw new ProcessRequestError('"flows" has to be a list of {"from", "to"}.');
    if (b.lanes !== undefined && !Array.isArray(b.lanes)) throw new ProcessRequestError('"lanes" has to be a list of role or team names.');
    const steps = b.steps.map((s, i) => {
      if (!isObject(s)) throw new ProcessRequestError(`Step ${i + 1} has to be an object.`);
      const type = str(s.type) || "userTask";
      if (!TYPE_WORDS.has(type)) throw new ProcessRequestError(`Step ${i + 1} has the type "${type}". Use one of: ${STEP_TYPES.join(", ")}.`);
      return { ...s, id: str(s.id) || `step${i + 1}`, type };
    });
    const ids = new Set(steps.map((s) => s.id));
    if (ids.size !== steps.length) throw new ProcessRequestError("Two steps have the same id.");
    // Without flows, the steps follow one another in the order given.
    const flows = (b.flows as unknown[] | undefined) ?? steps.slice(1).map((s, i) => ({ from: steps[i].id, to: s.id }));
    flows.forEach((f, i) => {
      if (!isObject(f) || !ids.has(str(f.from)) || !ids.has(str(f.to))) throw new ProcessRequestError(`Flow ${i + 1} has to join two steps of this request by their ids: {"from", "to"}.`);
    });
    const draft = normalizeProcessDraft({ name, lanes: b.lanes ?? [], steps, flows, notes: "" });
    if (!draft) throw new ProcessRequestError('"steps" needs at least one task, a step that is neither a start nor an end.');
    b.xml = buildBpmn({ ...draft.spec, name });
    b.elements = { ...draftElements(draft), ...(isObject(b.elements) ? b.elements : {}) };
  } else if (creating && b.xml === undefined) {
    // A process starts with a start, one step and an end, as in the app. The database uses it
    // only when the level comes out at 2 or below: an area or a group has no model.
    b.defaultXml = blankBpmn(name || "New process");
  }
  delete b.steps;
  delete b.flows;
  delete b.lanes;
  return b;
}

/** A process as the API returns it in full. */
export interface ApiProcess {
  id: string;
  name: string;
  description: string;
  level: number;
  parentId: string | null;
  category: string;
  owner: string;
  status: string;
  version: number;
  tags: string[];
  frequency: string;
  xml: string;
  elements: Record<string, ProcessElementInfo>;
  decisions: Record<string, { name: string }>;
  scenarios: SimScenario[];
  kpis: { name: string; unit: string; target: string; actual: string; better: string }[];
  risks: { name: string; severity: string; control: string }[];
  versions: { version: number; publishedAt: string; publishedBy: string; note: string }[];
  objects: Record<string, { name: string; typeId: string }>;
  reviewer: string;
  reviewNote: string;
  updatedAt: string;
}

const graphFor = (p: ApiProcess): BpmnGraph | null => {
  if (!p.xml) return null;
  try {
    return parseBpmn(p.xml);
  } catch {
    return null;
  }
};

/** The process as an assistant reads it: its steps in order, its flows, and what to check. */
export function describeProcess(body: unknown) {
  const p = body as ApiProcess;
  const graph = graphFor(p);
  const elements = p.elements ?? {};
  const named = (id: string) => p.objects?.[id]?.name ?? id;
  const steps = graph
    ? activitiesInOrder(graph).map((n) => {
        const info = elements[n.id];
        return {
          id: n.id,
          name: n.name,
          type: n.type,
          lane: laneName(graph, n.id) || undefined,
          doneBy: roleOf(graph, { elements }, n) || "automated",
          minutes: info?.duration,
          cost: info?.cost,
          automation: info?.automation,
          systems: (info?.objectIds ?? []).map(named),
          raci: info?.raci && Object.keys(info.raci).length ? info.raci : undefined,
          decision: info?.decisionId ? (p.decisions?.[info.decisionId]?.name ?? info.decisionId) : undefined,
          notes: info?.notes,
        };
      })
    : [];
  const label = (id: string) => graph?.nodes[id]?.name || graph?.nodes[id]?.type || id;
  const flows = graph
    ? Object.values(graph.flows)
        .filter((f) => f.type === "sequenceFlow")
        .map((f) => ({ id: f.id, from: label(f.sourceId), to: label(f.targetId), when: f.name || f.condition || undefined, chance: elements[f.id]?.probability }))
    : [];
  const decisions = graph ? Object.values(graph.nodes).filter((n) => n.kind === "gateway").map((n) => ({ id: n.id, name: n.name || n.type, type: n.type })) : [];
  const findings = graph ? checkProcess(graph, { elements, decisions: (p.decisions ?? {}) as unknown as ProcessModel["decisions"] }).map((f) => ({ severity: f.severity, step: f.elementId ? label(f.elementId) : undefined, message: f.message })) : [];
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    version: p.version,
    owner: p.owner,
    level: p.level,
    category: p.category,
    frequency: p.frequency,
    lanes: graph?.lanes.map((l) => l.name).filter(Boolean) ?? [],
    steps,
    decisions,
    flows,
    findings,
    kpis: p.kpis ?? [],
    risks: p.risks ?? [],
    versions: p.versions ?? [],
    modelled: !!graph,
    ...(p.xml && !graph ? { problem: "The BPMN file could not be read." } : {}),
  };
}

const minutes = (m?: { min: number; mode: number; max: number }) => (m ? `${m.mode} min (${m.min} to ${m.max})` : "");

/** The same as readable text. */
export function processText(d: ReturnType<typeof describeProcess>): string {
  const lines = [`${d.name} (${d.status}${d.version ? `, version ${d.version}` : ""})${d.owner ? `, owned by ${d.owner}` : ""}.`];
  if (d.description) lines.push(d.description);
  if (!d.modelled) lines.push("It has no model yet.");
  if (d.lanes.length) lines.push(`Lanes: ${d.lanes.join(", ")}.`);
  if (d.steps.length) {
    lines.push("Steps:");
    d.steps.forEach((s, i) => {
      const parts = [s.type, s.doneBy !== "automated" ? `by ${s.doneBy}` : "automated", minutes(s.minutes), s.systems.length ? `uses ${s.systems.join(", ")}` : "", s.decision ? `applies ${s.decision}` : ""].filter(Boolean);
      lines.push(`${i + 1}. ${s.name || "(no name)"} [${s.id}]: ${parts.join("; ")}`);
    });
  }
  const choices = d.flows.filter((f) => f.when || f.chance !== undefined);
  if (choices.length) lines.push(`Decisions: ${choices.map((f) => `${f.from} → ${f.to}${f.when ? ` when "${f.when}"` : ""}${f.chance !== undefined ? ` (${f.chance}%)` : ""}`).join("; ")}.`);
  if (d.findings.length) lines.push(`To check: ${d.findings.map((f) => `${f.severity}: ${f.message}`).join(" ")}`);
  if (d.kpis.length) lines.push(`Measures: ${d.kpis.map((k) => `${k.name} ${k.actual || "?"} (target ${k.target || "none"}${k.unit ? ` ${k.unit}` : ""})`).join("; ")}.`);
  if (d.risks.length) lines.push(`Risks: ${d.risks.map((r) => `${r.name} (${r.severity})${r.control ? `, control: ${r.control}` : ""}`).join("; ")}.`);
  return lines.join("\n");
}

export interface WhatIf {
  cases?: number;
  arrivalMinutes?: number;
  /** People per role. */
  people?: Record<string, number>;
  costPerHour?: Record<string, number>;
  /** Time factor per step, by id or name: 0.5 halves it. */
  faster?: Record<string, number>;
  /** Percent per flow out of a decision, by flow id. */
  chances?: Record<string, number>;
}

const roundResult = (r: SimResult) => ({
  completed: r.completed,
  started: r.started,
  averageHours: Math.round(r.meanHours * 100) / 100,
  medianHours: Math.round(r.medianHours * 100) / 100,
  p90Hours: Math.round(r.p90Hours * 100) / 100,
  averageWaitHours: Math.round(r.meanWaitHours * 100) / 100,
  costPerCase: Math.round(r.costPerCase * 100) / 100,
  bottleneck: r.bottleneck,
  roles: r.resources.map((x) => ({ role: x.role, people: x.count, busy: Math.round(x.utilisation * 100) / 100 })),
  steps: r.steps.slice(0, 12).map((s) => ({ step: s.name, done: s.count, waitMinutes: Math.round(s.meanWaitMinutes * 10) / 10, workMinutes: Math.round(s.meanWorkMinutes * 10) / 10 })),
  notes: r.notes,
});

/** Runs the process as it is and, when a change is asked for, with the change: the two side by side. */
export function simulateProcess(body: unknown, ask: WhatIf) {
  const p = body as ApiProcess;
  const graph = graphFor(p);
  if (!graph) return { process: p.name, problem: p.xml ? "The BPMN file could not be read." : "The process has no model to simulate yet." };
  const elements = p.elements ?? {};
  const asIs: SimScenario = p.scenarios?.[0] ?? baseScenario(graph, { elements });
  const base: SimScenario = { ...asIs, cases: Math.max(1, Math.min(5000, Math.round(ask.cases ?? asIs.cases))), arrivalMinutes: Math.max(0.01, ask.arrivalMinutes ?? asIs.arrivalMinutes) };
  const byName = new Map(Object.values(graph.nodes).map((n) => [n.name.trim().toLowerCase(), n.id]));
  const stepId = (key: string) => (graph.nodes[key] ? key : byName.get(key.trim().toLowerCase()));
  const unknown: string[] = [];
  const changed: SimScenario = { ...base, id: "what-if", name: "What if", resources: { ...base.resources }, changes: { ...base.changes } };
  for (const [role, count] of Object.entries(ask.people ?? {})) changed.resources[role] = { count: Math.max(0, Math.round(count)), costPerHour: changed.resources[role]?.costPerHour ?? 0 };
  for (const [role, cost] of Object.entries(ask.costPerHour ?? {})) changed.resources[role] = { count: changed.resources[role]?.count ?? 1, costPerHour: Math.max(0, cost) };
  for (const [key, factor] of Object.entries(ask.faster ?? {})) {
    const id = stepId(key);
    if (id) changed.changes[id] = { ...changed.changes[id], durationFactor: Math.max(0, factor) };
    else unknown.push(key);
  }
  for (const [id, probability] of Object.entries(ask.chances ?? {})) {
    if (graph.flows[id]) changed.changes[id] = { ...changed.changes[id], probability: Math.max(0, Math.min(100, probability)) };
    else unknown.push(id);
  }
  const asked = !!(Object.keys(ask.people ?? {}).length || Object.keys(ask.costPerHour ?? {}).length || Object.keys(ask.faster ?? {}).length || Object.keys(ask.chances ?? {}).length);
  const now = roundResult(simulate(graph, { elements }, base));
  const after = asked ? roundResult(simulate(graph, { elements }, changed)) : null;
  const pct = (a: number, b: number) => (a ? Math.round(((b - a) / a) * 100) : 0);
  return {
    process: p.name,
    cases: base.cases,
    arrivalMinutes: base.arrivalMinutes,
    roles: rolesWithPeople(base),
    asIs: now,
    ...(after ? { whatIf: after, change: { averageTime: `${pct(now.averageHours, after.averageHours)}%`, averageWait: `${pct(now.averageWaitHours, after.averageWaitHours)}%`, costPerCase: `${pct(now.costPerCase, after.costPerCase)}%` } } : {}),
    ...(unknown.length ? { notFound: unknown } : {}),
  };
}

const rolesWithPeople = (s: SimScenario) => Object.fromEntries(Object.entries(s.resources).map(([r, v]) => [r, v.count]));

export function simulationText(r: ReturnType<typeof simulateProcess>): string {
  if ("problem" in r && r.problem) return `${r.process}: ${r.problem}`;
  const s = r as Exclude<ReturnType<typeof simulateProcess>, { problem: string }>;
  const line = (label: string, x: ReturnType<typeof roundResult>) =>
    `${label}: ${x.completed} of ${x.started} cases done; on average ${x.averageHours} h, 9 in 10 within ${x.p90Hours} h, waiting ${x.averageWaitHours} h${x.costPerCase ? `, ${x.costPerCase} a case` : ""}${x.bottleneck ? `; the longest wait is for "${x.bottleneck}"` : ""}. Busy: ${x.roles.map((ro) => `${ro.role} ×${ro.people} ${Math.round(ro.busy * 100)}%`).join(", ") || "no people"}.`;
  const lines = [`${s.process}, ${s.cases} cases, one every ${s.arrivalMinutes} minutes on average.`, line("As it is", s.asIs)];
  if (s.whatIf) lines.push(line("With the change", s.whatIf), `Change: average time ${s.change?.averageTime}, waiting ${s.change?.averageWait}, cost ${s.change?.costPerCase}.`);
  if (s.notFound) lines.push(`Not found in the model: ${s.notFound.join(", ")}.`);
  lines.push("This is a model: times come from what the process says about its steps, so it shows the direction and size of a change rather than a forecast.");
  return lines.join("\n");
}
