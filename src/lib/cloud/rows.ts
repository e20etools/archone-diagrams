import { repairProcess } from "../bpm/repair";
import type { Adr, AiPolicy, Branding, CustomReport, CustomRule, DiagramArchive, LibraryItem, WizardConfig, SavedTemplate, Flow, ModelLink, ModelObject, NodePlacement, Notation, Proposal, Relationship, ProcessModel } from "../types";
import { nodeKey, splitNodeKey, type DiagramMeta, type TableName } from "./tables";

/** Database rows and the app's objects, converted in both directions. Column names match the migration. */

export const SQL_TABLE: Record<TableName, string> = {
  objects: "objects",
  relationships: "relationships",
  diagrams: "diagrams",
  nodes: "diagram_nodes",
  proposals: "proposals",
  adrs: "decision_records",
  rules: "custom_rules",
  templates: "diagram_templates",
  wizards: "wizard_configs",
  reports: "custom_reports",
  branding: "workspace_branding",
  library: "library_items",
  processes: "process_models",
  aiPolicy: "ai_policies",
};

export type Row = Record<string, unknown>;

/** The database returns timestamps in its own spelling; the app keeps one ISO form so values compare equal. */
const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
/** Read defensively: the column is free-form JSON and an API client or an old row may hold anything. */
const linksOf = (value: unknown): { links?: ModelLink[] } => {
  const links = (Array.isArray(value) ? value : []).map(record).filter((l) => typeof l.url === "string" && l.url).map((l) => ({ label: text(l.label), url: text(l.url) }));
  return links.length ? { links } : {};
};
const flowsOf = (value: unknown): { flows?: Flow[] } => {
  const flows = (Array.isArray(value) ? value : [])
    .map(record)
    .filter((f) => typeof f.id === "string" && f.id)
    .map((f) => ({
      id: text(f.id),
      name: text(f.name),
      description: text(f.description),
      steps: (Array.isArray(f.steps) ? f.steps : [])
        .map(record)
        .filter((s) => typeof s.id === "string" && typeof s.fromId === "string" && typeof s.toId === "string")
        .map((s) => ({ id: text(s.id), fromId: text(s.fromId), toId: text(s.toId), text: text(s.text) })),
    }));
  return flows.length ? { flows } : {};
};

export function toRow(table: TableName, workspaceId: string, key: string, value: unknown): Row {
  switch (table) {
    case "objects": {
      const o = value as ModelObject;
      return {
        workspace_id: workspaceId,
        id: o.id,
        type_id: o.typeId,
        name: o.name,
        description: o.description,
        owner: o.owner,
        lifecycle: o.lifecycle,
        tags: o.tags,
        parent_id: o.parentId,
        technology: o.technology,
        fields: o.fields,
        // Always sent, so that removing the last link clears the column.
        links: o.links?.length ? o.links : null,
        component_id: o.componentId ?? null,
        // Sent only for a box standing for a diagram, so a database without the column still saves the rest.
        ...(o.diagramId ? { diagram_ref: o.diagramId } : {}),
        provenance: o.provenance,
        created_at: o.createdAt,
        updated_at: o.updatedAt,
        deleted: false,
      };
    }
    case "relationships": {
      const r = value as Relationship;
      return {
        workspace_id: workspaceId,
        id: r.id,
        source_id: r.sourceId,
        target_id: r.targetId,
        kind: r.kind,
        label: r.label,
        protocol: r.protocol,
        port: r.port,
        description: r.description,
        // Always sent, so that taking a confirmation back clears it. Needs the column from the phase 4 migration.
        acknowledged: r.acknowledgement ?? null,
        flow: r.flow ?? null,
        protocols: r.protocols?.length ? r.protocols : null,
        network: r.network ?? null,
        encrypted: r.encrypted ?? null,
        links: r.links?.length ? r.links : null,
        provenance: r.provenance,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        deleted: false,
      };
    }
    case "diagrams": {
      const d = value as DiagramMeta;
      return {
        workspace_id: workspaceId,
        id: d.id,
        name: d.name,
        description: d.description,
        view_type: d.viewType,
        scope_id: d.scopeId,
        direction: d.direction,
        hidden_relationship_ids: d.hiddenRelationshipIds,
        edge_kinds: d.edgeKinds,
        color_by: d.colorBy,
        // Sent only once someone has chosen a notation, so a database without the column still saves plain diagrams.
        ...(d.notation ? { notation: d.notation } : {}),
        flows: d.flows?.length ? d.flows : null,
        // Sent only once a diagram has been archived, so a database without the column still saves the rest.
        ...(d.archive ? { archive: d.archive } : {}),
        created_at: d.createdAt,
        updated_at: d.updatedAt,
        deleted: false,
      };
    }
    case "nodes": {
      const n = value as NodePlacement;
      const [diagramId, objectId] = splitNodeKey(key);
      return { workspace_id: workspaceId, diagram_id: diagramId, object_id: objectId, x: n.x, y: n.y, pinned: n.pinned, deleted: false };
    }
    case "proposals": {
      const p = value as Proposal;
      return { workspace_id: workspaceId, id: p.id, status: p.status, data: p, created_at: p.createdAt, deleted: false };
    }
    case "adrs": {
      const a = value as Adr;
      return { workspace_id: workspaceId, id: a.id, status: a.status, data: a, created_at: a.createdAt, deleted: false };
    }
    case "rules": {
      const r = value as CustomRule;
      return { workspace_id: workspaceId, id: r.id, data: r, created_at: r.createdAt, deleted: false };
    }
    case "templates": {
      const t = value as SavedTemplate;
      return { workspace_id: workspaceId, id: t.id, data: t, created_at: t.createdAt, deleted: false };
    }
    case "wizards": {
      const w = value as WizardConfig;
      return { workspace_id: workspaceId, id: w.id, data: w, created_at: w.updatedAt, deleted: false };
    }
    case "reports": {
      const r = value as CustomReport;
      return { workspace_id: workspaceId, id: r.id, data: r, created_at: r.createdAt, deleted: false };
    }
    case "branding": {
      const b = value as Branding;
      return { workspace_id: workspaceId, id: b.id, data: b, deleted: false };
    }
    case "library": {
      const l = value as LibraryItem;
      return { workspace_id: workspaceId, id: l.id, data: l, created_at: l.createdAt, deleted: false };
    }
    case "aiPolicy": {
      const a = value as AiPolicy;
      return { workspace_id: workspaceId, id: a.id, data: a, deleted: false };
    }
    case "processes": {
      const p = value as ProcessModel;
      return { workspace_id: workspaceId, id: p.id, data: p, created_at: p.createdAt, deleted: false };
    }
  }
}

/** Returns the row's key and its value, or null as the value when the row is marked deleted. */
export function fromRow(table: TableName, row: Row): { key: string; value: unknown | null } {
  const key = table === "nodes" ? nodeKey(text(row.diagram_id), text(row.object_id)) : text(row.id);
  if (row.deleted === true) return { key, value: null };
  switch (table) {
    case "objects": {
      const value: ModelObject = {
        id: text(row.id),
        typeId: text(row.type_id),
        name: text(row.name),
        description: text(row.description),
        owner: text(row.owner),
        lifecycle: (["planned", "active", "deprecated", "retired"] as const).find((l) => l === row.lifecycle) ?? "active",
        tags: list(row.tags),
        parentId: typeof row.parent_id === "string" ? row.parent_id : null,
        technology: text(row.technology),
        fields: (row.fields ?? {}) as Record<string, string>,
        ...linksOf(row.links),
        ...(typeof row.component_id === "string" && row.component_id ? { componentId: row.component_id } : {}),
        ...(typeof row.diagram_ref === "string" && row.diagram_ref ? { diagramId: row.diagram_ref } : {}),
        provenance: (row.provenance ?? { origin: "manual" }) as ModelObject["provenance"],
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
      return { key, value };
    }
    case "relationships": {
      const value: Relationship = {
        id: text(row.id),
        sourceId: text(row.source_id),
        targetId: text(row.target_id),
        kind: row.kind as Relationship["kind"],
        label: text(row.label),
        protocol: text(row.protocol),
        port: text(row.port),
        description: text(row.description),
        ...(row.acknowledged && typeof row.acknowledged === "object" ? { acknowledgement: row.acknowledged as NonNullable<Relationship["acknowledgement"]> } : {}),
        ...(row.flow === "out" || row.flow === "in" || row.flow === "both" ? { flow: row.flow } : {}),
        ...(Array.isArray(row.protocols) && row.protocols.length ? { protocols: row.protocols as NonNullable<Relationship["protocols"]> } : {}),
        ...(typeof row.network === "string" && row.network ? { network: row.network } : {}),
        ...(row.encrypted === "yes" || row.encrypted === "no" ? { encrypted: row.encrypted } : {}),
        ...linksOf(row.links),
        provenance: (row.provenance ?? { origin: "manual" }) as Relationship["provenance"],
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
      return { key, value };
    }
    case "diagrams": {
      const value: DiagramMeta = {
        id: text(row.id),
        name: text(row.name),
        description: text(row.description),
        viewType: row.view_type as DiagramMeta["viewType"],
        scopeId: typeof row.scope_id === "string" ? row.scope_id : null,
        direction: row.direction === "LR" ? "LR" : "TB",
        hiddenRelationshipIds: list(row.hidden_relationship_ids),
        edgeKinds: Array.isArray(row.edge_kinds) ? (list(row.edge_kinds) as NonNullable<DiagramMeta["edgeKinds"]>) : null,
        colorBy: (["type", "lifecycle", "owner"] as const).find((c) => c === row.color_by) ?? "type",
        // Plain is the absence of a notation, so a diagram that never had one reads back as it was sent.
        ...((["archimate", "bpmn"] as const).some((n) => n === row.notation) ? { notation: row.notation as Notation } : {}),
        ...flowsOf(row.flows),
        ...(row.archive && typeof row.archive === "object" && Array.isArray((row.archive as DiagramArchive).history) ? { archive: row.archive as DiagramArchive } : {}),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
      return { key, value };
    }
    case "nodes": {
      const value: NodePlacement = { x: Number(row.x) || 0, y: Number(row.y) || 0, pinned: row.pinned === true };
      return { key, value };
    }
    case "proposals":
      return { key, value: row.data as Proposal };
    case "adrs":
      return { key, value: row.data as Adr };
    case "rules":
      return { key, value: row.data as CustomRule };
    case "templates":
      return { key, value: row.data as SavedTemplate };
    case "wizards":
      return { key, value: row.data as WizardConfig };
    case "reports":
      return { key, value: row.data as CustomReport };
    case "branding":
      return { key, value: row.data as Branding };
    case "library":
      return { key, value: row.data as LibraryItem };
    case "aiPolicy":
      return { key, value: row.data as AiPolicy };
    case "processes":
      // Written by the app, the API and older versions: read with care.
      return { key, value: repairProcess(key, row.data) as ProcessModel };
  }
}

/** The columns that identify a row, used for upserts and for marking rows deleted. */
export const KEY_COLUMNS: Record<TableName, string[]> = {
  objects: ["workspace_id", "id"],
  relationships: ["workspace_id", "id"],
  diagrams: ["workspace_id", "id"],
  nodes: ["workspace_id", "diagram_id", "object_id"],
  proposals: ["workspace_id", "id"],
  adrs: ["workspace_id", "id"],
  rules: ["workspace_id", "id"],
  templates: ["workspace_id", "id"],
  wizards: ["workspace_id", "id"],
  reports: ["workspace_id", "id"],
  branding: ["workspace_id", "id"],
  library: ["workspace_id", "id"],
  aiPolicy: ["workspace_id", "id"],
  processes: ["workspace_id", "id"],
};

/** Timestamps are normalised on the way in, so an object that went to the database and back compares equal. */
export function normalizeForCloud<T extends { createdAt: string; updatedAt?: string }>(value: T): T {
  const createdAt = iso(value.createdAt);
  const updatedAt = value.updatedAt === undefined ? undefined : iso(value.updatedAt);
  if (createdAt === value.createdAt && updatedAt === value.updatedAt) return value;
  return { ...value, createdAt, ...(updatedAt === undefined ? {} : { updatedAt }) };
}
