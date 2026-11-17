import type { ProcessModel, SimScenario } from "../types";
import { laneName, type BpmnGraph, type BpmnNode } from "./bpmn";

/**
 * What-if simulation of a BPMN process, in the manner of BPSim: cases arrive, each step takes a
 * time drawn between its least and most, people of each role work one step at a time and steps
 * wait for them, decisions follow their chances, parallel branches join before going on. The
 * same scenario with the same seed gives the same answer, so scenarios compare fairly.
 */

export interface StepResult {
  id: string;
  name: string;
  count: number;
  meanWaitMinutes: number;
  meanWorkMinutes: number;
}
export interface ResourceResult {
  role: string;
  count: number;
  utilisation: number;
  cost: number;
}
export interface SimResult {
  scenario: string;
  started: number;
  completed: number;
  meanHours: number;
  medianHours: number;
  p90Hours: number;
  meanWaitHours: number;
  costPerCase: number;
  steps: StepResult[];
  resources: ResourceResult[];
  /** The step people wait longest for. */
  bottleneck: string | null;
  /** What the simulation had to assume, said with the results. */
  notes: string[];
}

/** A small seeded random generator (mulberry32), so a run can be repeated. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const triangular = (r: number, min: number, mode: number, max: number) => {
  if (max <= min) return min;
  const c = (mode - min) / (max - min);
  return r < c ? min + Math.sqrt(r * (max - min) * (mode - min)) : max - Math.sqrt((1 - r) * (max - min) * (max - mode));
};

/** Steps with no time of their own take this long, in minutes, so a first run still says something. */
const DEFAULT_MINUTES: Record<string, number> = { userTask: 10, manualTask: 15, task: 10, serviceTask: 1, scriptTask: 1, businessRuleTask: 1, sendTask: 1, receiveTask: 5, callActivity: 30, subProcess: 30 };
const AUTOMATIC = new Set(["serviceTask", "scriptTask", "businessRuleTask", "sendTask"]);

/** The role that does a step: the one set on it, else its lane, else none (for automated steps). */
export function roleOf(graph: BpmnGraph, process: Pick<ProcessModel, "elements">, node: BpmnNode): string {
  const set = process.elements[node.id]?.resource?.trim();
  if (set) return set;
  if (AUTOMATIC.has(node.type)) return "";
  return laneName(graph, node.id) || "Staff";
}

/** The roles a process needs, so a scenario can say how many of each there are. */
export function rolesOf(graph: BpmnGraph, process: Pick<ProcessModel, "elements">): string[] {
  return [...new Set(Object.values(graph.nodes).filter((n) => n.kind === "activity").map((n) => roleOf(graph, process, n)).filter(Boolean))].sort();
}

interface Token {
  caseId: number;
  nodeId: string;
}

class Heap<T> {
  private items: { at: number; seq: number; value: T }[] = [];
  private seq = 0;
  get size() {
    return this.items.length;
  }
  push(at: number, value: T) {
    const item = { at, seq: this.seq++, value };
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].at < item.at || (a[p].at === item.at && a[p].seq < item.seq)) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = item;
  }
  pop(): { at: number; value: T } | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        const better = (x: number, y: { at: number; seq: number }) => a[x].at < y.at || (a[x].at === y.at && a[x].seq < y.seq);
        let best: { at: number; seq: number } = last;
        if (l < a.length && better(l, best)) {
          m = l;
          best = a[l];
        }
        if (r < a.length && better(r, best)) m = r;
        if (m === i) break;
        a[i] = a[m];
        i = m;
      }
      a[i] = last;
    }
    return { at: top.at, value: top.value };
  }
}

export function simulate(graph: BpmnGraph, process: Pick<ProcessModel, "elements">, scenario: SimScenario, seed = 7): SimResult {
  const rand = random(seed);
  const notes: string[] = [];
  const nodes = graph.nodes;
  const start = Object.values(nodes).find((n) => n.type === "startEvent" && !n.attachedTo);
  if (!start) throw new Error("The process has no start event to simulate from.");
  const roles = rolesOf(graph, process);
  const capacity = new Map(roles.map((r) => [r, Math.max(0, scenario.resources[r]?.count ?? 1)]));
  const costPerHour = new Map(roles.map((r) => [r, scenario.resources[r]?.costPerHour ?? 0]));
  const missing = roles.filter((r) => !scenario.resources[r]);
  if (missing.length) notes.push(`${missing.join(", ")}: one of each was assumed`);
  const untimed = Object.values(nodes).filter((n) => n.kind === "activity" && !process.elements[n.id]?.duration);
  if (untimed.length) notes.push(untimed.length === 1 ? "One step has no time set, so a typical time was used" : `${untimed.length} steps have no time set, so a typical time was used`);
  if (Object.values(nodes).some((n) => n.type === "inclusiveGateway" && n.outgoing.length > 1)) notes.push("An inclusive decision takes one of its flows here");

  const busy = new Map(roles.map((r) => [r, 0]));
  const busyMinutes = new Map(roles.map((r) => [r, 0]));
  const queues = new Map<string, { token: Token; queuedAt: number }[]>(roles.map((r) => [r, []]));
  const stats = new Map<string, { count: number; wait: number; work: number }>();
  const joins = new Map<string, number>(); // `${case}:${node}` -> tokens arrived
  const live = new Map<number, number>(); // tokens alive per case
  const begun = new Map<number, number>();
  const visits = new Map<number, number>();
  const waits = new Map<number, number>();
  const cycle: number[] = [];
  let fixedCost = 0;
  let unfinished = 0;
  const events = new Heap<{ type: "arrive" | "enter" | "done"; token: Token; role?: string; startedAt?: number }>();

  const duration = (node: BpmnNode) => {
    const info = process.elements[node.id];
    const factor = scenario.changes[node.id]?.durationFactor ?? 1;
    const d = info?.duration;
    const base = d ? triangular(rand(), d.min, Math.min(Math.max(d.mode, d.min), d.max), Math.max(d.max, d.min)) : (DEFAULT_MINUTES[node.type] ?? 0);
    return Math.max(0, base * factor);
  };
  const chance = (flowId: string) => scenario.changes[flowId]?.probability ?? process.elements[flowId]?.probability;
  const pick = (node: BpmnNode): string[] => {
    const outs = node.outgoing.filter((f) => graph.flows[f]);
    if (outs.length <= 1) return outs;
    if (node.type === "parallelGateway") return outs;
    const given = outs.map(chance);
    const known = given.reduce<number>((a, p) => a + (p ?? 0), 0);
    const unknown = given.filter((p) => p === undefined).length;
    const rest = Math.max(0, 100 - known);
    const weights = given.map((p) => (p === undefined ? (unknown ? rest / unknown : 0) : p));
    const total = weights.reduce((a, b) => a + b, 0) || outs.length;
    let r = rand() * total;
    for (let i = 0; i < outs.length; i++) {
      r -= weights[i] || (total === outs.length ? 1 : 0);
      if (r <= 0) return [outs[i]];
    }
    return [outs[outs.length - 1]];
  };
  const forward = (at: number, token: Token, flowIds: string[]) => {
    live.set(token.caseId, (live.get(token.caseId) ?? 1) - 1 + flowIds.length);
    for (const f of flowIds) events.push(at, { type: "enter", token: { caseId: token.caseId, nodeId: graph.flows[f].targetId } });
    if (!flowIds.length) finishToken(at, token);
  };
  const finishToken = (at: number, token: Token) => {
    if ((live.get(token.caseId) ?? 0) > 0) return;
    live.delete(token.caseId);
    cycle.push(at - begun.get(token.caseId)!);
  };
  const startWork = (at: number, token: Token, role: string, queuedAt: number) => {
    const node = nodes[token.nodeId];
    const d = duration(node);
    const s = stats.get(node.id) ?? { count: 0, wait: 0, work: 0 };
    s.count++;
    s.wait += at - queuedAt;
    s.work += d;
    stats.set(node.id, s);
    waits.set(token.caseId, (waits.get(token.caseId) ?? 0) + (at - queuedAt));
    fixedCost += process.elements[node.id]?.cost ?? 0;
    if (role) {
      busy.set(role, busy.get(role)! + 1);
      busyMinutes.set(role, busyMinutes.get(role)! + d);
    }
    events.push(at + d, { type: "done", token, role, startedAt: at });
  };

  let t = 0;
  for (let i = 0; i < scenario.cases; i++) {
    events.push(t, { type: "arrive", token: { caseId: i, nodeId: start.id } });
    t += -Math.log(1 - rand()) * scenario.arrivalMinutes;
  }
  // How busy a role is, over the time cases keep arriving: above 100% a queue only grows.
  const period = t;
  let now = 0;
  let guard = 0;
  const limit = scenario.cases * 2000;
  while (events.size && guard++ < limit) {
    const e = events.pop()!;
    now = e.at;
    const { token } = e.value;
    if (e.value.type === "arrive") {
      begun.set(token.caseId, now);
      live.set(token.caseId, 1);
      events.push(now, { type: "enter", token });
      continue;
    }
    const node = nodes[token.nodeId];
    if (!node) continue;
    if (e.value.type === "enter") {
      const v = (visits.get(token.caseId) ?? 0) + 1;
      visits.set(token.caseId, v);
      if (v > 500) {
        // A loop that never ends: drop the case.
        live.delete(token.caseId);
        unfinished++;
        continue;
      }
      if (node.type === "parallelGateway" && node.incoming.length > 1) {
        const key = `${token.caseId}:${node.id}`;
        const arrived = (joins.get(key) ?? 0) + 1;
        if (arrived < node.incoming.length) {
          joins.set(key, arrived);
          live.set(token.caseId, (live.get(token.caseId) ?? 1) - 1);
          continue;
        }
        joins.delete(key);
      }
      if (node.kind === "activity") {
        const role = roleOf(graph, process, node);
        if (role && (capacity.get(role) ?? 1) === 0) {
          unfinished++;
          live.delete(token.caseId);
          continue;
        }
        if (role && busy.get(role)! >= capacity.get(role)!) queues.get(role)!.push({ token, queuedAt: now });
        else startWork(now, token, role, now);
        continue;
      }
      if (node.kind === "event" && node.type !== "startEvent" && (node.trigger === "timer" || process.elements[node.id]?.duration)) {
        events.push(now + duration(node), { type: "done", token });
        continue;
      }
      if (node.type === "endEvent" || (node.trigger === "terminate" && node.kind === "event")) {
        forward(now, token, []);
        continue;
      }
      forward(now, token, pick(node));
      continue;
    }
    // A step or a timer is done.
    if (e.value.role) {
      const role = e.value.role;
      busy.set(role, busy.get(role)! - 1);
      const next = queues.get(role)!.shift();
      if (next) startWork(now, next.token, role, next.queuedAt);
    }
    forward(now, token, pick(node));
  }
  if (guard >= limit) notes.push("The run was stopped: some cases went round a loop too often");
  if (unfinished) notes.push(`${unfinished} cases could not finish: a loop without end, or a role with no one in it`);

  const sorted = [...cycle].sort((a, b) => a - b);
  const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  const horizon = Math.max(Math.min(period, now), 1);
  const resources = roles.map((role) => {
    const count = capacity.get(role)!;
    const minutes = busyMinutes.get(role)!;
    return { role, count, utilisation: count ? Math.min(1, minutes / (count * horizon)) : 0, cost: (minutes / 60) * costPerHour.get(role)! };
  });
  const steps = [...stats.entries()].map(([id, s]) => ({ id, name: nodes[id].name || nodes[id].type, count: s.count, meanWaitMinutes: s.wait / s.count, meanWorkMinutes: s.work / s.count }));
  const peopleCost = resources.reduce((a, r) => a + r.cost, 0);
  const worst = [...steps].sort((a, b) => b.meanWaitMinutes - a.meanWaitMinutes)[0];
  const completed = sorted.length;
  return {
    scenario: scenario.name,
    started: scenario.cases,
    completed,
    meanHours: completed ? sorted.reduce((a, b) => a + b, 0) / completed / 60 : 0,
    medianHours: q(0.5) / 60,
    p90Hours: q(0.9) / 60,
    meanWaitHours: completed ? [...waits.values()].reduce((a, b) => a + b, 0) / Math.max(1, waits.size) / 60 : 0,
    costPerCase: completed ? (peopleCost + fixedCost) / scenario.cases : 0,
    steps: steps.sort((a, b) => b.meanWaitMinutes + b.meanWorkMinutes - (a.meanWaitMinutes + a.meanWorkMinutes)),
    resources,
    bottleneck: worst && worst.meanWaitMinutes > 1 ? worst.name : null,
    notes,
  };
}

/** A first scenario for a process: one of each role at no cost, a case every half hour. */
export function baseScenario(graph: BpmnGraph, process: Pick<ProcessModel, "elements">, id = "base"): SimScenario {
  return { id, name: "As is", cases: 500, arrivalMinutes: 30, resources: Object.fromEntries(rolesOf(graph, process).map((r) => [r, { count: 1, costPerHour: 0 }])), changes: {} };
}
