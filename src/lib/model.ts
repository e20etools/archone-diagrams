import { DEFAULT_TYPE_ID, isKnownType, objectType } from "./catalog";
import { cleanLinks } from "./links";
import type {
  Diagram,
  Lifecycle,
  ModelLink,
  ModelObject,
  NodePlacement,
  Provenance,
  RelationKind,
  Relationship,
  ViewType,
  Workspace,
} from "./types";

/** Pure functions over the workspace. Every change returns a new workspace so undo and saving stay simple. */

export const nowIso = () => new Date().toISOString();

export function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += (b % 36).toString(36);
  return `${prefix}_${out}`;
}

export function emptyWorkspace(name = "My workspace"): Workspace {
  return {
    version: 1,
    name,
    userName: "",
    objects: {},
    relationships: {},
    diagrams: {},
    proposals: {},
    adrs: {},
    rules: {},
    updatedAt: nowIso(),
  };
}

const touch = (ws: Workspace): Workspace => ({ ...ws, updatedAt: nowIso() });
export const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
const manual: Provenance = { origin: "manual" };

/* ---------- hierarchy ---------- */

export function childrenOf(ws: Workspace, id: string): ModelObject[] {
  return Object.values(ws.objects).filter((o) => o.parentId === id);
}

export function descendantsOf(ws: Workspace, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of childrenOf(ws, current)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

/** Nearest parent first. */
export function ancestorsOf(ws: Workspace, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let current = ws.objects[id]?.parentId ?? null;
  while (current && !seen.has(current) && ws.objects[current]) {
    out.push(current);
    seen.add(current);
    current = ws.objects[current].parentId;
  }
  return out;
}

/** A parent must exist, sit on a higher level than the child, and not be the child or one of its descendants. */
export function canSetParent(ws: Workspace, childId: string | null, childTypeId: string, parentId: string): boolean {
  const parent = ws.objects[parentId];
  if (!parent) return false;
  if (objectType(parent.typeId).level >= objectType(childTypeId).level) return false;
  if (childId) {
    if (childId === parentId) return false;
    if (descendantsOf(ws, childId).includes(parentId)) return false;
  }
  return true;
}

export function possibleParents(ws: Workspace, childId: string | null, childTypeId: string): ModelObject[] {
  return Object.values(ws.objects)
    .filter((o) => canSetParent(ws, childId, childTypeId, o.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- objects ---------- */

export interface ObjectInput {
  typeId: string;
  name: string;
  description?: string;
  owner?: string;
  lifecycle?: Lifecycle;
  tags?: string[];
  parentId?: string | null;
  technology?: string;
  fields?: Record<string, string>;
  provenance?: Provenance;
}

export const cleanTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();

export function createObject(ws: Workspace, input: ObjectInput): { ws: Workspace; object: ModelObject } {
  const typeId = isKnownType(input.typeId) ? input.typeId : DEFAULT_TYPE_ID;
  const stamp = nowIso();
  const parentId = input.parentId && canSetParent(ws, null, typeId, input.parentId) ? input.parentId : null;
  const object: ModelObject = {
    id: newId("obj"),
    typeId,
    name: input.name.trim() || `New ${objectType(typeId).label.toLowerCase()}`,
    description: input.description?.trim() ?? "",
    owner: input.owner?.trim() ?? "",
    lifecycle: input.lifecycle ?? "active",
    tags: cleanTags(input.tags ?? []),
    parentId,
    technology: input.technology?.trim() ?? "",
    fields: input.fields ?? {},
    provenance: input.provenance ?? manual,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return { ws: touch({ ...ws, objects: { ...ws.objects, [object.id]: object } }), object };
}

/** An empty list is stored as no list at all, so "no links" has one spelling. */
function setLinks(target: { links?: ModelLink[] }, links: ModelLink[] | undefined): void {
  const clean = cleanLinks(links ?? []);
  if (clean.length) target.links = clean;
  else delete target.links;
}

export type ObjectPatch = Partial<Omit<ModelObject, "id" | "createdAt" | "updatedAt" | "provenance">>;

export function updateObject(ws: Workspace, id: string, patch: ObjectPatch): Workspace {
  const current = ws.objects[id];
  if (!current) return ws;
  const next: ModelObject = { ...current, ...patch, updatedAt: nowIso() };
  if (patch.typeId !== undefined && !isKnownType(patch.typeId)) next.typeId = current.typeId;
  if (patch.tags) next.tags = cleanTags(patch.tags);
  if (patch.name !== undefined) next.name = patch.name.trim() || current.name;
  if ("links" in patch) setLinks(next, patch.links);

  let objects = { ...ws.objects, [id]: next };
  // A new parent or a new type can break the level rule; repair instead of leaving an invalid tree.
  if (next.parentId && !canSetParent({ ...ws, objects }, id, next.typeId, next.parentId)) {
    next.parentId = current.parentId && canSetParent(ws, id, next.typeId, current.parentId) ? current.parentId : null;
    objects = { ...objects, [id]: next };
  }
  if (next.typeId !== current.typeId) {
    const level = objectType(next.typeId).level;
    for (const child of childrenOf(ws, id)) {
      if (objectType(child.typeId).level <= level) {
        objects = { ...objects, [child.id]: { ...child, parentId: null, updatedAt: nowIso() } };
      }
    }
  }
  return touch({ ...ws, objects });
}

/** Deleting an object removes its relationships and its nodes; its children move up to its parent. */
export function deleteObject(ws: Workspace, id: string): Workspace {
  const target = ws.objects[id];
  if (!target) return ws;
  const objects: Record<string, ModelObject> = {};
  for (const o of Object.values(ws.objects)) {
    if (o.id === id) continue;
    objects[o.id] = o.parentId === id ? { ...o, parentId: target.parentId, updatedAt: nowIso() } : o;
  }
  const removedRelationships = new Set<string>();
  const relationships: Record<string, Relationship> = {};
  for (const r of Object.values(ws.relationships)) {
    if (r.sourceId === id || r.targetId === id) removedRelationships.add(r.id);
    else relationships[r.id] = r;
  }
  const diagrams: Record<string, Diagram> = {};
  for (const d of Object.values(ws.diagrams)) {
    const hasNode = id in d.nodes;
    const hidden = d.hiddenRelationshipIds.filter((r) => !removedRelationships.has(r));
    const inFlow = d.flows?.some((f) => f.steps.some((s) => s.fromId === id || s.toId === id)) ?? false;
    if (!hasNode && !inFlow && d.scopeId !== id && hidden.length === d.hiddenRelationshipIds.length) {
      diagrams[d.id] = d;
      continue;
    }
    const nodes = { ...d.nodes };
    delete nodes[id];
    // A step about a deleted object has nothing left to point at.
    const flows = inFlow ? d.flows!.map((f) => ({ ...f, steps: f.steps.filter((s) => s.fromId !== id && s.toId !== id) })) : d.flows;
    diagrams[d.id] = { ...d, nodes, hiddenRelationshipIds: hidden, scopeId: d.scopeId === id ? null : d.scopeId, ...(flows ? { flows } : {}) };
  }
  return touch({ ...ws, objects, relationships, diagrams });
}

export function findByName(ws: Workspace, name: string): ModelObject | undefined {
  const wanted = normalizeName(name);
  if (!wanted) return undefined;
  return Object.values(ws.objects).find((o) => normalizeName(o.name) === wanted);
}

/* ---------- relationships ---------- */

export interface RelationshipInput {
  sourceId: string;
  targetId: string;
  kind?: RelationKind;
  label?: string;
  protocol?: string;
  port?: string;
  description?: string;
  provenance?: Provenance;
}

/** The same source, target and kind is stored once; asking again returns the stored relationship (PRD FR-02). */
export function createRelationship(
  ws: Workspace,
  input: RelationshipInput,
): { ws: Workspace; relationship: Relationship | null; created: boolean } {
  const kind = input.kind ?? "calls";
  if (input.sourceId === input.targetId || !ws.objects[input.sourceId] || !ws.objects[input.targetId]) {
    return { ws, relationship: null, created: false };
  }
  const existing = Object.values(ws.relationships).find(
    (r) => r.sourceId === input.sourceId && r.targetId === input.targetId && r.kind === kind,
  );
  if (existing) return { ws, relationship: existing, created: false };
  const stamp = nowIso();
  const relationship: Relationship = {
    id: newId("rel"),
    sourceId: input.sourceId,
    targetId: input.targetId,
    kind,
    label: input.label?.trim() ?? "",
    protocol: input.protocol?.trim() ?? "",
    port: input.port?.trim() ?? "",
    description: input.description?.trim() ?? "",
    provenance: input.provenance ?? manual,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return {
    ws: touch({ ...ws, relationships: { ...ws.relationships, [relationship.id]: relationship } }),
    relationship,
    created: true,
  };
}

export type RelationshipPatch = Partial<Pick<Relationship, "kind" | "label" | "protocol" | "port" | "description" | "links">>;

export function updateRelationship(ws: Workspace, id: string, patch: RelationshipPatch): Workspace {
  const current = ws.relationships[id];
  if (!current) return ws;
  // The target's owner confirmed the relationship as it was; a changed one has to be confirmed again.
  const { acknowledgement, ...kept } = current;
  // A link is a pointer to documentation, not part of what was confirmed.
  const changed = (Object.keys(patch) as (keyof RelationshipPatch)[]).some((key) => key !== "links" && patch[key] !== undefined && patch[key] !== current[key]);
  const next: Relationship = { ...(changed ? kept : current), ...patch, updatedAt: nowIso() };
  if ("links" in patch) setLinks(next, patch.links);
  return touch({ ...ws, relationships: { ...ws.relationships, [id]: next } });
}

export function deleteRelationship(ws: Workspace, id: string): Workspace {
  if (!ws.relationships[id]) return ws;
  const relationships = { ...ws.relationships };
  delete relationships[id];
  const diagrams: Record<string, Diagram> = {};
  for (const d of Object.values(ws.diagrams)) {
    diagrams[d.id] = d.hiddenRelationshipIds.includes(id)
      ? { ...d, hiddenRelationshipIds: d.hiddenRelationshipIds.filter((r) => r !== id) }
      : d;
  }
  return touch({ ...ws, relationships, diagrams });
}

export function relationshipsOf(ws: Workspace, id: string): { outgoing: Relationship[]; incoming: Relationship[] } {
  const outgoing: Relationship[] = [];
  const incoming: Relationship[] = [];
  for (const r of Object.values(ws.relationships)) {
    if (r.sourceId === id) outgoing.push(r);
    if (r.targetId === id) incoming.push(r);
  }
  return { outgoing, incoming };
}

/* ---------- diagrams ---------- */

export interface DiagramInput {
  name: string;
  viewType?: ViewType;
  scopeId?: string | null;
  description?: string;
  direction?: "TB" | "LR";
}

export function createDiagram(ws: Workspace, input: DiagramInput): { ws: Workspace; diagram: Diagram } {
  const stamp = nowIso();
  const diagram: Diagram = {
    id: newId("dia"),
    name: input.name.trim() || "Untitled diagram",
    description: input.description?.trim() ?? "",
    viewType: input.viewType ?? "custom",
    scopeId: input.scopeId && ws.objects[input.scopeId] ? input.scopeId : null,
    direction: input.direction ?? "TB",
    nodes: {},
    hiddenRelationshipIds: [],
    edgeKinds: null,
    colorBy: "type",
    createdAt: stamp,
    updatedAt: stamp,
  };
  return { ws: touch({ ...ws, diagrams: { ...ws.diagrams, [diagram.id]: diagram } }), diagram };
}

export type DiagramPatch = Partial<Omit<Diagram, "id" | "createdAt" | "updatedAt" | "nodes">>;

function patchDiagram(ws: Workspace, id: string, fn: (d: Diagram) => Diagram): Workspace {
  const current = ws.diagrams[id];
  if (!current) return ws;
  return touch({ ...ws, diagrams: { ...ws.diagrams, [id]: { ...fn(current), updatedAt: nowIso() } } });
}

export function updateDiagram(ws: Workspace, id: string, patch: DiagramPatch): Workspace {
  return patchDiagram(ws, id, (d) => ({
    ...d,
    ...patch,
    name: patch.name !== undefined ? patch.name.trim() || d.name : d.name,
    scopeId: patch.scopeId !== undefined ? (patch.scopeId && ws.objects[patch.scopeId] ? patch.scopeId : null) : d.scopeId,
  }));
}

export function deleteDiagram(ws: Workspace, id: string): Workspace {
  if (!ws.diagrams[id]) return ws;
  const diagrams = { ...ws.diagrams };
  delete diagrams[id];
  return touch({ ...ws, diagrams });
}

export function duplicateDiagram(ws: Workspace, id: string): { ws: Workspace; diagram: Diagram | null } {
  const source = ws.diagrams[id];
  if (!source) return { ws, diagram: null };
  const stamp = nowIso();
  const diagram: Diagram = { ...source, id: newId("dia"), name: `${source.name} (copy)`, createdAt: stamp, updatedAt: stamp };
  return { ws: touch({ ...ws, diagrams: { ...ws.diagrams, [diagram.id]: diagram } }), diagram };
}

/** Adds object references to a diagram or moves the ones already there. Unknown objects are ignored. */
export function placeNodes(ws: Workspace, diagramId: string, placements: Record<string, NodePlacement>): Workspace {
  return patchDiagram(ws, diagramId, (d) => {
    const nodes = { ...d.nodes };
    for (const [objectId, placement] of Object.entries(placements)) {
      if (ws.objects[objectId]) nodes[objectId] = placement;
    }
    return { ...d, nodes };
  });
}

export function removeNodes(ws: Workspace, diagramId: string, objectIds: string[]): Workspace {
  return patchDiagram(ws, diagramId, (d) => {
    const nodes = { ...d.nodes };
    for (const id of objectIds) delete nodes[id];
    return { ...d, nodes };
  });
}

export function setRelationshipHidden(ws: Workspace, diagramId: string, relationshipId: string, hidden: boolean): Workspace {
  return patchDiagram(ws, diagramId, (d) => {
    const set = new Set(d.hiddenRelationshipIds);
    if (hidden) set.add(relationshipId);
    else set.delete(relationshipId);
    return { ...d, hiddenRelationshipIds: [...set] };
  });
}

export function diagramsUsing(ws: Workspace, objectId: string): Diagram[] {
  return Object.values(ws.diagrams)
    .filter((d) => objectId in d.nodes || d.scopeId === objectId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- lookups ---------- */

export function allTags(ws: Workspace): string[] {
  const set = new Set<string>();
  for (const o of Object.values(ws.objects)) for (const t of o.tags) set.add(t);
  return [...set].sort();
}

export function allOwners(ws: Workspace): string[] {
  const set = new Set<string>();
  for (const o of Object.values(ws.objects)) if (o.owner.trim()) set.add(o.owner.trim());
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function sortedObjects(ws: Workspace): ModelObject[] {
  return Object.values(ws.objects).sort((a, b) => a.name.localeCompare(b.name));
}

export function sortedDiagrams(ws: Workspace): Diagram[] {
  return Object.values(ws.diagrams).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
