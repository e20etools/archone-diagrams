import { RELATION_KIND_INFO } from "./catalog";
import { ancestorsOf, descendantsOf, diagramsUsing } from "./model";
import type { Diagram, ModelObject, Relationship, Workspace } from "./types";

/**
 * Dependency and impact analysis over the whole model, not one diagram (PRD FR-15, FR-16).
 * A relationship reads "source needs target", and only kinds marked as dependencies count.
 */

export type Direction = "upstream" | "downstream";

export interface Reach {
  id: string;
  /** Number of dependency steps from the starting object. */
  distance: number;
  /** The relationship that led here. */
  via: string;
  /** The object one step closer to the start. */
  from: string;
}

export interface TraverseOptions {
  /** Count objects nested inside the start object as part of it. Defaults to true. */
  includeChildren?: boolean;
  maxDepth?: number;
}

function dependencyRelationships(ws: Workspace): Relationship[] {
  return Object.values(ws.relationships).filter((r) => RELATION_KIND_INFO[r.kind].dependency);
}

export function startSet(ws: Workspace, id: string, includeChildren = true): string[] {
  if (!ws.objects[id]) return [];
  return includeChildren ? [id, ...descendantsOf(ws, id)] : [id];
}

/**
 * upstream: everything the object depends on.
 * downstream: everything that depends on the object.
 */
export function traverse(ws: Workspace, id: string, direction: Direction, options: TraverseOptions = {}): Reach[] {
  const start = startSet(ws, id, options.includeChildren ?? true);
  if (!start.length) return [];
  const maxDepth = options.maxDepth ?? Infinity;
  const relationships = dependencyRelationships(ws);
  const next = new Map<string, Relationship[]>();
  for (const r of relationships) {
    const key = direction === "upstream" ? r.sourceId : r.targetId;
    const list = next.get(key);
    if (list) list.push(r);
    else next.set(key, [r]);
  }
  const seen = new Set(start);
  const out: Reach[] = [];
  let frontier = start.map((s) => ({ id: s, distance: 0 }));
  while (frontier.length) {
    const upcoming: { id: string; distance: number }[] = [];
    for (const node of frontier) {
      if (node.distance >= maxDepth) continue;
      for (const r of next.get(node.id) ?? []) {
        const other = direction === "upstream" ? r.targetId : r.sourceId;
        if (seen.has(other) || !ws.objects[other]) continue;
        seen.add(other);
        out.push({ id: other, distance: node.distance + 1, via: r.id, from: node.id });
        upcoming.push({ id: other, distance: node.distance + 1 });
      }
    }
    frontier = upcoming;
  }
  return out;
}

/** The chain of object names from the start object to a reached object. */
export function pathTo(ws: Workspace, reaches: Reach[], id: string): string[] {
  const byId = new Map(reaches.map((r) => [r.id, r]));
  const names: string[] = [];
  let current: string | undefined = id;
  const guard = new Set<string>();
  while (current && !guard.has(current)) {
    guard.add(current);
    names.unshift(ws.objects[current]?.name ?? "?");
    current = byId.get(current)?.from;
  }
  return names;
}

export type ChangeKind = "changing" | "retiring";

export interface AffectedObject {
  object: ModelObject;
  distance: number;
  path: string[];
  partOf: string[];
  diagrams: Diagram[];
}

export interface ImpactReport {
  target: ModelObject;
  change: ChangeKind;
  affected: AffectedObject[];
  /** Owners to tell, with how many affected objects each one owns. Objects without an owner are counted under "". */
  owners: { owner: string; count: number }[];
  /** Diagrams that show the target or anything affected. */
  diagrams: Diagram[];
  /** Relationships that stop working when the target is retired. */
  brokenRelationships: Relationship[];
}

export function impactOf(ws: Workspace, id: string, change: ChangeKind, options: TraverseOptions = {}): ImpactReport | null {
  const target = ws.objects[id];
  if (!target) return null;
  const includeChildren = options.includeChildren ?? true;
  const reaches = traverse(ws, id, "downstream", { ...options, includeChildren });
  const affected: AffectedObject[] = reaches
    .map((reach) => {
      const object = ws.objects[reach.id];
      return {
        object,
        distance: reach.distance,
        path: pathTo(ws, reaches, reach.id),
        partOf: ancestorsOf(ws, reach.id).map((a) => ws.objects[a].name),
        diagrams: diagramsUsing(ws, reach.id),
      };
    })
    .sort((a, b) => a.distance - b.distance || a.object.name.localeCompare(b.object.name));

  const ownerCounts = new Map<string, number>();
  for (const a of affected) ownerCounts.set(a.object.owner.trim(), (ownerCounts.get(a.object.owner.trim()) ?? 0) + 1);
  const owners = [...ownerCounts.entries()]
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));

  const diagramMap = new Map<string, Diagram>();
  for (const d of diagramsUsing(ws, id)) diagramMap.set(d.id, d);
  for (const a of affected) for (const d of a.diagrams) diagramMap.set(d.id, d);

  const members = new Set(startSet(ws, id, includeChildren));
  const brokenRelationships =
    change === "retiring"
      ? Object.values(ws.relationships).filter((r) => members.has(r.sourceId) !== members.has(r.targetId))
      : [];

  return {
    target,
    change,
    affected,
    owners,
    diagrams: [...diagramMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    brokenRelationships,
  };
}
