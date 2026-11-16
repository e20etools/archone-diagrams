import type { Adr, CustomRule, ModelObject, NodePlacement, Notation, Proposal, Relationship } from "../types";
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
};

export type Row = Record<string, unknown>;

/** The database returns timestamps in its own spelling; the app keeps one ISO form so values compare equal. */
const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

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
};

/** Timestamps are normalised on the way in, so an object that went to the database and back compares equal. */
export function normalizeForCloud<T extends { createdAt: string; updatedAt?: string }>(value: T): T {
  const createdAt = iso(value.createdAt);
  const updatedAt = value.updatedAt === undefined ? undefined : iso(value.updatedAt);
  if (createdAt === value.createdAt && updatedAt === value.updatedAt) return value;
  return { ...value, createdAt, ...(updatedAt === undefined ? {} : { updatedAt }) };
}
