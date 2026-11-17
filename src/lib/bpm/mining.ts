import { parseXml, type XmlNode } from "../import/xml";
import { activitiesInOrder, type BpmnGraph, type ProcessSpec, type SpecStep } from "./bpmn";

/**
 * Process mining in the browser: an event log (CSV, XES or OCEL 2.0) becomes the process as it
 * really runs, with how often each path is taken and how long people wait between steps, its
 * variants, and how far it keeps to a BPMN model. The log never leaves the computer.
 */

export interface LogEvent {
  caseId: string;
  activity: string;
  time: number;
  resource: string;
}
export interface EventLog {
  source: string;
  format: string;
  events: LogEvent[];
  /** For an object-centric log: its object types, and which one the cases follow. */
  objectTypes?: string[];
  caseType?: string;
  skipped: number;
}

export class LogError extends Error {}

/* ---------- Reading logs ---------- */

const CASE = /^(case[\s_:-]?(id|key|concept:name)?|caseid|trace[\s_]?id|order[\s_]?(id|number)|ticket[\s_]?(id|number)|application[\s_]?id|request[\s_]?id|instance[\s_]?id)$/i;
const ACTIVITY = /^(activity|activity[\s_]?name|event|event[\s_]?name|concept:name|task|step|action|status)$/i;
const TIME = /^(timestamp|time|time:timestamp|date|datetime|start|start[\s_]?time|end|end[\s_]?time|complete|completed[\s_]?at|event[\s_]?time|created[\s_]?at)$/i;
const RESOURCE = /^(resource|org:resource|user|performer|owner|agent|role|org:role|assignee|employee)$/i;

function splitCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t", "|"].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

/** A time from a log: ISO dates, "dd/mm/yyyy hh:mm", "yyyy-mm-dd hh:mm:ss", or seconds or milliseconds since 1970. */
export function parseTime(raw: string): number {
  const v = raw.trim();
  if (!v) return NaN;
  if (/^\d{9,13}(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n < 1e11 ? n * 1000 : n;
  }
  const dmy = v.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmy) return Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1], +(dmy[4] ?? 0), +(dmy[5] ?? 0), +(dmy[6] ?? 0));
  const iso = Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(v) ? v.replace(" ", "T") : v);
  return iso;
}

export interface CsvColumns {
  caseId: number;
  activity: number;
  time: number;
  resource: number;
}

/** Which column is which, from the headings. -1 for one not found. */
export function guessColumns(headings: string[]): CsvColumns {
  const find = (re: RegExp) => headings.findIndex((h) => re.test(h.trim()));
  return { caseId: find(CASE), activity: find(ACTIVITY), time: find(TIME), resource: find(RESOURCE) };
}

export function readCsvLog(source: string, text: string, columns?: Partial<CsvColumns>): EventLog {
  const rows = splitCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) throw new LogError("The file has no rows after its headings.");
  const headings = rows[0];
  const c = { ...guessColumns(headings), ...columns };
  if (c.caseId < 0 || c.activity < 0 || c.time < 0) {
    throw new LogError(`Say which columns hold the case, the activity and the time. The headings are: ${headings.slice(0, 12).join(", ")}.`);
  }
  const events: LogEvent[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const time = parseTime(r[c.time] ?? "");
    const caseId = (r[c.caseId] ?? "").trim();
    const activity = (r[c.activity] ?? "").trim();
    if (!caseId || !activity || Number.isNaN(time)) {
      skipped++;
      continue;
    }
    events.push({ caseId, activity, time, resource: c.resource >= 0 ? (r[c.resource] ?? "").trim() : "" });
  }
  return finish({ source, format: "CSV", events, skipped });
}

const attr = (node: XmlNode, key: string) => node.children.find((c) => c.attrs.key === key)?.attrs.value ?? "";

export function readXesLog(source: string, text: string): EventLog {
  let root: XmlNode;
  try {
    root = parseXml(text);
  } catch {
    throw new LogError("The XES file could not be read as XML.");
  }
  if (root.name !== "log") throw new LogError("This is not an XES log: it has no log element.");
  const events: LogEvent[] = [];
  let skipped = 0;
  root.children
    .filter((t) => t.name === "trace")
    .forEach((trace, i) => {
      const caseId = attr(trace, "concept:name") || `case ${i + 1}`;
      for (const e of trace.children.filter((c) => c.name === "event")) {
        const lifecycle = attr(e, "lifecycle:transition");
        if (lifecycle && !/^(complete|completed)$/i.test(lifecycle)) continue;
        const activity = attr(e, "concept:name");
        const time = parseTime(attr(e, "time:timestamp"));
        if (!activity || Number.isNaN(time)) {
          skipped++;
          continue;
        }
        events.push({ caseId, activity, time, resource: attr(e, "org:resource") });
      }
    });
  return finish({ source, format: "XES", events, skipped });
}

/** OCEL 2.0 in its JSON form: the cases follow one object type, by default the one most events touch. */
export function readOcelLog(source: string, data: unknown, caseType?: string): EventLog {
  const o = (data ?? {}) as { objectTypes?: { name: string }[]; objects?: { id: string; type: string }[]; events?: { id: string; type: string; time: string; relationships?: { objectId: string; qualifier?: string }[]; attributes?: { name: string; value: unknown }[] }[] };
  if (!Array.isArray(o.events) || !Array.isArray(o.objects)) throw new LogError("This is not an OCEL 2.0 JSON log: it needs events and objects.");
  const typeOf = new Map(o.objects.map((x) => [x.id, x.type]));
  const touches = new Map<string, number>();
  for (const e of o.events) for (const r of e.relationships ?? []) touches.set(typeOf.get(r.objectId) ?? "", (touches.get(typeOf.get(r.objectId) ?? "") ?? 0) + 1);
  const types = (o.objectTypes ?? []).map((t) => t.name).filter(Boolean);
  const chosen = caseType && touches.has(caseType) ? caseType : ([...touches.entries()].filter(([t]) => t).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "");
  const events: LogEvent[] = [];
  let skipped = 0;
  for (const e of o.events) {
    const time = parseTime(String(e.time ?? ""));
    const resource = String(e.attributes?.find((a) => /resource|user|role/i.test(a.name))?.value ?? "");
    const related = (e.relationships ?? []).filter((r) => typeOf.get(r.objectId) === chosen);
    if (!related.length || Number.isNaN(time)) {
      skipped++;
      continue;
    }
    for (const r of related) events.push({ caseId: r.objectId, activity: e.type, time, resource });
  }
  return finish({ source, format: "OCEL 2.0", events, skipped, objectTypes: types.length ? types : [...touches.keys()].filter(Boolean), caseType: chosen });
}

function finish(log: EventLog): EventLog {
  if (!log.events.length) throw new LogError("No events could be read: each needs a case, an activity and a time.");
  log.events.sort((a, b) => (a.caseId === b.caseId ? a.time - b.time : a.caseId < b.caseId ? -1 : 1));
  return log;
}

/** Any of the three, by the file's name and content. */
export function readEventLog(fileName: string, text: string, options: { columns?: Partial<CsvColumns>; caseType?: string } = {}): EventLog {
  const trimmed = text.trimStart();
  if (/\.xes$/i.test(fileName) || trimmed.startsWith("<")) return readXesLog(fileName, text);
  if (/\.(json|jsonocel)$/i.test(fileName) || trimmed.startsWith("{")) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new LogError("The JSON file could not be read.");
    }
    return readOcelLog(fileName, data, options.caseType);
  }
  return readCsvLog(fileName, text, options.columns);
}

/* ---------- What the log says ---------- */

export interface Transition {
  from: string;
  to: string;
  count: number;
  medianMinutes: number;
}
export interface Variant {
  steps: string[];
  count: number;
  share: number;
  medianHours: number;
}
export interface ActivityStat {
  name: string;
  count: number;
  cases: number;
  /** The median time from the step before to this one: the wait for it and its work. */
  medianMinutes: number | null;
  resources: string[];
}
export interface LogAnalysis {
  cases: number;
  events: number;
  activities: ActivityStat[];
  transitions: Transition[];
  starts: Record<string, number>;
  ends: Record<string, number>;
  variants: Variant[];
  medianHours: number | null;
  meanHours: number | null;
  p90Hours: number | null;
  /** The share of cases that do a step more than once. */
  reworkShare: number;
  /** The slowest handovers, by median wait. */
  slowest: Transition[];
  start: number;
  end: number;
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function tracesOf(log: EventLog): Map<string, LogEvent[]> {
  const traces = new Map<string, LogEvent[]>();
  for (const e of log.events) {
    const t = traces.get(e.caseId);
    if (t) t.push(e);
    else traces.set(e.caseId, [e]);
  }
  return traces;
}

export function analyseLog(log: EventLog): LogAnalysis {
  const traces = tracesOf(log);
  const acts = new Map<string, { count: number; cases: Set<string>; gaps: number[]; resources: Map<string, number> }>();
  const edges = new Map<string, { from: string; to: string; gaps: number[] }>();
  const starts: Record<string, number> = {};
  const ends: Record<string, number> = {};
  const variants = new Map<string, { steps: string[]; durations: number[] }>();
  const durations: number[] = [];
  let rework = 0;
  for (const [caseId, trace] of traces) {
    const seen = new Set<string>();
    let repeated = false;
    trace.forEach((e, i) => {
      const a = acts.get(e.activity) ?? { count: 0, cases: new Set<string>(), gaps: [], resources: new Map<string, number>() };
      a.count++;
      a.cases.add(caseId);
      if (e.resource) a.resources.set(e.resource, (a.resources.get(e.resource) ?? 0) + 1);
      if (i > 0) {
        const prev = trace[i - 1];
        const gap = (e.time - prev.time) / 60000;
        a.gaps.push(gap);
        const key = `${prev.activity}\u0000${e.activity}`;
        const edge = edges.get(key) ?? { from: prev.activity, to: e.activity, gaps: [] };
        edge.gaps.push(gap);
        edges.set(key, edge);
      }
      if (seen.has(e.activity)) repeated = true;
      seen.add(e.activity);
      acts.set(e.activity, a);
    });
    if (repeated) rework++;
    starts[trace[0].activity] = (starts[trace[0].activity] ?? 0) + 1;
    ends[trace[trace.length - 1].activity] = (ends[trace[trace.length - 1].activity] ?? 0) + 1;
    const d = (trace[trace.length - 1].time - trace[0].time) / 3600000;
    durations.push(d);
    const steps = trace.map((e) => e.activity);
    const key = steps.join("\u0000");
    const v = variants.get(key) ?? { steps, durations: [] };
    v.durations.push(d);
    variants.set(key, v);
  }
  const transitions = [...edges.values()].map((e) => ({ from: e.from, to: e.to, count: e.gaps.length, medianMinutes: median(e.gaps) ?? 0 })).sort((a, b) => b.count - a.count);
  const sortedD = [...durations].sort((a, b) => a - b);
  return {
    cases: traces.size,
    events: log.events.length,
    activities: [...acts.entries()]
      .map(([name, a]) => ({ name, count: a.count, cases: a.cases.size, medianMinutes: median(a.gaps), resources: [...a.resources.entries()].sort((x, y) => y[1] - x[1]).map(([r]) => r) }))
      .sort((a, b) => b.count - a.count),
    transitions,
    starts,
    ends,
    variants: [...variants.values()].map((v) => ({ steps: v.steps, count: v.durations.length, share: v.durations.length / traces.size, medianHours: median(v.durations) ?? 0 })).sort((a, b) => b.count - a.count),
    medianHours: median(durations),
    meanHours: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    p90Hours: sortedD.length ? sortedD[Math.min(sortedD.length - 1, Math.floor(0.9 * sortedD.length))] : null,
    reworkShare: traces.size ? rework / traces.size : 0,
    slowest: [...transitions].filter((t) => t.count >= Math.max(2, traces.size * 0.02)).sort((a, b) => b.medianMinutes - a.medianMinutes).slice(0, 5),
    start: log.events.reduce((m, e) => Math.min(m, e.time), Infinity),
    end: log.events.reduce((m, e) => Math.max(m, e.time), -Infinity),
  };
}

/** The busiest paths only: those taken by at least this share of the most frequent one. */
export function keepPaths(analysis: LogAnalysis, share: number): Transition[] {
  const top = analysis.transitions[0]?.count ?? 0;
  const kept = new Set(analysis.transitions.filter((t) => t.count >= top * share));
  // Every activity shown keeps at least its busiest way in (unless cases start there) and out
  // (unless they end there), so no step floats on the map.
  const names = new Set([...[...kept].flatMap((t) => [t.from, t.to]), ...Object.keys(analysis.starts), ...Object.keys(analysis.ends)]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of [...names]) {
      for (const dir of ["to", "from"] as const) {
        const ends = dir === "to" ? analysis.starts : analysis.ends;
        if (ends[name] || [...kept].some((t) => t[dir] === name)) continue;
        const best = analysis.transitions.find((t) => t[dir] === name && t.from !== t.to);
        if (!best) continue;
        kept.add(best);
        names.add(best.from);
        names.add(best.to);
        changed = true;
      }
    }
  }
  return [...kept];
}

/* ---------- Against a model ---------- */

export interface Conformance {
  /** The share of cases that follow the model from start to end. */
  fitness: number;
  conformingCases: number;
  deviations: { from: string; to: string; count: number }[];
  /** Activities in the log the model does not have. */
  unknown: string[];
  /** Steps of the model the log never shows. */
  unused: string[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Which activity may follow which in a model, looking through gateways and events. */
export function allowedSteps(graph: BpmnGraph): { next: Map<string, Set<string>>; first: Set<string>; last: Set<string>; names: Map<string, string> } {
  const acts = Object.values(graph.nodes).filter((n) => n.kind === "activity");
  const names = new Map(acts.map((a) => [norm(a.name), a.name]));
  const reach = (fromId: string) => {
    const found = new Set<string>();
    let ends = false;
    const seen = new Set<string>();
    const stack = graph.nodes[fromId].outgoing.map((f) => graph.flows[f]?.targetId).filter(Boolean);
    // A boundary event lets the work go another way.
    for (const b of Object.values(graph.nodes)) if (b.attachedTo === fromId) stack.push(b.id);
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = graph.nodes[id];
      if (!n) continue;
      if (n.kind === "activity") found.add(norm(n.name));
      else {
        if (n.type === "endEvent") ends = true;
        stack.push(...n.outgoing.map((f) => graph.flows[f]?.targetId).filter(Boolean));
      }
    }
    return { found, ends };
  };
  const next = new Map<string, Set<string>>();
  const last = new Set<string>();
  for (const a of acts) {
    const { found, ends } = reach(a.id);
    const key = norm(a.name);
    next.set(key, new Set([...(next.get(key) ?? []), ...found]));
    if (ends) last.add(key);
  }
  const first = new Set<string>();
  for (const s of Object.values(graph.nodes).filter((n) => n.type === "startEvent" && !n.attachedTo)) for (const f of reach(s.id).found) first.add(f);
  return { next, first, last, names };
}

export function checkConformance(log: EventLog, graph: BpmnGraph): Conformance {
  const { next, first, last, names } = allowedSteps(graph);
  const deviations = new Map<string, { from: string; to: string; count: number }>();
  const seen = new Set<string>();
  const unknown = new Set<string>();
  let ok = 0;
  const traces = tracesOf(log);
  for (const trace of traces.values()) {
    let fits = true;
    const steps = trace.map((e) => e.activity);
    steps.forEach((s) => (names.has(norm(s)) ? seen.add(norm(s)) : unknown.add(s)));
    const flag = (from: string, to: string) => {
      fits = false;
      const key = `${from}\u0000${to}`;
      const d = deviations.get(key) ?? { from, to, count: 0 };
      d.count++;
      deviations.set(key, d);
    };
    if (!first.has(norm(steps[0]))) flag("(start)", steps[0]);
    for (let i = 1; i < steps.length; i++) if (!next.get(norm(steps[i - 1]))?.has(norm(steps[i]))) flag(steps[i - 1], steps[i]);
    if (!last.has(norm(steps[steps.length - 1]))) flag(steps[steps.length - 1], "(end)");
    if (fits) ok++;
  }
  return {
    fitness: traces.size ? ok / traces.size : 0,
    conformingCases: ok,
    deviations: [...deviations.values()].sort((a, b) => b.count - a.count),
    unknown: [...unknown],
    unused: [...names.entries()].filter(([k]) => !seen.has(k)).map(([, v]) => v),
  };
}

/* ---------- A model from the log ---------- */

/**
 * The process the log shows, as BPMN: the busiest paths, with a decision wherever a step goes
 * more than one way, a join wherever more than one way leads in, and lanes for the people who do
 * each step when the log says who did it. The chance of each way out is the share seen.
 */
export function discoverProcess(log: EventLog, analysis: LogAnalysis, share = 0.1): { spec: ProcessSpec; probabilities: Record<string, number> } {
  const kept = keepPaths(analysis, share);
  const acts = [...new Set(kept.flatMap((t) => [t.from, t.to]).concat(Object.keys(analysis.starts), Object.keys(analysis.ends)))].filter((a) => analysis.activities.some((x) => x.name === a));
  const id = (name: string) => `Activity_${acts.indexOf(name) + 1}`;
  const roleOf = new Map(analysis.activities.map((a) => [a.name, a.resources[0] ?? ""]));
  const roles = [...new Set(acts.map((a) => roleOf.get(a) ?? "").filter(Boolean))];
  const lanes = roles.length >= 2 && roles.length <= 8 && acts.every((a) => roleOf.get(a)) ? roles : undefined;
  const steps: SpecStep[] = [{ id: "Start", name: "Start", type: "startEvent" }, ...acts.map((a) => ({ id: id(a), name: a, type: "task" as const, lane: lanes ? roleOf.get(a) : undefined })), { id: "End", name: "End", type: "endEvent" }];
  if (lanes) steps[0].lane = steps[1]?.lane;
  if (lanes) steps[steps.length - 1].lane = roleOf.get(Object.entries(analysis.ends).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "") ?? lanes[0];
  const outs = new Map<string, { to: string; count: number }[]>();
  const add = (from: string, to: string, count: number) => outs.set(from, [...(outs.get(from) ?? []), { to, count }]);
  for (const [a, n] of Object.entries(analysis.starts)) if (acts.includes(a)) add("Start", id(a), n);
  for (const t of kept) if (acts.includes(t.from) && acts.includes(t.to)) add(id(t.from), id(t.to), t.count);
  for (const [a, n] of Object.entries(analysis.ends)) if (acts.includes(a)) add(id(a), "End", n);
  const flows: { from: string; to: string; name?: string }[] = [];
  const probabilities: Record<string, number> = {};
  const incoming = new Map<string, number>();
  for (const list of outs.values()) for (const o of list) incoming.set(o.to, (incoming.get(o.to) ?? 0) + 1);
  // A join before any step more than one way leads to.
  const entry = new Map<string, string>();
  let g = 0;
  for (const [target, n] of incoming) {
    if (n < 2) continue;
    const join = `Gateway_${++g}`;
    steps.push({ id: join, name: "", type: "exclusiveGateway", lane: steps.find((s) => s.id === target)?.lane });
    flows.push({ from: join, to: target });
    entry.set(target, join);
  }
  for (const [from, list] of outs) {
    const total = list.reduce((a, o) => a + o.count, 0);
    if (list.length === 1) {
      flows.push({ from, to: entry.get(list[0].to) ?? list[0].to });
      continue;
    }
    const split = `Gateway_${++g}`;
    steps.push({ id: split, name: "", type: "exclusiveGateway", lane: steps.find((s) => s.id === from)?.lane });
    flows.push({ from, to: split });
    for (const o of list) {
      flows.push({ from: split, to: entry.get(o.to) ?? o.to, name: `${Math.round((o.count / total) * 100)}%` });
      // buildBpmn names flows Flow_1, Flow_2... in this order.
      probabilities[`Flow_${flows.length}`] = Math.round((o.count / total) * 1000) / 10;
    }
  }
  return { spec: { name: log.source.replace(/\.[^.]+$/, ""), lanes, steps, flows }, probabilities };
}

/** How often each step of a model is seen in the log, by step id: for colouring the model. */
export function stepCounts(graph: BpmnGraph, analysis: LogAnalysis): Record<string, number> {
  const byName = new Map(analysis.activities.map((a) => [norm(a.name), a.count]));
  return Object.fromEntries(activitiesInOrder(graph).map((n) => [n.id, byName.get(norm(n.name)) ?? 0]));
}

/* ---------- A log to try it with ---------- */

/**
 * A made-up purchase-to-pay log, by role: 400 purchases over three months, with approvals that wait,
 * some rejections, invoices that do not match and are sorted out, and the odd payment made
 * before the goods arrive. It shows what mining finds without bringing a real export.
 */
export function sampleEventLog(seed = 11): string {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const people = { requester: ["Requester"], buyer: ["Purchasing"], ap: ["Accounts payable"], manager: ["Manager"] };
  const rows = ["case_id,activity,timestamp,role"];
  const start = Date.UTC(2026, 6, 1, 8);
  for (let i = 1; i <= 400; i++) {
    let t = start + Math.floor(rand() * 90 * 24) * 3600000 + Math.floor(rand() * 8) * 3600000;
    const id = `PO-${String(10000 + i)}`;
    const add = (activity: string, role: keyof typeof people, hours: number) => {
      t += Math.round(hours * 3600000 * (0.5 + rand()));
      rows.push(`${id},${activity},${new Date(t).toISOString()},${pick(people[role])}`);
    };
    add("Create purchase request", "requester", 0.1);
    add("Approve purchase request", "manager", 6 + rand() * 30);
    if (rand() < 0.08) {
      add("Reject purchase request", "manager", 0.2);
      continue;
    }
    add("Create purchase order", "buyer", 2 + rand() * 10);
    const early = rand() < 0.06;
    if (early) add("Pay invoice", "ap", 20);
    add("Receive goods", "requester", 48 + rand() * 120);
    add("Receive invoice", "ap", 4 + rand() * 48);
    add("Match invoice", "ap", 2 + rand() * 20);
    if (rand() < 0.22) {
      add("Resolve price difference", "buyer", 12 + rand() * 60);
      add("Match invoice", "ap", 2);
    }
    if (!early) add("Pay invoice", "ap", 24 + rand() * 96);
  }
  return rows.join("\n");
}
