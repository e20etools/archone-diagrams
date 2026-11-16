import { objectType } from "./catalog";
import { autoLayout } from "./layout";
import { ancestorsOf, childrenOf, createDiagram, descendantsOf, placeNodes, type DiagramInput } from "./model";
import type { Diagram, NodePlacement, RelationKind, ViewType, Workspace } from "./types";

/**
 * A diagram never stores edges. They are derived from the model each time, so a
 * relationship drawn once shows up in every view that contains both ends (PRD FR-02, FR-08).
 */

export interface ViewEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: RelationKind;
  label: string;
  /** The stored relationships behind this edge; more than one when child relationships are rolled up. */
  relationshipIds: string[];
  /** True when the relationship belongs to objects nested inside the visible ends. */
  implied: boolean;
}

/** The object itself when it is on the diagram, otherwise its nearest ancestor that is. */
export function nearestVisible(ws: Workspace, nodeIds: Set<string>, id: string): string | null {
  if (nodeIds.has(id)) return id;
  for (const ancestor of ancestorsOf(ws, id)) if (nodeIds.has(ancestor)) return ancestor;
  return null;
}

export function visibleEdges(ws: Workspace, diagram: Diagram): ViewEdge[] {
  const nodeIds = new Set(Object.keys(diagram.nodes));
  const hidden = new Set(diagram.hiddenRelationshipIds);
  const allowed = diagram.edgeKinds ? new Set(diagram.edgeKinds) : null;
  const direct: ViewEdge[] = [];
  const implied = new Map<string, ViewEdge>();
  const directKeys = new Set<string>();

  for (const r of Object.values(ws.relationships)) {
    if (hidden.has(r.id)) continue;
    if (allowed && !allowed.has(r.kind)) continue;
    const s = nearestVisible(ws, nodeIds, r.sourceId);
    const t = nearestVisible(ws, nodeIds, r.targetId);
    if (!s || !t || s === t) continue;
    const key = `${s}>${t}>${r.kind}`;
    if (s === r.sourceId && t === r.targetId) {
      direct.push({ id: r.id, sourceId: s, targetId: t, kind: r.kind, label: r.label, relationshipIds: [r.id], implied: false });
      directKeys.add(key);
    } else {
      const existing = implied.get(key);
      if (existing) existing.relationshipIds.push(r.id);
      else implied.set(key, { id: `implied:${key}`, sourceId: s, targetId: t, kind: r.kind, label: r.label, relationshipIds: [r.id], implied: true });
    }
  }
  const rolledUp = [...implied.entries()]
    .filter(([key]) => !directKeys.has(key))
    .map(([, edge]) => (edge.relationshipIds.length > 1 ? { ...edge, label: `${edge.relationshipIds.length} relationships` } : edge));
  return [...direct, ...rolledUp];
}

/** Nodes of a scoped diagram that sit inside the scope object; they are drawn within its boundary. */
export function scopeMembers(ws: Workspace, diagram: Diagram): string[] {
  if (!diagram.scopeId || !ws.objects[diagram.scopeId]) return [];
  const inside = new Set(descendantsOf(ws, diagram.scopeId));
  return Object.keys(diagram.nodes).filter((id) => inside.has(id));
}

/** The objects a view type would show by default: its projection of the model. */
export function suggestObjects(ws: Workspace, viewType: ViewType, scopeId: string | null): string[] {
  const objects = Object.values(ws.objects);
  const scope = scopeId && ws.objects[scopeId] ? scopeId : null;
  const inside = scope ? new Set(descendantsOf(ws, scope)) : null;
  const out = new Set<string>();

  // A neighbour is shown at system level, but never lifted into something that also contains the scope:
  // a sibling application inside the same system stays itself.
  const scopeLine = new Set(scope ? [scope, ...ancestorsOf(ws, scope)] : []);
  const lift = (id: string): string => {
    let current = id;
    for (const ancestor of ancestorsOf(ws, id)) {
      if (scopeLine.has(ancestor)) break;
      if (objectType(ws.objects[current].typeId).level <= 2) break;
      current = ancestor;
    }
    return current;
  };

  const neighboursOf = (members: Set<string>) => {
    for (const r of Object.values(ws.relationships)) {
      const sIn = members.has(r.sourceId);
      const tIn = members.has(r.targetId);
      if (sIn === tIn) continue;
      const other = sIn ? r.targetId : r.sourceId;
      if (!ws.objects[other]) continue;
      out.add(lift(other));
    }
  };

  switch (viewType) {
    case "landscape": {
      const top = objects.filter((o) => objectType(o.typeId).level <= 2);
      for (const o of top.length ? top : objects.filter((o) => !o.parentId)) out.add(o.id);
      break;
    }
    case "context": {
      if (!scope || !inside) return suggestObjects(ws, "landscape", null);
      out.add(scope);
      neighboursOf(new Set([scope, ...inside]));
      break;
    }
    case "container": {
      if (!scope || !inside) {
        for (const o of objects) if (objectType(o.typeId).level === 3) out.add(o.id);
        break;
      }
      for (const child of childrenOf(ws, scope)) out.add(child.id);
      neighboursOf(inside);
      for (const id of [...out]) if (id === scope) out.delete(id);
      break;
    }
    case "deployment": {
      const infra = new Set(
        objects.filter((o) => objectType(o.typeId).category === "infrastructure" && (!inside || inside.has(o.id))).map((o) => o.id),
      );
      for (const id of infra) out.add(id);
      for (const r of Object.values(ws.relationships)) {
        if (r.kind !== "hosted_on") continue;
        if (infra.has(r.targetId) && ws.objects[r.sourceId]) out.add(r.sourceId);
        if (inside?.has(r.sourceId) && ws.objects[r.targetId]) {
          out.add(r.sourceId);
          out.add(r.targetId);
        }
      }
      break;
    }
    case "dataflow": {
      const data = new Set(
        objects.filter((o) => objectType(o.typeId).category === "data" && (!inside || inside.has(o.id))).map((o) => o.id),
      );
      for (const id of data) out.add(id);
      for (const r of Object.values(ws.relationships)) {
        if (r.kind !== "reads_writes" && r.kind !== "replicates_to") continue;
        if (data.has(r.targetId) && ws.objects[r.sourceId]) out.add(r.sourceId);
        if (data.has(r.sourceId) && ws.objects[r.targetId]) out.add(r.targetId);
      }
      break;
    }
    case "custom":
      break;
  }
  return [...out];
}

export const DEFAULT_EDGE_KINDS: Record<ViewType, RelationKind[] | null> = {
  landscape: null,
  context: null,
  container: null,
  deployment: ["hosted_on", "routes_to"],
  dataflow: ["reads_writes", "replicates_to"],
  custom: null,
};

function layoutGroups(ws: Workspace, diagram: Diagram): Record<string, string> | undefined {
  const members = scopeMembers(ws, diagram);
  if (!members.length || !diagram.scopeId) return undefined;
  return Object.fromEntries(members.map((id) => [id, diagram.scopeId!]));
}

/** Arranges a diagram. Pinned nodes keep their place unless respectPinned is false, which also unpins everything. */
export function relayout(ws: Workspace, diagramId: string, respectPinned = true): Workspace {
  const diagram = ws.diagrams[diagramId];
  if (!diagram) return ws;
  const nodeIds = Object.keys(diagram.nodes);
  const positions = autoLayout({
    nodeIds,
    edges: visibleEdges(ws, diagram),
    direction: diagram.direction,
    current: diagram.nodes,
    respectPinned,
    groups: layoutGroups(ws, diagram),
  });
  const placements: Record<string, NodePlacement> = {};
  for (const id of nodeIds) {
    placements[id] = { ...positions[id], pinned: respectPinned ? diagram.nodes[id].pinned : false };
  }
  return placeNodes(ws, diagramId, placements);
}

/** Adds object references to a diagram. Without a position they are placed by auto-layout. */
export function addObjectsToDiagram(
  ws: Workspace,
  diagramId: string,
  objectIds: string[],
  at?: { x: number; y: number },
): Workspace {
  const diagram = ws.diagrams[diagramId];
  if (!diagram) return ws;
  const fresh = objectIds.filter((id) => ws.objects[id] && !(id in diagram.nodes));
  if (!fresh.length) return ws;
  const placements: Record<string, NodePlacement> = {};
  fresh.forEach((id, i) => {
    placements[id] = at ? { x: at.x + i * 24, y: at.y + i * 24, pinned: true } : { x: 0, y: 0, pinned: false };
  });
  const next = placeNodes(ws, diagramId, placements);
  return at ? next : relayout(next, diagramId, true);
}

/** Creates a diagram of a given view type and fills it with that view's projection of the model. */
export function createView(ws: Workspace, input: DiagramInput): { ws: Workspace; diagram: Diagram } {
  const created = createDiagram(ws, input);
  const viewType = created.diagram.viewType;
  const withKinds: Workspace = {
    ...created.ws,
    diagrams: {
      ...created.ws.diagrams,
      [created.diagram.id]: { ...created.diagram, edgeKinds: DEFAULT_EDGE_KINDS[viewType] },
    },
  };
  const filled = addObjectsToDiagram(withKinds, created.diagram.id, suggestObjects(withKinds, viewType, created.diagram.scopeId));
  return { ws: filled, diagram: filled.diagrams[created.diagram.id] };
}

/** Objects the view type would show that are not on the diagram yet. */
export function missingSuggestions(ws: Workspace, diagram: Diagram): string[] {
  return suggestObjects(ws, diagram.viewType, diagram.scopeId).filter((id) => !(id in diagram.nodes));
}

/** Zooming into an object opens the diagram of its inside, creating it the first time (PRD FR-04). */
export function ensureDetailDiagram(ws: Workspace, objectId: string): { ws: Workspace; diagramId: string | null; created: boolean } {
  const object = ws.objects[objectId];
  if (!object) return { ws, diagramId: null, created: false };
  const existing = Object.values(ws.diagrams)
    .filter((d) => d.scopeId === objectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (existing) return { ws, diagramId: existing.id, created: false };
  const made = createView(ws, { name: `Inside ${object.name}`, viewType: "container", scopeId: objectId });
  return { ws: made.ws, diagramId: made.diagram.id, created: true };
}
