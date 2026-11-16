import { RELATION_KIND_INFO, objectType } from "./catalog";
import { diagramObjects, diagramRelationships } from "./exporters";
import type { Diagram, ModelObject, Relationship, Workspace } from "./types";

/**
 * The model, or one diagram of it, in FINOS CALM (Common Architecture Language Model): a
 * JSON form that architecture-as-code tools read, among them the ones that check a pull
 * request against the approved architecture. Written against release 1.2 of the schema.
 */

export const CALM_SCHEMA = "https://calm.finos.org/release/1.2/meta/calm.json";

/** CALM names nine kinds of node and accepts others; the nearest of the nine is used. */
const NODE_TYPE: Record<string, string> = {
  domain: "ecosystem",
  actor: "actor",
  system: "system",
  "external-system": "system",
  application: "service",
  "web-app": "webclient",
  "mobile-app": "webclient",
  service: "service",
  database: "database",
  cache: "database",
  queue: "service",
  storage: "data-asset",
  gateway: "network",
  network: "network",
  server: "system",
  cluster: "system",
  component: "service",
};
const PROTOCOLS = ["HTTP", "HTTPS", "FTP", "SFTP", "JDBC", "WebSocket", "SocketIO", "LDAP", "AMQP", "TLS", "mTLS", "TCP"];
const protocolOf = (value: string) => PROTOCOLS.find((p) => p.toLowerCase() === value.trim().toLowerCase());

interface CalmNode {
  "unique-id": string;
  "node-type": string;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
}
interface CalmRelationship {
  "unique-id": string;
  description?: string;
  "relationship-type": Record<string, unknown>;
  protocol?: string;
}
export interface CalmDocument {
  $schema: string;
  metadata: Record<string, unknown>[];
  nodes: CalmNode[];
  relationships: CalmRelationship[];
}

function node(o: ModelObject): CalmNode {
  const type = objectType(o.typeId);
  return {
    "unique-id": o.id,
    "node-type": NODE_TYPE[o.typeId] ?? "service",
    name: o.name,
    // CALM requires a description; an object without one says what kind of thing it is.
    description: o.description.trim() || type.label,
    metadata: {
      "archone-type": o.typeId,
      ...(o.typeId === "external-system" ? { external: true } : {}),
      ...(o.owner ? { owner: o.owner } : {}),
      lifecycle: o.lifecycle,
      ...(o.technology ? { technology: o.technology } : {}),
      ...(o.tags.length ? { tags: o.tags } : {}),
      ...(Object.keys(o.fields).length ? { fields: o.fields } : {}),
    },
  };
}

export function toCalm(ws: Workspace, diagram: Diagram | null, exportedAt = new Date().toISOString()): CalmDocument {
  const objects = diagram ? diagramObjects(ws, diagram) : Object.values(ws.objects).sort((a, b) => a.name.localeCompare(b.name));
  const relationships = (diagram ? diagramRelationships(ws, diagram) : Object.values(ws.relationships)).sort((a, b) => a.id.localeCompare(b.id));
  const shown = new Set(objects.map((o) => o.id));
  const out: CalmRelationship[] = [];

  // What sits inside what.
  const inside = new Map<string, string[]>();
  for (const o of objects) if (o.parentId && shown.has(o.parentId)) inside.set(o.parentId, [...(inside.get(o.parentId) ?? []), o.id]);
  for (const [container, nodes] of [...inside].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ "unique-id": `${container}-composed-of`, description: `What ${ws.objects[container].name} is made of.`, "relationship-type": { "composed-of": { container, nodes: nodes.sort() } } });
  }
  // What runs on what, one relationship per host.
  const hosted = new Map<string, Relationship[]>();
  for (const r of relationships) if (r.kind === "hosted_on" && shown.has(r.sourceId) && shown.has(r.targetId)) hosted.set(r.targetId, [...(hosted.get(r.targetId) ?? []), r]);
  for (const [container, list] of [...hosted].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ "unique-id": `${container}-deployed-in`, description: `What runs on ${ws.objects[container].name}.`, "relationship-type": { "deployed-in": { container, nodes: [...new Set(list.map((r) => r.sourceId))].sort() } } });
  }
  for (const r of relationships) {
    if (r.kind === "hosted_on" || !shown.has(r.sourceId) || !shown.has(r.targetId)) continue;
    const description = r.description.trim() || r.label.trim() || `${ws.objects[r.sourceId].name} ${RELATION_KIND_INFO[r.kind].verb} ${ws.objects[r.targetId].name}`;
    const protocol = protocolOf(r.protocol);
    out.push({
      "unique-id": r.id,
      description,
      // A person using something is an interaction; everything else is a connection with a direction.
      "relationship-type": ws.objects[r.sourceId].typeId === "actor" ? { interacts: { actor: r.sourceId, nodes: [r.targetId] } } : { connects: { source: { node: r.sourceId }, destination: { node: r.targetId } } },
      ...(protocol ? { protocol } : {}),
    });
  }
  return {
    $schema: CALM_SCHEMA,
    metadata: [{ "exported-from": "ArchONE Diagrams", "exported-at": exportedAt, workspace: ws.name, ...(diagram ? { diagram: diagram.name } : {}) }],
    nodes: objects.map(node),
    relationships: out,
  };
}

export const calmJson = (ws: Workspace, diagram: Diagram | null) => `${JSON.stringify(toCalm(ws, diagram), null, 2)}\n`;
