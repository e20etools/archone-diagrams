import type { Adr, CustomRule, Diagram, ModelObject, NodePlacement, Proposal, Relationship, Workspace } from "../types";

/**
 * The model as flat tables, one entry per database row. The hosted backend stores and syncs
 * rows, so the app's nested workspace is converted to this shape at the edge and back.
 */

export type DiagramMeta = Omit<Diagram, "nodes">;

export interface Tables {
  objects: Record<string, ModelObject>;
  relationships: Record<string, Relationship>;
  diagrams: Record<string, DiagramMeta>;
  /** Keyed by nodeKey(diagramId, objectId). */
  nodes: Record<string, NodePlacement>;
  proposals: Record<string, Proposal>;
  adrs: Record<string, Adr>;
  rules: Record<string, CustomRule>;
}

export const TABLE_NAMES = ["objects", "relationships", "diagrams", "nodes", "proposals", "adrs", "rules"] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** A set of row changes. null means the row was deleted. */
export type ChangeSet = { [T in TableName]?: Record<string, Tables[T][string] | null> };

const SEP = "\u0000";
export const nodeKey = (diagramId: string, objectId: string) => `${diagramId}${SEP}${objectId}`;
export const splitNodeKey = (key: string): [string, string] => {
  const at = key.indexOf(SEP);
  return [key.slice(0, at), key.slice(at + 1)];
};

export const emptyTables = (): Tables => ({ objects: {}, relationships: {}, diagrams: {}, nodes: {}, proposals: {}, adrs: {}, rules: {} });

// A diagram that did not change keeps the same meta and node objects, so comparing stays cheap.
const split = new WeakMap<Diagram, { meta: DiagramMeta; nodes: [string, NodePlacement][] }>();

export function toTables(ws: Pick<Workspace, "objects" | "relationships" | "diagrams" | "proposals" | "adrs" | "rules">): Tables {
  const diagrams: Record<string, DiagramMeta> = {};
  const nodes: Record<string, NodePlacement> = {};
  for (const diagram of Object.values(ws.diagrams)) {
    let parts = split.get(diagram);
    if (!parts) {
      const { nodes: placed, ...meta } = diagram;
      parts = { meta, nodes: Object.entries(placed).map(([objectId, placement]) => [nodeKey(diagram.id, objectId), placement]) };
      split.set(diagram, parts);
    }
    diagrams[diagram.id] = parts.meta;
    for (const [key, placement] of parts.nodes) nodes[key] = placement;
  }
  return { objects: ws.objects, relationships: ws.relationships, diagrams, nodes, proposals: ws.proposals, adrs: ws.adrs, rules: ws.rules };
}

/** Rebuilds the nested collections. A box whose diagram is missing is dropped. */
export function fromTables(tables: Tables): Pick<Workspace, "objects" | "relationships" | "diagrams" | "proposals" | "adrs" | "rules"> {
  const diagrams: Record<string, Diagram> = {};
  for (const meta of Object.values(tables.diagrams)) diagrams[meta.id] = { ...meta, nodes: {} };
  for (const [key, placement] of Object.entries(tables.nodes)) {
    const [diagramId, objectId] = splitNodeKey(key);
    if (diagrams[diagramId]) diagrams[diagramId].nodes[objectId] = placement;
  }
  return { objects: tables.objects, relationships: tables.relationships, diagrams, proposals: tables.proposals, adrs: tables.adrs ?? {}, rules: tables.rules ?? {} };
}

/** Deep equality that ignores key order and treats a missing key like undefined (the database reorders JSON keys). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (left[key] === undefined && right[key] === undefined) continue;
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}

/** The changes that turn `from` into `to`. */
export function diffTables(from: Tables, to: Tables): ChangeSet {
  const out: ChangeSet = {};
  for (const table of TABLE_NAMES) {
    // A copy stored before a table existed simply has none of its rows.
    const before = (from[table] ?? {}) as Record<string, unknown>;
    const after = (to[table] ?? {}) as Record<string, unknown>;
    if (before === after) continue;
    let changes: Record<string, unknown> | undefined;
    for (const key of Object.keys(after)) {
      if (before[key] !== after[key] && !sameValue(before[key], after[key])) (changes ??= {})[key] = after[key];
    }
    for (const key of Object.keys(before)) {
      if (!(key in after)) (changes ??= {})[key] = null;
    }
    if (changes) (out as Record<string, unknown>)[table] = changes;
  }
  return out;
}

export const isEmptyChange = (change: ChangeSet) => TABLE_NAMES.every((t) => !change[t] || Object.keys(change[t]!).length === 0);
export const countChanges = (change: ChangeSet) => TABLE_NAMES.reduce((n, t) => n + Object.keys(change[t] ?? {}).length, 0);

export function patchTables(tables: Tables, change: ChangeSet): Tables {
  const out: Tables = { ...tables };
  for (const table of TABLE_NAMES) {
    const rows = change[table];
    if (!rows || Object.keys(rows).length === 0) continue;
    const next = { ...((tables[table] ?? {}) as Record<string, unknown>) };
    for (const [key, value] of Object.entries(rows)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    (out as unknown as Record<string, unknown>)[table] = next;
  }
  return out;
}

/**
 * Another person's changes can leave references that point nowhere (a relationship to an object
 * they deleted). The app assumes there are none, so they are removed here; the resulting
 * difference is saved back like any other edit.
 */
export function withoutDangling(tables: Tables): Tables {
  const objects = tables.objects;
  let fixedObjects: Record<string, ModelObject> | undefined;
  for (const o of Object.values(objects)) {
    if (o.parentId && !objects[o.parentId]) (fixedObjects ??= { ...objects })[o.id] = { ...o, parentId: null };
  }
  let relationships = tables.relationships;
  for (const r of Object.values(tables.relationships)) {
    if (!objects[r.sourceId] || !objects[r.targetId]) {
      if (relationships === tables.relationships) relationships = { ...relationships };
      delete relationships[r.id];
    }
  }
  let diagrams = tables.diagrams;
  for (const d of Object.values(tables.diagrams)) {
    if (d.scopeId && !objects[d.scopeId]) {
      if (diagrams === tables.diagrams) diagrams = { ...diagrams };
      diagrams[d.id] = { ...d, scopeId: null };
    }
  }
  let nodes = tables.nodes;
  for (const key of Object.keys(tables.nodes)) {
    const [diagramId, objectId] = splitNodeKey(key);
    if (!objects[objectId] || !tables.diagrams[diagramId]) {
      if (nodes === tables.nodes) nodes = { ...nodes };
      delete nodes[key];
    }
  }
  if (!fixedObjects && relationships === tables.relationships && diagrams === tables.diagrams && nodes === tables.nodes) return tables;
  return { ...tables, objects: fixedObjects ?? objects, relationships, diagrams, nodes };
}

/** Applies row changes to a workspace and returns a consistent workspace. */
export function applyChangeSet(ws: Workspace, change: ChangeSet): Workspace {
  if (isEmptyChange(change)) return ws;
  return { ...ws, ...fromTables(withoutDangling(patchTables(toTables(ws), change))) };
}
