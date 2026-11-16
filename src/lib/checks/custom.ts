import { LIFECYCLE_INFO, objectType } from "../catalog";
import { nowIso, newId } from "../model";
import type { CustomRule, Lifecycle, ModelObject, Relationship, RuleCheck, Selector, Workspace } from "../types";
import { LIFECYCLES } from "../types";

/**
 * Rules a workspace writes for itself, run next to the built-in ones.
 *
 * A rule is one of three things: something every chosen object has to have, something about
 * how two sets of objects may connect, or a journey test: what may or must lie on the way from
 * one set of objects to another, following the arrows.
 */

export const emptySelector = (): Selector => ({ types: [], tags: [], lifecycle: [], personal: false, classification: [], name: "", inside: null });
export const isEverything = (s: Selector) => !s.types.length && !s.tags.length && !s.lifecycle.length && !s.personal && !s.classification.length && !s.name.trim() && !s.inside;

const field = (o: ModelObject, name: string) => (o.fields[name] ?? "").trim();
const holdsPersonal = (o: ModelObject) => /^(yes|y|true|1)$/i.test(field(o, "Personal data"));

function insideOf(ws: Pick<Workspace, "objects">, o: ModelObject, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let at = o.parentId; at && !seen.has(at); at = ws.objects[at]?.parentId ?? null) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

export function matches(ws: Pick<Workspace, "objects">, s: Selector, o: ModelObject): boolean {
  if (s.types.length && !s.types.includes(o.typeId)) return false;
  if (s.tags.length && !s.tags.every((t) => o.tags.includes(t.toLowerCase()))) return false;
  if (s.lifecycle.length && !s.lifecycle.includes(o.lifecycle)) return false;
  if (s.personal && !holdsPersonal(o)) return false;
  if (s.classification.length && !s.classification.some((c) => c.toLowerCase() === field(o, "Data classification").toLowerCase())) return false;
  if (s.name.trim() && !o.name.toLowerCase().includes(s.name.trim().toLowerCase())) return false;
  if (s.inside && !insideOf(ws, o, s.inside)) return false;
  return true;
}

/* ---------- saying a rule in words ---------- */

const list = (items: string[], joiner = "or") => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${joiner} ${items.at(-1)}`);
/** Kinds of object in the plural, where adding an "s" to the label would not read well. */
const PLURALS: Record<string, string> = {
  actor: "people",
  system: "software systems",
  service: "services",
  storage: "file storage",
  network: "network devices",
  queue: "queues",
  gateway: "gateways",
  server: "servers",
  "ai-agent": "AI agents",
  "ai-model": "AI models",
  "mcp-server": "MCP servers",
  process: "processes",
};
const pluralOf = (typeId: string) => {
  if (PLURALS[typeId]) return PLURALS[typeId];
  const lower = objectType(typeId).label.toLowerCase();
  return /(s|x|ch)$/.test(lower) ? `${lower}es` : lower.endsWith("y") && !/[aeiou]y$/.test(lower) ? `${lower.slice(0, -1)}ies` : `${lower}s`;
};

/** "databases tagged pci that hold personal data", or "objects" for a selector that picks everything. */
export function describeSelector(ws: Pick<Workspace, "objects">, s: Selector): string {
  const kinds = s.types.length ? list(s.types.map(pluralOf)) : "objects";
  const parts = [
    s.lifecycle.length ? `${list(s.lifecycle.map((l) => LIFECYCLE_INFO[l].label.toLowerCase()))} ${kinds}` : kinds,
    s.name.trim() ? `named "${s.name.trim()}"` : "",
    s.tags.length ? `tagged ${list(s.tags, "and")}` : "",
    s.classification.length ? `classified ${list(s.classification)}` : "",
    s.inside ? `inside ${ws.objects[s.inside]?.name ?? "a deleted object"}` : "",
    s.personal ? "that hold personal data" : "",
  ];
  return parts.filter(Boolean).join(" ");
}

const REQUIRE_WORDS: Record<string, string> = { owner: "have an owner", description: "have a description", technology: "say what technology they use", classification: "have a data classification", residency: "say where their data is kept" };
const protocols = (value: string) => value.split(/[,;/]|\bor\b/i).map((p) => p.trim()).filter(Boolean);
const lifecyclesIn = (value: string): Lifecycle[] => LIFECYCLES.filter((l) => new RegExp(`\\b${l}\\b`, "i").test(value));

/** The rule as one sentence, the way the app reads it. */
export function describeRule(ws: Pick<Workspace, "objects">, check: RuleCheck): string {
  if (check.kind === "object") {
    const who = describeSelector(ws, check.subject);
    const [name, equals] = check.value.split("=").map((p) => p.trim());
    const what =
      REQUIRE_WORDS[check.require] ??
      (check.require === "tag"
        ? `be tagged ${check.value.trim() || "(no tag given)"}`
        : check.require === "no-tag"
          ? `not be tagged ${check.value.trim() || "(no tag given)"}`
          : check.require === "field"
            ? equals
              ? `have "${name}" set to "${equals}"`
              : `have "${name || "(no field given)"}" filled in`
            : `be ${list(lifecyclesIn(check.value).map((l) => LIFECYCLE_INFO[l].label.toLowerCase())) || "(no lifecycle given)"}`);
    return `All ${who} must ${what}.`;
  }
  const from = describeSelector(ws, check.from);
  const to = describeSelector(ws, check.to);
  if (check.kind === "connection") {
    if (check.mode === "never") return `No connection between ${from} and ${to}.`;
    if (check.mode === "only") return `${from[0].toUpperCase()}${from.slice(1)} connect only to ${to}.`;
    return `Connections between ${from} and ${to} use ${list(protocols(check.value)) || "(no protocol given)"}.`;
  }
  const through = describeSelector(ws, check.through);
  return check.mode === "never" ? `Nothing on the way from ${from} to ${to} passes through ${through}.` : `Every way from ${from} to ${to} passes through ${through}.`;
}

/* ---------- running a rule ---------- */

export interface CustomFinding {
  message: string;
  objectIds: string[];
  relationshipIds: string[];
}
/** A rule that goes wrong all over the model says so a limited number of times. */
const MAX_FINDINGS = 60;

interface Graph {
  out: Map<string, { to: string; id: string }[]>;
}
function graphOf(relationships: Relationship[]): Graph {
  const out = new Map<string, { to: string; id: string }[]>();
  for (const r of relationships) {
    if (r.sourceId === r.targetId) continue;
    out.set(r.sourceId, [...(out.get(r.sourceId) ?? []), { to: r.targetId, id: r.id }]);
  }
  return { out };
}
/** The shortest way from one object to any of the wanted ones, following the arrows and stepping over the blocked. */
function shortest(graph: Graph, start: string, wanted: Set<string>, blocked: Set<string>): { nodes: string[]; edges: string[] } | null {
  const came = new Map<string, { from: string; edge: string } | null>([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    if (at !== start && wanted.has(at)) {
      const nodes: string[] = [];
      const edges: string[] = [];
      for (let n: string | undefined = at; n; ) {
        nodes.unshift(n);
        const step: { from: string; edge: string } | null | undefined = came.get(n);
        if (step) edges.unshift(step.edge);
        n = step?.from;
      }
      return { nodes, edges };
    }
    for (const next of graph.out.get(at) ?? []) {
      if (came.has(next.to) || blocked.has(next.to)) continue;
      came.set(next.to, { from: at, edge: next.id });
      queue.push(next.to);
    }
  }
  return null;
}

export function runCustomCheck(ws: Pick<Workspace, "objects">, check: RuleCheck, objects: ModelObject[], relationships: Relationship[]): CustomFinding[] {
  const found: CustomFinding[] = [];
  const name = (id: string) => ws.objects[id]?.name ?? "a deleted object";
  const pick = (s: Selector) => objects.filter((o) => matches(ws, s, o));

  if (check.kind === "object") {
    const [fieldName, equals] = check.value.split("=").map((p) => p.trim());
    const tag = check.value.trim().toLowerCase();
    const allowed = lifecyclesIn(check.value);
    for (const o of pick(check.subject)) {
      let problem = "";
      if (check.require === "owner" && !o.owner.trim()) problem = "has no owner";
      else if (check.require === "description" && !o.description.trim()) problem = "has no description";
      else if (check.require === "technology" && !o.technology.trim()) problem = "does not say what technology it uses";
      else if (check.require === "classification" && !field(o, "Data classification")) problem = "has no data classification";
      else if (check.require === "residency" && !field(o, "Data residency")) problem = "does not say where its data is kept";
      else if (check.require === "tag" && tag && !o.tags.includes(tag)) problem = `is not tagged ${tag}`;
      else if (check.require === "no-tag" && tag && o.tags.includes(tag)) problem = `is tagged ${tag}`;
      else if (check.require === "field" && fieldName && (equals ? field(o, fieldName).toLowerCase() !== equals.toLowerCase() : !field(o, fieldName)))
        problem = equals ? `has "${fieldName}" set to "${field(o, fieldName) || "nothing"}", not "${equals}"` : `has nothing in "${fieldName}"`;
      else if (check.require === "lifecycle" && allowed.length && !allowed.includes(o.lifecycle)) problem = `is ${LIFECYCLE_INFO[o.lifecycle].label.toLowerCase()}`;
      if (problem) found.push({ message: `${o.name} ${problem}.`, objectIds: [o.id], relationshipIds: [] });
    }
    return found.slice(0, MAX_FINDINGS);
  }

  const from = new Set(pick(check.from).map((o) => o.id));
  const to = new Set(pick(check.to).map((o) => o.id));

  if (check.kind === "connection") {
    const allowed = protocols(check.value).map((p) => p.toLowerCase());
    for (const r of relationships) {
      if (r.sourceId === r.targetId) continue;
      const between = (from.has(r.sourceId) && to.has(r.targetId)) || (from.has(r.targetId) && to.has(r.sourceId));
      if (check.mode === "never" && between) found.push({ message: `${name(r.sourceId)} and ${name(r.targetId)} are connected.`, objectIds: [r.sourceId, r.targetId], relationshipIds: [r.id] });
      if (check.mode === "protocol" && between && allowed.length && !allowed.includes(r.protocol.trim().toLowerCase()))
        found.push({ message: `${name(r.sourceId)} to ${name(r.targetId)} uses ${r.protocol.trim() || "no stated protocol"}.`, objectIds: [r.sourceId, r.targetId], relationshipIds: [r.id] });
      if (check.mode === "only") {
        for (const [mine, other] of [[r.sourceId, r.targetId], [r.targetId, r.sourceId]]) {
          // Two objects of the limited set may connect to each other; the rule is about who else they reach.
          if (from.has(mine) && !to.has(other) && !from.has(other)) found.push({ message: `${name(mine)} is connected to ${name(other)}.`, objectIds: [mine, other], relationshipIds: [r.id] });
        }
      }
    }
    return found.slice(0, MAX_FINDINGS);
  }

  const through = new Set(pick(check.through).map((o) => o.id));
  const graph = graphOf(relationships);
  const walk = (path: { nodes: string[]; edges: string[] }) => path.nodes.map(name).join(", then ");
  for (const start of from) {
    if (found.length >= MAX_FINDINGS) break;
    if (check.mode === "always") {
      // A way that avoids every object of the third set breaks the rule.
      const blocked = new Set([...through].filter((id) => id !== start && !to.has(id)));
      const bypass = shortest(graph, start, to, blocked);
      if (bypass) found.push({ message: `${name(start)} reaches ${name(bypass.nodes.at(-1)!)} without passing through it: ${walk(bypass)}.`, objectIds: bypass.nodes, relationshipIds: bypass.edges });
    } else {
      for (const middle of through) {
        if (middle === start || to.has(middle) || from.has(middle)) continue;
        const first = shortest(graph, start, new Set([middle]), new Set());
        const second = first && shortest(graph, middle, to, new Set([start]));
        if (first && second) {
          found.push({ message: `${name(start)} reaches ${name(second.nodes.at(-1)!)} through ${name(middle)}: ${walk({ nodes: [...first.nodes, ...second.nodes.slice(1)], edges: [] })}.`, objectIds: [...first.nodes, ...second.nodes.slice(1)], relationshipIds: [...first.edges, ...second.edges] });
          if (found.length >= MAX_FINDINGS) break;
        }
      }
    }
  }
  return found;
}

/* ---------- keeping rules ---------- */

export const sortedRules = (ws: Pick<Workspace, "rules">): CustomRule[] => Object.values(ws.rules).sort((a, b) => a.title.localeCompare(b.title) || a.createdAt.localeCompare(b.createdAt));

export interface RuleInput {
  title: string;
  text: string;
  severity: CustomRule["severity"];
  check: RuleCheck;
}
export function createRule(ws: Workspace, input: RuleInput): { ws: Workspace; rule: CustomRule } {
  const at = nowIso();
  const rule: CustomRule = { id: newId("rule"), title: input.title.trim() || describeRule(ws, input.check), text: input.text.trim(), severity: input.severity, enabled: true, check: input.check, author: ws.userName.trim(), createdAt: at, updatedAt: at };
  return { ws: { ...ws, rules: { ...ws.rules, [rule.id]: rule }, updatedAt: at }, rule };
}
export function updateRule(ws: Workspace, id: string, patch: Partial<Pick<CustomRule, "title" | "severity" | "enabled" | "check" | "text">>): Workspace {
  const rule = ws.rules[id];
  if (!rule) return ws;
  const at = nowIso();
  return { ...ws, rules: { ...ws.rules, [id]: { ...rule, ...patch, updatedAt: at } }, updatedAt: at };
}
export function deleteRule(ws: Workspace, id: string): Workspace {
  if (!ws.rules[id]) return ws;
  const { [id]: _gone, ...rules } = ws.rules;
  return { ...ws, rules, updatedAt: nowIso() };
}
