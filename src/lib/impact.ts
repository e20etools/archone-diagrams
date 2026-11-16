import { RELATION_KIND_INFO, objectType } from "./catalog";
import { componentById, exactComponent } from "./library";
import { declaredAvailability } from "./resilience";
import { descendantsOf, diagramsUsing, protocolsOf } from "./model";
import type { Diagram, ModelObject, Workspace } from "./types";

/**
 * Dependencies and impact, level by level, for a component, a whole diagram or every object
 * that is one library component. A relationship of a dependency kind reads "source needs
 * target". A box standing for another diagram needs everything that diagram shows, so the
 * analysis crosses from one diagram into the next.
 */

export const MAX_LEVELS = 5;

export type Subject = { kind: "object"; id: string } | { kind: "diagram"; id: string } | { kind: "component"; id: string };

export interface Step {
  /** The object reached. */
  id: string;
  /** 1 for a direct dependency, up to five. */
  level: number;
  /** The object one step closer to the subject. */
  from: string;
  /** What joins them: a relationship's kind, or "shown on" for a diagram box. */
  via: string;
  /** Protocols on that relationship, when it has any. */
  protocols: string[];
}

interface Edge {
  to: string;
  via: string;
  protocols: string[];
}

/** Who needs whom: "needs" maps an object to what it depends on; "neededBy" the other way. */
function graphOf(ws: Workspace) {
  const needs = new Map<string, Edge[]>();
  const neededBy = new Map<string, Edge[]>();
  const add = (from: string, to: string, via: string, protocols: string[]) => {
    if (!ws.objects[from] || !ws.objects[to] || from === to) return;
    (needs.get(from) ?? needs.set(from, []).get(from)!).push({
      to,
      via,
      protocols,
    });
    (neededBy.get(to) ?? neededBy.set(to, []).get(to)!).push({
      to: from,
      via,
      protocols,
    });
  };
  for (const r of Object.values(ws.relationships)) {
    const info = RELATION_KIND_INFO[r.kind];
    if (!info?.dependency) continue;
    const protocols = protocolsOf(r).map((p) => p.name);
    add(r.sourceId, r.targetId, info.label, protocols);
    // Both ways: each side relies on the other.
    if (r.flow === "both") add(r.targetId, r.sourceId, info.label, protocols);
  }
  // A diagram box relies on what its diagram shows.
  for (const o of Object.values(ws.objects)) {
    if (o.typeId !== "diagram" || !o.diagramId) continue;
    const d = ws.diagrams[o.diagramId];
    if (!d) continue;
    for (const member of Object.keys(d.nodes)) if (member !== o.id) add(o.id, member, "shown on the diagram", []);
  }
  return { needs, neededBy };
}

/** The objects a subject starts from: one object and what is inside it, a diagram's boxes and its own box, or every object of a component. */
export function subjectStart(ws: Workspace, subject: Subject): string[] {
  if (subject.kind === "object") return ws.objects[subject.id] ? [subject.id, ...descendantsOf(ws, subject.id)] : [];
  if (subject.kind === "diagram") {
    const d = ws.diagrams[subject.id];
    if (!d) return [];
    const box = Object.values(ws.objects)
      .filter((o) => o.typeId === "diagram" && o.diagramId === d.id)
      .map((o) => o.id);
    return [...new Set([...Object.keys(d.nodes).filter((id) => ws.objects[id]), ...box])];
  }
  return objectsOfComponent(ws, subject.id).map((o) => o.id);
}

/** The objects that are one library component: linked to it, or, when linked to none, named as it is. */
export function objectsOfComponent(ws: Workspace, componentId: string): ModelObject[] {
  return Object.values(ws.objects).filter((o) => (o.componentId ? o.componentId === componentId : exactComponent(o.name)?.id === componentId));
}

/** The library components this model uses, with how many objects each. */
export function componentsInUse(ws: Workspace): { id: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const o of Object.values(ws.objects)) {
    const id = o.componentId ?? exactComponent(o.name)?.id;
    if (id && componentById(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
}

export function subjectName(ws: Workspace, subject: Subject): string {
  if (subject.kind === "object") return ws.objects[subject.id]?.name ?? "A deleted object";
  if (subject.kind === "diagram") return ws.diagrams[subject.id]?.name ?? "A deleted diagram";
  return componentById(subject.id)?.name ?? "A component";
}

/** Everything reached from the start, nearest first, up to the given level. */
export function walk(ws: Workspace, start: string[], direction: "needs" | "neededBy", levels = MAX_LEVELS): Step[] {
  const graph = graphOf(ws)[direction];
  const seen = new Set(start);
  const out: Step[] = [];
  let frontier = start;
  for (let level = 1; level <= Math.min(levels, MAX_LEVELS) && frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of graph.get(id) ?? []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        out.push({
          id: e.to,
          level,
          from: id,
          via: e.via,
          protocols: e.protocols,
        });
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return out;
}

/** The names from the subject to a step, through the objects between. */
export function pathOf(ws: Workspace, steps: Step[], id: string): string[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const names: string[] = [];
  const guard = new Set<string>();
  for (let cur: string | undefined = id; cur && !guard.has(cur); cur = byId.get(cur)?.from) {
    guard.add(cur);
    names.unshift(ws.objects[cur]?.name ?? "?");
  }
  return names;
}

export interface DiagramReach {
  diagram: Diagram;
  /** How many of its boxes are reached. */
  count: number;
  /** Of how many. */
  of: number;
  /** The nearest level at which it is reached. */
  level: number;
}

/** The diagrams the reached objects are on, with how much of each. */
export function diagramsReached(ws: Workspace, steps: Step[], exclude: string[] = []): DiagramReach[] {
  const out = new Map<string, DiagramReach>();
  for (const s of steps) {
    for (const d of diagramsUsing(ws, s.id)) {
      if (exclude.includes(d.id) || d.archive?.archived) continue;
      const known = out.get(d.id);
      if (known) {
        known.count++;
        known.level = Math.min(known.level, s.level);
      } else
        out.set(d.id, {
          diagram: d,
          count: 1,
          of: Object.keys(d.nodes).filter((id) => ws.objects[id]).length,
          level: s.level,
        });
    }
  }
  return [...out.values()].sort((a, b) => a.level - b.level || b.count - a.count || a.diagram.name.localeCompare(b.diagram.name));
}

export interface Analysis {
  start: string[];
  dependencies: Step[];
  impact: Step[];
  diagramsDependedOn: DiagramReach[];
  diagramsImpacted: DiagramReach[];
}

export function analyse(ws: Workspace, subject: Subject, levels = MAX_LEVELS): Analysis {
  const start = subjectStart(ws, subject);
  const dependencies = walk(ws, start, "needs", levels);
  const impact = walk(ws, start, "neededBy", levels);
  const own = subject.kind === "diagram" ? [subject.id] : [];
  return {
    start,
    dependencies,
    impact,
    diagramsDependedOn: diagramsReached(ws, dependencies, own),
    diagramsImpacted: diagramsReached(ws, impact, own),
  };
}

/* ---------- what if it stops ---------- */

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const LIKELIHOODS = [
  { value: 1, label: "Rare" },
  { value: 2, label: "Unlikely" },
  { value: 3, label: "Possible" },
  { value: 4, label: "Likely" },
  { value: 5, label: "Almost certain" },
] as const;
export const IMPACT_LEVELS = [
  { value: 1, label: "Negligible" },
  { value: 2, label: "Minor" },
  { value: 3, label: "Moderate" },
  { value: 4, label: "Major" },
  { value: 5, label: "Severe" },
] as const;

export interface Assessed {
  object: ModelObject;
  level: number;
  path: string[];
  severity: Severity;
  /** Why it is rated so. */
  reasons: string[];
  diagrams: Diagram[];
}

export interface Remedy {
  priority: "now" | "soon" | "later";
  text: string;
  /** The objects it is about. */
  about: string[];
}

export interface WhatIfResult {
  stopped: ModelObject[];
  affected: Assessed[];
  diagrams: DiagramReach[];
  people: string[];
  owners: { owner: string; count: number }[];
  /** 1 to 5, worked out from what is affected; the person may set another. */
  impact: number;
  impactReasons: string[];
  remedies: Remedy[];
}

const critical = (o: ModelObject) => o.tags.includes("tier-1") || /critical/i.test(o.fields["Business criticality"] ?? "");
const important = (o: ModelObject) => /high/i.test(o.fields["Business criticality"] ?? "");

/** What stops, and how badly, when the given objects and diagrams stop, up to the given level. */
export function whatIf(ws: Workspace, stopped: Subject[], levels = MAX_LEVELS): WhatIfResult {
  const start = [...new Set(stopped.flatMap((s) => subjectStart(ws, s)))];
  const steps = walk(ws, start, "neededBy", levels);
  const graph = graphOf(ws);
  const affected: Assessed[] = steps.map((s) => {
    const o = ws.objects[s.id];
    const reasons: string[] = [];
    let rank = s.level === 1 ? 1 : s.level === 2 ? 1 : s.level === 3 ? 2 : 3; // high, high, medium, low
    reasons.push(s.level === 1 ? "Depends on it directly" : `Reached in ${s.level} steps`);
    if (critical(o)) {
      rank = 0;
      reasons.push("Marked critical (tier-1 or business criticality)");
    } else if (important(o)) {
      rank = Math.min(rank, 1);
      reasons.push("High business criticality");
    }
    if (o.typeId === "actor") {
      rank = Math.min(rank, 1);
      reasons.push("People cannot work");
    }
    const dependents = (graph.neededBy.get(s.id) ?? []).length;
    if (dependents >= 4) {
      rank = Math.max(0, rank - 1);
      reasons.push(`${dependents} others depend on it in turn`);
    }
    return {
      object: o,
      level: s.level,
      path: pathOf(ws, steps, s.id),
      severity: SEVERITIES[rank],
      reasons,
      diagrams: diagramsUsing(ws, s.id),
    };
  });
  const order = (x: Severity) => SEVERITIES.indexOf(x);
  affected.sort((a, b) => order(a.severity) - order(b.severity) || a.level - b.level || a.object.name.localeCompare(b.object.name));
  const stoppedObjects = start.map((id) => ws.objects[id]).filter(Boolean);
  const stoppedDiagrams = stopped.filter((s) => s.kind === "diagram").map((s) => s.id);
  const diagrams = diagramsReached(ws, steps, stoppedDiagrams);
  const people = affected.filter((a) => a.object.typeId === "actor").map((a) => a.object.name);
  const counts = new Map<string, number>();
  for (const a of affected) counts.set(a.object.owner.trim(), (counts.get(a.object.owner.trim()) ?? 0) + 1);
  const owners = [...counts].map(([owner, count]) => ({ owner, count })).sort((a, b) => b.count - a.count);

  // The impact level, from what is hit.
  const criticalCount = affected.filter((a) => a.severity === "critical").length + stoppedObjects.filter(critical).length;
  const share = Object.keys(ws.objects).length ? (affected.length + stoppedObjects.length) / Object.keys(ws.objects).length : 0;
  const impactReasons: string[] = [];
  let impact = affected.length === 0 ? 1 : affected.length < 3 ? 2 : 3;
  impactReasons.push(`${affected.length} ${affected.length === 1 ? "component is" : "components are"} affected`);
  if (diagrams.length >= 3) {
    impact = Math.max(impact, 4);
    impactReasons.push(`${diagrams.length} diagrams are affected`);
  }
  if (people.length) {
    impact = Math.max(impact, 4);
    impactReasons.push(`People cannot work: ${people.slice(0, 4).join(", ")}${people.length > 4 ? "…" : ""}`);
  }
  if (criticalCount) {
    impact = 5;
    impactReasons.push(`${criticalCount} critical ${criticalCount === 1 ? "component" : "components"} stop or are affected`);
  }
  if (share >= 0.3) {
    impact = Math.max(impact, 4);
    impactReasons.push(`${Math.round(share * 100)}% of the model is affected`);
  }

  return {
    stopped: stoppedObjects,
    affected,
    diagrams,
    people,
    owners,
    impact,
    impactReasons,
    remedies: remediesFor(ws, stoppedObjects, affected, diagrams),
  };
}

/** The risk of a scenario: how likely times how bad, on the usual five-by-five grid. */
export function riskOf(likelihood: number, impact: number): { score: number; level: Severity } {
  const score = likelihood * impact;
  return {
    score,
    level: score >= 17 ? "critical" : score >= 10 ? "high" : score >= 5 ? "medium" : "low",
  };
}

const DATA = new Set(["database", "storage", "cache", "queue"]);
const NETWORK = new Set(["network", "gateway", "zone", "cluster", "server"]);

/** Ways to make the scenario hurt less, drawn from what stops and what it takes with it. */
export function remediesFor(ws: Workspace, stopped: ModelObject[], affected: Assessed[], diagrams: DiagramReach[]): Remedy[] {
  const out: Remedy[] = [];
  const graph = graphOf(ws);
  for (const o of stopped.slice(0, 12)) {
    const dependents = (graph.neededBy.get(o.id) ?? []).length;
    const twin = Object.values(ws.objects).some(
      (x) =>
        x.id !== o.id && (o.componentId ? x.componentId === o.componentId : x.typeId === o.typeId) && x.name.toLowerCase().includes(o.name.toLowerCase().split(" ")[0]) && x.parentId === o.parentId,
    );
    const section = componentById(o.componentId)?.sectionId;
    if (dependents >= 2 && !twin)
      out.push({
        priority: "now",
        text: `${o.name} is a single point of failure for ${dependents} components. Add a second one, active-active or on standby, with automatic failover.`,
        about: [o.id],
      });
    if (DATA.has(o.typeId))
      out.push({
        priority: "now",
        text: `Keep a replica of ${o.name} in another zone or site, and test restoring its backups. Set and agree its RPO and RTO.`,
        about: [o.id],
      });
    if (o.typeId === "external-system")
      out.push({
        priority: "soon",
        text: `Agree an availability target with the provider of ${o.name}, and design a fallback: queue the requests, retry, or offer a reduced service while it is down.`,
        about: [o.id],
      });
    if (NETWORK.has(o.typeId))
      out.push({
        priority: "now",
        text: `Give what goes through ${o.name} a second path: another device, link or carrier (for example MPLS with an Internet VPN behind it).`,
        about: [o.id],
      });
    if (section === "integrations")
      out.push({
        priority: "now",
        text: `${o.name} is a shared service many diagrams lean on. Run it highly available, monitor it closely and keep its runbook current.`,
        about: [o.id],
      });
    if (o.typeId === "diagram")
      out.push({
        priority: "soon",
        text: `Write and test a recovery runbook for the whole of ${o.name}, with the order to bring its parts back.`,
        about: [o.id],
      });
    if (declaredAvailability(o) === null && dependents > 0)
      out.push({
        priority: "later",
        text: `Declare an availability target for ${o.name}, so its effect on others can be measured.`,
        about: [o.id],
      });
    if (!o.owner.trim())
      out.push({
        priority: "soon",
        text: `Name an owner for ${o.name}: nobody is called when it stops.`,
        about: [o.id],
      });
  }
  const criticals = affected.filter((a) => a.severity === "critical").map((a) => a.object);
  if (criticals.length)
    out.push({
      priority: "now",
      text: `Put ${criticals
        .slice(0, 5)
        .map((o) => o.name)
        .join(", ")}${criticals.length > 5 ? ` and ${criticals.length - 5} more` : ""} in the disaster recovery plan, and test their failover at least once a year.`,
      about: criticals.map((o) => o.id),
    });
  const unowned = affected.filter((a) => !a.object.owner.trim()).map((a) => a.object);
  if (unowned.length)
    out.push({
      priority: "soon",
      text: `${unowned.length} affected ${unowned.length === 1 ? "component has" : "components have"} no owner, so nobody would be told. Name owners.`,
      about: unowned.map((o) => o.id),
    });
  const clear = affected.filter((a) => a.level === 1 && a.object.typeId !== "actor").length;
  if (clear >= 5)
    out.push({
      priority: "soon",
      text: `${clear} components call the stopped ones directly. Add timeouts, circuit breakers and caching so one failure does not spread.`,
      about: [],
    });
  if (diagrams.length >= 3)
    out.push({
      priority: "soon",
      text: `${diagrams.length} diagrams are affected. Agree with their owners who leads the response, and keep one shared incident channel.`,
      about: [],
    });
  if (affected.some((a) => a.object.typeId === "actor"))
    out.push({
      priority: "soon",
      text: "Prepare a manual way of working and a message for the people who cannot use the system while it is down.",
      about: [],
    });
  if (!out.length)
    out.push({
      priority: "later",
      text: "Nothing else depends on what stops. Keep the model current so this stays true.",
      about: [],
    });
  const rank = { now: 0, soon: 1, later: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/** A short line for each type, as it is shown in tables. */
export const typeLabel = (o: ModelObject) => componentById(o.componentId)?.name ?? objectType(o.typeId).label;
