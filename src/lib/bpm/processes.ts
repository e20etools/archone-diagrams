import { createObject, createRelationship, newId, updateObject } from "../model";
import type { DecisionTable, ProcessModel, Workspace } from "../types";
import { activitiesInOrder, blankBpmn, laneName, parseBpmn, type BpmnGraph } from "./bpmn";

/**
 * The process repository: a landscape of process areas, groups, processes and sub-processes,
 * each with an owner, a status that goes from draft through review to published (keeping its
 * published versions), and the links to the model: the object that stands for the process, and
 * the systems, data and people each step uses.
 */

const nowIso = () => new Date().toISOString();
const touch = (ws: Workspace): Workspace => ({ ...ws, updatedAt: nowIso() });

export const LEVEL_LABEL = ["Process area", "Process group", "Process", "Sub-process", "Activity"] as const;
export const CATEGORY_LABEL = { management: "Management processes", core: "Core processes", support: "Support processes" } as const;
export const STATUS_LABEL = { draft: "Draft", review: "In review", published: "Published", retired: "Retired" } as const;

export interface ProcessInput {
  name: string;
  description?: string;
  level?: number;
  parentId?: string | null;
  category?: ProcessModel["category"];
  owner?: string;
  xml?: string;
  elements?: ProcessModel["elements"];
  decisions?: Record<string, DecisionTable>;
  tags?: string[];
  diagramIds?: string[];
}

export function createProcess(ws: Workspace, input: ProcessInput): { ws: Workspace; process: ProcessModel } {
  const stamp = nowIso();
  const parent = input.parentId ? ws.processes[input.parentId] : undefined;
  const level = Math.min(4, Math.max(0, input.level ?? (parent ? parent.level + 1 : 2)));
  const process: ProcessModel = {
    id: newId("proc"),
    name: input.name.trim() || "New process",
    description: input.description?.trim() ?? "",
    level,
    parentId: parent ? parent.id : null,
    category: input.category ?? parent?.category ?? "core",
    owner: input.owner?.trim() ?? "",
    status: "draft",
    version: 0,
    objectId: null,
    diagramIds: input.diagramIds ?? [],
    tags: input.tags ?? [],
    frequency: "",
    // Areas and groups are boxes in the landscape; processes and below have a model.
    xml: input.xml ?? (level >= 2 ? blankBpmn(input.name.trim() || "New process") : ""),
    elements: input.elements ?? {},
    kpis: [],
    risks: [],
    decisions: input.decisions ?? {},
    scenarios: [],
    versions: [],
    reviewer: "",
    reviewNote: "",
    createdAt: stamp,
    updatedAt: stamp,
  };
  return { ws: touch({ ...ws, processes: { ...ws.processes, [process.id]: process } }), process };
}

export type ProcessPatch = Partial<Omit<ProcessModel, "id" | "createdAt">>;

export function updateProcess(ws: Workspace, id: string, patch: ProcessPatch): Workspace {
  const current = ws.processes[id];
  if (!current) return ws;
  // A parent cannot be the process itself or one inside it.
  if (patch.parentId && (patch.parentId === id || descendantsOf(ws, id).includes(patch.parentId))) patch = { ...patch, parentId: current.parentId };
  return touch({ ...ws, processes: { ...ws.processes, [id]: { ...current, ...patch, updatedAt: nowIso() } } });
}

/** Removes a process; what sat inside it moves up to its parent. */
/* ---------- links between processes and architecture diagrams ---------- */

/** The diagrams a process is linked to: none for a process saved before links existed. */
export const linksOf = (process: Pick<ProcessModel, "diagramIds">): string[] => (Array.isArray(process.diagramIds) ? process.diagramIds : []);

/** The diagrams a process is linked to that still exist, by name. */
export const diagramsOfProcess = (ws: Workspace, process: ProcessModel) =>
  linksOf(process)
    .map((id) => ws.diagrams[id])
    .filter((d): d is NonNullable<typeof d> => !!d)
    .sort((a, b) => a.name.localeCompare(b.name));

/** The processes linked to a diagram, by name. */
export const processesOfDiagram = (ws: Workspace, diagramId: string) =>
  Object.values(ws.processes)
    .filter((p) => linksOf(p).includes(diagramId))
    .sort((a, b) => a.name.localeCompare(b.name));

/** Links a process and a diagram, or takes the link away. */
export function linkProcessDiagram(ws: Workspace, processId: string, diagramId: string, linked: boolean): Workspace {
  const p = ws.processes[processId];
  if (!p || (linked && !ws.diagrams[diagramId])) return ws;
  const has = linksOf(p).includes(diagramId);
  if (has === linked) return ws;
  return updateProcess(ws, processId, { diagramIds: linked ? [...linksOf(p), diagramId] : linksOf(p).filter((id) => id !== diagramId) });
}

export function deleteProcess(ws: Workspace, id: string): Workspace {
  const p = ws.processes[id];
  if (!p) return ws;
  const processes = { ...ws.processes };
  delete processes[id];
  for (const child of Object.values(processes)) if (child.parentId === id) processes[child.id] = { ...child, parentId: p.parentId, updatedAt: nowIso() };
  return touch({ ...ws, processes });
}

export const childProcesses = (ws: Workspace, id: string | null) =>
  Object.values(ws.processes)
    .filter((p) => p.parentId === id)
    .sort((a, b) => a.name.localeCompare(b.name));

export function descendantsOf(ws: Workspace, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of Object.values(ws.processes)) if (c.parentId === cur && !out.includes(c.id)) (out.push(c.id), stack.push(c.id));
  }
  return out;
}

export function pathOf(ws: Workspace, id: string): ProcessModel[] {
  const out: ProcessModel[] = [];
  let cur: ProcessModel | undefined = ws.processes[id];
  for (let i = 0; cur && i < 10; i++) {
    out.unshift(cur);
    cur = cur.parentId ? ws.processes[cur.parentId] : undefined;
  }
  return out;
}

/** A process's BPMN as a graph, or null when it has no model or the file cannot be read. */
export function graphOf(process: ProcessModel): BpmnGraph | null {
  if (!process.xml) return null;
  try {
    return parseBpmn(process.xml);
  } catch {
    return null;
  }
}

/* ---------- Governance ---------- */

export function sendForReview(ws: Workspace, id: string, reviewer: string, note: string): Workspace {
  return updateProcess(ws, id, { status: "review", reviewer: reviewer.trim(), reviewNote: note.trim() });
}

/** Publishes the process as its next version, keeping the ten latest versions to compare and go back to. */
export function publishProcess(ws: Workspace, id: string, by: string, note: string): Workspace {
  const p = ws.processes[id];
  if (!p) return ws;
  const version = p.version + 1;
  const versions = [{ version, publishedAt: nowIso(), publishedBy: by, note: note.trim(), xml: p.xml }, ...p.versions].slice(0, 10);
  return updateProcess(ws, id, { status: "published", version, versions, reviewNote: note.trim() || p.reviewNote });
}

export function backToDraft(ws: Workspace, id: string, note = ""): Workspace {
  return updateProcess(ws, id, { status: "draft", ...(note ? { reviewNote: note.trim() } : {}) });
}

export function restoreVersion(ws: Workspace, id: string, version: number): Workspace {
  const p = ws.processes[id];
  const v = p?.versions.find((x) => x.version === version);
  return p && v ? updateProcess(ws, id, { xml: v.xml, status: "draft", reviewNote: `Started again from version ${version}.` }) : ws;
}

/** What changed between two versions of a model, by step name. */
export function compareModels(before: string, after: string): { added: string[]; removed: string[]; renamed: number } {
  const names = (xml: string) => {
    try {
      const g = parseBpmn(xml);
      return new Map(Object.values(g.nodes).filter((n) => n.kind === "activity" || n.kind === "gateway" || n.kind === "event").map((n) => [n.id, n.name || n.type]));
    } catch {
      return new Map<string, string>();
    }
  };
  const a = names(before);
  const b = names(after);
  const added = [...b.entries()].filter(([id]) => !a.has(id)).map(([, n]) => n);
  const removed = [...a.entries()].filter(([id]) => !b.has(id)).map(([, n]) => n);
  const renamed = [...b.entries()].filter(([id, n]) => a.has(id) && a.get(id) !== n).length;
  return { added, removed, renamed };
}

/* ---------- Links to the model ---------- */

/**
 * The model object that stands for the process, made when first asked for, so the process can
 * be drawn on architecture diagrams, owned, reported on, and linked to the systems it uses.
 */
export function ensureProcessObject(ws: Workspace, id: string): { ws: Workspace; objectId: string | null } {
  const p = ws.processes[id];
  if (!p) return { ws, objectId: null };
  if (p.objectId && ws.objects[p.objectId]) {
    const o = ws.objects[p.objectId];
    const synced = o.name !== p.name || o.owner !== p.owner ? updateObject(ws, o.id, { name: p.name, owner: p.owner }) : ws;
    return { ws: synced, objectId: o.id };
  }
  const made = createObject(ws, { typeId: "process", name: p.name, description: p.description, owner: p.owner, tags: ["bpm"], fields: { "process level": String(p.level) } });
  return { ws: updateProcess(made.ws, id, { objectId: made.object.id }), objectId: made.object.id };
}

const SYSTEM_TYPES = new Set(["application", "system", "service", "api", "database", "storage", "queue", "cache", "function", "saas", "component", "container"]);

/**
 * Makes the model say what the steps say: the process object depends on each system its steps
 * use, and reads or writes the data stores they touch.
 */
export function syncProcessLinks(ws: Workspace, id: string): { ws: Workspace; added: number } {
  const ensured = ensureProcessObject(ws, id);
  let next = ensured.ws;
  const p = next.processes[id];
  if (!p || !ensured.objectId) return { ws: next, added: 0 };
  let added = 0;
  const used = new Set(Object.values(p.elements).flatMap((e) => e.objectIds));
  for (const objectId of used) {
    const o = next.objects[objectId];
    if (!o || o.id === ensured.objectId || !SYSTEM_TYPES.has(o.typeId)) continue;
    const kind = ["database", "storage", "queue", "cache"].includes(o.typeId) ? "reads_writes" : "depends_on";
    const made = createRelationship(next, { sourceId: ensured.objectId, targetId: o.id, kind, label: "used by its steps" });
    next = made.ws;
    if (made.created) added++;
  }
  return { ws: next, added };
}

export const isSystem = (ws: Workspace, objectId: string) => SYSTEM_TYPES.has(ws.objects[objectId]?.typeId ?? "");

/** Every process and the systems its steps use: the process–application matrix. */
export function systemsMatrix(ws: Workspace): { processes: ProcessModel[]; systems: { id: string; name: string }[]; cells: Record<string, Record<string, string[]>> } {
  const cells: Record<string, Record<string, string[]>> = {};
  const systems = new Map<string, string>();
  for (const p of Object.values(ws.processes)) {
    const graph = graphOf(p);
    for (const [elementId, info] of Object.entries(p.elements)) {
      for (const objectId of info.objectIds) {
        if (!isSystem(ws, objectId)) continue;
        systems.set(objectId, ws.objects[objectId].name);
        const step = graph?.nodes[elementId]?.name || elementId;
        ((cells[p.id] ??= {})[objectId] ??= []).push(step);
      }
    }
  }
  return {
    processes: Object.values(ws.processes).filter((p) => cells[p.id]).sort((a, b) => a.name.localeCompare(b.name)),
    systems: [...systems.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    cells,
  };
}

/** Who does what in each step: roles across, steps down. The lane counts as Responsible unless set otherwise. */
export function raciMatrix(process: ProcessModel): { roles: string[]; rows: { id: string; name: string; cells: Record<string, string> }[] } {
  const graph = graphOf(process);
  if (!graph) return { roles: [], rows: [] };
  const rows = activitiesInOrder(graph).map((n) => {
    const set = { ...(process.elements[n.id]?.raci ?? {}) };
    const lane = laneName(graph, n.id);
    if (lane && !Object.keys(set).length) set[lane] = "R";
    return { id: n.id, name: n.name || n.type, cells: set as Record<string, string> };
  });
  const roles = [...new Set(rows.flatMap((r) => Object.keys(r.cells)))].sort();
  return { roles, rows };
}

/** The processes a model object takes part in, and in which steps: for impact on a system. */
export function processesUsing(ws: Workspace, objectId: string): { process: ProcessModel; steps: string[] }[] {
  return Object.values(ws.processes)
    .map((p) => {
      const graph = graphOf(p);
      const steps = Object.entries(p.elements)
        .filter(([, e]) => e.objectIds.includes(objectId))
        .map(([id]) => graph?.nodes[id]?.name || id);
      return { process: p, steps };
    })
    .filter((x) => x.steps.length || x.process.objectId === objectId);
}

const STEP_ELEMENT = /<(?:[\w-]+:)?(?:task|userTask|serviceTask|manualTask|scriptTask|businessRuleTask|sendTask|receiveTask|subProcess|callActivity|transaction)[\s>/]/g;
/** The number of steps in a BPMN file, without reading it all. */
export const stepCount = (xml: string) => (xml ? (xml.match(STEP_ELEMENT)?.length ?? 0) : 0);

/** A quick read of the repository for the landscape page. */
export function repositoryStats(ws: Workspace) {
  const all = Object.values(ws.processes);
  return {
    total: all.length,
    modelled: all.filter((p) => p.xml).length,
    published: all.filter((p) => p.status === "published").length,
    inReview: all.filter((p) => p.status === "review").length,
    withoutOwner: all.filter((p) => !p.owner && p.level >= 2).length,
  };
}
