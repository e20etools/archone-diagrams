import { objectType } from "./catalog";
import type { Diagram, Lifecycle, ModelObject, Workspace } from "./types";
import { LIFECYCLES } from "./types";

/** Search across objects and diagrams (PRD FR-05). Supports tag:, type:, owner: and lifecycle: filters. */

export interface ParsedQuery {
  text: string[];
  tags: string[];
  types: string[];
  owners: string[];
  lifecycles: Lifecycle[];
}

export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { text: [], tags: [], types: [], owners: [], lifecycles: [] };
  for (const raw of query.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const [key, ...rest] = raw.split(":");
    const value = rest.join(":");
    if (value && key === "tag") parsed.tags.push(value);
    else if (value && key === "type") parsed.types.push(value);
    else if (value && key === "owner") parsed.owners.push(value);
    else if (value && key === "lifecycle" && (LIFECYCLES as readonly string[]).includes(value)) parsed.lifecycles.push(value as Lifecycle);
    else parsed.text.push(raw);
  }
  return parsed;
}

function objectScore(o: ModelObject, q: ParsedQuery): number {
  const type = objectType(o.typeId);
  if (q.tags.some((t) => !o.tags.includes(t))) return 0;
  if (q.types.some((t) => !type.id.includes(t) && !type.label.toLowerCase().includes(t))) return 0;
  if (q.owners.some((w) => !o.owner.toLowerCase().includes(w))) return 0;
  if (q.lifecycles.length && !q.lifecycles.includes(o.lifecycle)) return 0;
  if (!q.text.length) return 1;
  const name = o.name.toLowerCase();
  const rest = [o.description, o.technology, o.owner, type.label, ...o.tags, ...Object.values(o.fields)].join(" ").toLowerCase();
  let score = 0;
  for (const term of q.text) {
    if (name === term) score += 12;
    else if (name.startsWith(term)) score += 8;
    else if (name.includes(term)) score += 5;
    else if (rest.includes(term)) score += 1;
    else return 0;
  }
  return score;
}

export function searchObjects(ws: Workspace, query: string, limit = 200): ModelObject[] {
  const q = parseQuery(query);
  return Object.values(ws.objects)
    .map((o) => ({ o, score: objectScore(o, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.o.name.localeCompare(b.o.name))
    .slice(0, limit)
    .map((r) => r.o);
}

export function searchDiagrams(ws: Workspace, query: string, limit = 50): Diagram[] {
  const q = parseQuery(query);
  // Filters such as tag: describe objects, so a filtered query matches no diagrams.
  if (!q.text.length || q.tags.length || q.types.length || q.owners.length || q.lifecycles.length) return [];
  return Object.values(ws.diagrams)
    .filter((d) => q.text.every((t) => `${d.name} ${d.description}`.toLowerCase().includes(t)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function searchWorkspace(ws: Workspace, query: string): { objects: ModelObject[]; diagrams: Diagram[] } {
  if (!query.trim()) return { objects: [], diagrams: [] };
  return { objects: searchObjects(ws, query, 8), diagrams: searchDiagrams(ws, query, 5) };
}
