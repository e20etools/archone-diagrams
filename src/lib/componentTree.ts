import { RELATION_KIND_INFO } from "./catalog";
import { MAX_LEVELS } from "./impact";
import { diagramsUsing, protocolsOf } from "./model";
import type { Diagram, RelationKind, Workspace } from "./types";

/**
 * The relationships of one component as two trees: what it relies on ("out", following the
 * arrows) and what relies on it ("in", against them), up to five levels. Each object appears
 * once, at the level nearest the component; a relationship to an object already in the tree is
 * kept as a reference without branches, so every relationship within reach is listed and the
 * tree stays finite.
 */

export type TreeDirection = "out" | "in";
/** Dependency kinds only (calls, depends on, reads or writes, hosted on), or every kind. */
export type TreeScope = "dependencies" | "all";

export interface TreeLink {
  relationshipId: string;
  kind: RelationKind;
  /** The relationship's own label, or the kind's name. */
  label: string;
  protocols: string[];
  /** Data or calls go both ways. */
  both: boolean;
}

export interface TreeNode {
  id: string;
  /** 1 for a direct relationship, up to five. */
  level: number;
  link: TreeLink;
  /** Already shown nearer the component; drawn as a reference with no branches of its own. */
  repeat: boolean;
  children: TreeNode[];
}

interface Edge {
  to: string;
  link: TreeLink;
}

function edgesOf(ws: Workspace, scope: TreeScope): Record<TreeDirection, Map<string, Edge[]>> {
  const out = new Map<string, Edge[]>();
  const into = new Map<string, Edge[]>();
  const add = (map: Map<string, Edge[]>, from: string, edge: Edge) => (map.get(from) ?? map.set(from, []).get(from)!).push(edge);
  for (const r of Object.values(ws.relationships)) {
    if (!ws.objects[r.sourceId] || !ws.objects[r.targetId] || r.sourceId === r.targetId) continue;
    const info = RELATION_KIND_INFO[r.kind];
    if (!info || (scope === "dependencies" && !info.dependency)) continue;
    const link: TreeLink = {
      relationshipId: r.id,
      kind: r.kind,
      label: r.label.trim() || info.label,
      protocols: protocolsOf(r).map((p) => p.name),
      both: r.flow === "both",
    };
    add(out, r.sourceId, { to: r.targetId, link });
    add(into, r.targetId, { to: r.sourceId, link });
    // Both ways: each side relies on the other.
    if (link.both) {
      add(out, r.targetId, { to: r.sourceId, link });
      add(into, r.sourceId, { to: r.targetId, link });
    }
  }
  const byName = (a: Edge, b: Edge) => (ws.objects[a.to]?.name ?? "").localeCompare(ws.objects[b.to]?.name ?? "") || a.link.kind.localeCompare(b.link.kind);
  for (const list of [...out.values(), ...into.values()]) list.sort(byName);
  return { out, in: into };
}

/** The tree on one side of a component, level by level, nearest first. */
export function componentTree(ws: Workspace, rootId: string, direction: TreeDirection, levels = MAX_LEVELS, scope: TreeScope = "all"): TreeNode[] {
  if (!ws.objects[rootId]) return [];
  const graph = edgesOf(ws, scope)[direction];
  const placed = new Set([rootId]);
  const roots: TreeNode[] = [];
  let frontier: { id: string; via: string | null; children: TreeNode[] }[] = [{ id: rootId, via: null, children: roots }];
  for (let level = 1; level <= Math.min(levels, MAX_LEVELS) && frontier.length; level++) {
    const next: typeof frontier = [];
    for (const parent of frontier) {
      for (const e of graph.get(parent.id) ?? []) {
        // The way back along the relationship that led here is not a new branch.
        if (e.link.relationshipId === parent.via) continue;
        if (placed.has(e.to)) {
          parent.children.push({ id: e.to, level, link: e.link, repeat: true, children: [] });
          continue;
        }
        placed.add(e.to);
        const node: TreeNode = { id: e.to, level, link: e.link, repeat: false, children: [] };
        parent.children.push(node);
        next.push({ id: e.to, via: e.link.relationshipId, children: node.children });
      }
    }
    frontier = next;
  }
  return roots;
}

/** Every node of a tree, depth first. */
export function flatten(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (list: TreeNode[]) => {
    for (const n of list) {
      out.push(n);
      visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

/** How many objects each level adds, for levels 1 to five; references are not counted again. */
export function levelCounts(nodes: TreeNode[]): number[] {
  const counts = Array.from({ length: MAX_LEVELS }, () => 0);
  for (const n of flatten(nodes)) if (!n.repeat) counts[n.level - 1]++;
  return counts;
}

export interface TreeDiagram {
  diagram: Diagram;
  /** Objects of the trees that are on it. */
  objects: string[];
  /** The nearest level at which it is reached; 0 when the component itself is on it. */
  level: number;
  /** Which tree reaches it. */
  sides: TreeDirection[];
}

/** The diagrams the component and the objects related to it are on, nearest first. */
export function treeDiagrams(ws: Workspace, rootId: string, trees: Record<TreeDirection, TreeNode[]>): TreeDiagram[] {
  const found = new Map<string, TreeDiagram>();
  const note = (id: string, level: number, side: TreeDirection | null) => {
    for (const d of diagramsUsing(ws, id)) {
      if (d.archive?.archived) continue;
      const known = found.get(d.id) ?? found.set(d.id, { diagram: d, objects: [], level, sides: [] }).get(d.id)!;
      if (!known.objects.includes(id)) known.objects.push(id);
      known.level = Math.min(known.level, level);
      if (side && !known.sides.includes(side)) known.sides.push(side);
    }
  };
  note(rootId, 0, null);
  for (const side of ["out", "in"] as const) for (const n of flatten(trees[side])) if (!n.repeat) note(n.id, n.level, side);
  return [...found.values()].sort((a, b) => a.level - b.level || b.objects.length - a.objects.length || a.diagram.name.localeCompare(b.diagram.name));
}
