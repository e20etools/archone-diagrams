import dagre from "@dagrejs/dagre";
import type { NodePlacement } from "./types";

export const NODE_W = 216;
export const NODE_H = 78;
const GRID = 8;
const snap = (v: number) => Math.round(v / GRID) * GRID;

export interface LayoutInput {
  nodeIds: string[];
  edges: { sourceId: string; targetId: string }[];
  direction: "TB" | "LR";
  /** Current placements; pinned ones are kept when respectPinned is true. */
  current?: Record<string, NodePlacement>;
  respectPinned?: boolean;
  /** nodeId -> group id. Members of one group are kept together (the boundary of a scoped diagram, a network zone). */
  groups?: Record<string, string>;
  /** group id -> the group it sits in, for a zone inside a zone or inside the boundary. */
  groupParents?: Record<string, string>;
}

type Point = { x: number; y: number };

function runDagre(nodeIds: string[], edges: LayoutInput["edges"], direction: "TB" | "LR", groups?: Record<string, string>, groupParents?: Record<string, string>) {
  const compound = !!groups && Object.keys(groups).length > 0;
  const g = new dagre.graphlib.Graph({ compound });
  // Left to right, an arrow's label rests on its last horizontal run, so the columns need more room between them.
  g.setGraph({ rankdir: direction, nodesep: 36, ranksep: direction === "LR" ? 132 : 72, marginx: 32, marginy: 32 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of nodeIds) g.setNode(id, { width: NODE_W, height: NODE_H });
  if (compound && groups) {
    for (const [nodeId, groupId] of Object.entries(groups)) {
      if (!g.hasNode(nodeId)) continue;
      const gid = `group:${groupId}`;
      if (!g.hasNode(gid)) g.setNode(gid, {});
      g.setParent(nodeId, gid);
    }
    for (const [groupId, parentId] of Object.entries(groupParents ?? {})) {
      const gid = `group:${groupId}`;
      const pid = `group:${parentId}`;
      if (!g.hasNode(gid) || groupId === parentId) continue;
      if (!g.hasNode(pid)) g.setNode(pid, {});
      g.setParent(gid, pid);
    }
  }
  const ids = new Set(nodeIds);
  for (const e of edges) {
    if (e.sourceId !== e.targetId && ids.has(e.sourceId) && ids.has(e.targetId)) g.setEdge(e.sourceId, e.targetId);
  }
  dagre.layout(g);
  const out: Record<string, Point> = {};
  for (const id of nodeIds) {
    const n = g.node(id);
    out[id] = { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 };
  }
  return out;
}

function grid(nodeIds: string[], origin: Point, direction: "TB" | "LR"): Record<string, Point> {
  const out: Record<string, Point> = {};
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodeIds.length) * (direction === "TB" ? 1.6 : 1)));
  nodeIds.forEach((id, i) => {
    out[id] = {
      x: origin.x + (i % columns) * (NODE_W + 36),
      y: origin.y + Math.floor(i / columns) * (NODE_H + 48),
    };
  });
  return out;
}

/**
 * Layered layout for connected nodes, a tidy grid for unconnected ones.
 * With respectPinned, hand-placed nodes stay where they are and the rest is
 * arranged around them (PRD FR-09).
 */
export function autoLayout(input: LayoutInput): Record<string, Point> {
  const { nodeIds, edges, direction, current = {}, respectPinned = true, groups, groupParents } = input;
  if (nodeIds.length === 0) return {};

  const ids = new Set(nodeIds);
  const connected = new Set<string>();
  for (const e of edges) {
    if (e.sourceId !== e.targetId && ids.has(e.sourceId) && ids.has(e.targetId)) {
      connected.add(e.sourceId);
      connected.add(e.targetId);
    }
  }
  // Members of a boundary group stay in the layered layout so the boundary keeps them together.
  for (const id of nodeIds) if (groups?.[id]) connected.add(id);
  const linked = nodeIds.filter((id) => connected.has(id));
  const loose = nodeIds.filter((id) => !connected.has(id));

  let computed: Record<string, Point> = {};
  if (linked.length) {
    try {
      computed = runDagre(linked, edges, direction, groups, groupParents);
    } catch {
      // The grouped layout can fail on unusual graphs; a flat layout is still a usable result.
      computed = runDagre(linked, edges, direction);
    }
  }
  if (loose.length) {
    let origin: Point = { x: 32, y: 32 };
    const placed = Object.values(computed);
    if (placed.length) {
      origin =
        direction === "TB"
          ? { x: Math.min(...placed.map((p) => p.x)), y: Math.max(...placed.map((p) => p.y)) + NODE_H + 96 }
          : { x: Math.max(...placed.map((p) => p.x)) + NODE_W + 120, y: Math.min(...placed.map((p) => p.y)) };
    }
    Object.assign(computed, grid(loose, origin, direction));
  }

  const pinned = respectPinned ? nodeIds.filter((id) => current[id]?.pinned) : [];
  let dx = 0;
  let dy = 0;
  if (pinned.length) {
    // Shift the computed layout so it sits around the hand-placed nodes instead of on top of them.
    for (const id of pinned) {
      dx += current[id].x - computed[id].x;
      dy += current[id].y - computed[id].y;
    }
    dx /= pinned.length;
    dy /= pinned.length;
  }
  const pinnedSet = new Set(pinned);
  const out: Record<string, Point> = {};
  for (const id of nodeIds) {
    out[id] = pinnedSet.has(id)
      ? { x: current[id].x, y: current[id].y }
      : { x: snap(computed[id].x + dx), y: snap(computed[id].y + dy) };
  }
  return out;
}

export function boundsOf(points: Point[]): { x: number; y: number; width: number; height: number } | null {
  if (!points.length) return null;
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x)) + NODE_W;
  const maxY = Math.max(...points.map((p) => p.y)) + NODE_H;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
