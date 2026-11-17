import { DATA_FIELDS, dataLens } from "./checks/checks";
import { nodeKey, splitNodeKey, type Tables } from "./cloud/tables";
import type { ModelObject, Relationship, Workspace } from "./types";

/**
 * The public trust page: what it says, and what leaves the workspace to say it.
 *
 * redactForTrust() is the whole of what the page is given. The hosted database does the same
 * cut in trust_view() (see the phase 4 trust page migration); a test holds the two together.
 */

/** A field on an outside system, written for the public: what that party does for you. */
export const PUBLIC_PURPOSE_FIELD = "Public purpose";

export interface TrustPage {
  token: string;
  enabled: boolean;
  title: string;
  intro: string;
  contact: string;
  diagramId: string | null;
}
export type TrustPageInput = Omit<TrustPage, "token">;

const isExternal = (o: ModelObject) => o.typeId === "external-system";
const holdsPersonal = (o: ModelObject) => dataLens(o).personal === "yes";

/** A flow's steps are written for the team; the public page shows the picture without them. */
function withoutFlows<T extends { flows?: unknown }>(diagram: T): T {
  const { flows: _flows, ...rest } = diagram;
  return rest as T;
}

/** The model cut down to what the public page may show. Proposals and decisions never leave. */
export function redactForTrust(tables: Tables, diagramId: string | null): Tables {
  const diagram = diagramId ? tables.diagrams[diagramId] : undefined;
  const every = tables.objects;

  // The diagram's boxes are shown by name; what sits inside them comes as a bare outline, so arrows roll up as they do in the app.
  const visible = new Set<string>();
  const drawn = new Set<string>();
  if (diagram) {
    for (const key of Object.keys(tables.nodes)) {
      const [d, objectId] = splitNodeKey(key);
      if (d === diagram.id && every[objectId]) visible.add(objectId);
    }
    if (diagram.scopeId && every[diagram.scopeId]) visible.add(diagram.scopeId);
    const children = new Map<string, string[]>();
    for (const o of Object.values(every)) if (o.parentId) children.set(o.parentId, [...(children.get(o.parentId) ?? []), o.id]);
    const queue = [...visible];
    while (queue.length) {
      const id = queue.pop()!;
      if (drawn.has(id)) continue;
      drawn.add(id);
      queue.push(...(children.get(id) ?? []));
    }
  }

  const near = new Set<string>();
  for (const r of Object.values(tables.relationships)) {
    const a = every[r.sourceId];
    const b = every[r.targetId];
    if (!a || !b || a.id === b.id) continue;
    if (holdsPersonal(b) && (isExternal(a) || dataLens(a).residency)) near.add(a.id);
    if (holdsPersonal(a) && (isExternal(b) || dataLens(b).residency)) near.add(b.id);
  }

  const wanted = (o: ModelObject) => drawn.has(o.id) || holdsPersonal(o) || near.has(o.id);
  const objects: Record<string, ModelObject> = {};
  for (const o of Object.values(every)) {
    if (!wanted(o)) continue;
    const named = visible.has(o.id) || (isExternal(o) && near.has(o.id));
    const fields: Record<string, string> = {};
    if (holdsPersonal(o)) fields[DATA_FIELDS.personal] = "Yes";
    if (dataLens(o).residency) fields[DATA_FIELDS.residency] = dataLens(o).residency;
    const purpose = (o.fields[PUBLIC_PURPOSE_FIELD] ?? "").trim();
    if (isExternal(o) && near.has(o.id) && purpose) fields[PUBLIC_PURPOSE_FIELD] = purpose;
    objects[o.id] = {
      id: o.id,
      typeId: o.typeId,
      name: named ? o.name : "",
      description: "",
      owner: "",
      lifecycle: visible.has(o.id) ? o.lifecycle : "active",
      tags: [],
      parentId: o.parentId && every[o.parentId] && wanted(every[o.parentId]) ? o.parentId : null,
      technology: "",
      fields,
      provenance: { origin: "manual" },
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    };
  }

  const relationships: Record<string, Relationship> = {};
  for (const r of Object.values(tables.relationships)) {
    const a = every[r.sourceId];
    const b = every[r.targetId];
    if (!a || !b || !objects[a.id] || !objects[b.id]) continue;
    if (!((drawn.has(a.id) && drawn.has(b.id)) || holdsPersonal(a) || holdsPersonal(b))) continue;
    relationships[r.id] = {
      id: r.id,
      sourceId: r.sourceId,
      targetId: r.targetId,
      kind: r.kind,
      label: visible.has(a.id) && visible.has(b.id) ? r.label : "",
      protocol: "",
      port: "",
      description: "",
      provenance: { origin: "manual" },
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  const nodes: Tables["nodes"] = {};
  if (diagram) for (const id of visible) if (tables.nodes[nodeKey(diagram.id, id)]) nodes[nodeKey(diagram.id, id)] = tables.nodes[nodeKey(diagram.id, id)];
  return { objects, relationships, diagrams: diagram ? { [diagram.id]: withoutFlows({ ...diagram, description: "" }) } : {}, nodes, proposals: {}, adrs: {}, rules: {}, templates: {}, wizards: {}, reports: {}, branding: {} };
}

export interface TrustFacts {
  /** Outside parties connected to something that holds personal data. */
  processors: { id: string; name: string; purpose: string; region: string; systems: number }[];
  /** Where personal data is kept, by region, counting the systems that hold it. */
  regions: { region: string; systems: number }[];
  /** Systems that hold personal data without saying where. */
  unstated: number;
  /** Pairs of regions that personal data moves between. */
  transfers: { regions: [string, string]; connections: number }[];
}

/** What the page says, worked out from the model (or from the cut-down copy the public page receives). */
export function trustFacts(ws: Pick<Workspace, "objects" | "relationships">): TrustFacts {
  const processors = new Map<string, Set<string>>();
  const transfers = new Map<string, { regions: [string, string]; connections: number }>();
  for (const r of Object.values(ws.relationships)) {
    const a = ws.objects[r.sourceId];
    const b = ws.objects[r.targetId];
    if (!a || !b || a.id === b.id) continue;
    for (const [outside, holder] of [[a, b], [b, a]] as const) {
      if (isExternal(outside) && holdsPersonal(holder)) processors.set(outside.id, (processors.get(outside.id) ?? new Set()).add(holder.id));
    }
    const ra = dataLens(a).residency;
    const rb = dataLens(b).residency;
    if ((holdsPersonal(a) || holdsPersonal(b)) && ra && rb && ra.toLowerCase() !== rb.toLowerCase()) {
      const regions = [ra, rb].sort((x, y) => x.localeCompare(y)) as [string, string];
      const key = regions.join("\u0000").toLowerCase();
      const entry = transfers.get(key) ?? { regions, connections: 0 };
      entry.connections += 1;
      transfers.set(key, entry);
    }
  }
  const regions = new Map<string, { region: string; systems: number }>();
  let unstated = 0;
  for (const o of Object.values(ws.objects)) {
    if (!holdsPersonal(o) || isExternal(o)) continue;
    const region = dataLens(o).residency;
    if (!region) unstated += 1;
    else {
      const entry = regions.get(region.toLowerCase()) ?? { region, systems: 0 };
      entry.systems += 1;
      regions.set(region.toLowerCase(), entry);
    }
  }
  return {
    processors: [...processors]
      .map(([id, holders]) => ({ id, name: ws.objects[id].name, purpose: (ws.objects[id].fields[PUBLIC_PURPOSE_FIELD] ?? "").trim(), region: dataLens(ws.objects[id]).residency, systems: holders.size }))
      .sort((x, y) => x.name.localeCompare(y.name)),
    regions: [...regions.values()].sort((x, y) => y.systems - x.systems || x.region.localeCompare(y.region)),
    unstated,
    transfers: [...transfers.values()].sort((x, y) => y.connections - x.connections || x.regions.join().localeCompare(y.regions.join())),
  };
}
