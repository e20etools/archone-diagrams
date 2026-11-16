import { createDiagram, createObject, createRelationship, findByName } from "./model";
import type { RelationKind, Workspace } from "./types";
import { addObjectsToDiagram } from "./views";

/**
 * Starting points: a small, typical architecture put into the model with one diagram of it.
 * A template is a first draft to rename and reshape, not a reference architecture. Objects
 * whose names the model already has are reused, so applying a template twice adds nothing.
 */

interface TemplateObject {
  key: string;
  name: string;
  typeId: string;
  inside?: string;
  technology?: string;
  description?: string;
}
export interface Template {
  id: string;
  name: string;
  about: string;
  objects: TemplateObject[];
  relationships: [from: string, to: string, kind: RelationKind, label?: string, protocol?: string][];
}

export const TEMPLATES: Template[] = [
  {
    id: "three-tier",
    name: "Three-tier web application",
    about: "A browser front end, an API behind a gateway, and a database, with sign-in from an identity provider.",
    objects: [
      { key: "user", name: "Customer", typeId: "actor" },
      { key: "sys", name: "Web application", typeId: "system", description: "Rename this to your product." },
      { key: "web", name: "Web front end", typeId: "web-app", inside: "sys" },
      { key: "gw", name: "API gateway", typeId: "gateway", inside: "sys" },
      { key: "api", name: "Application API", typeId: "service", inside: "sys" },
      { key: "db", name: "Application database", typeId: "database", inside: "sys" },
      { key: "idp", name: "Identity provider", typeId: "external-system" },
    ],
    relationships: [["user", "web", "calls", "uses", "HTTPS"], ["web", "gw", "calls", "", "HTTPS"], ["gw", "api", "routes_to", "", "HTTPS"], ["api", "db", "reads_writes", "", "TLS"], ["web", "idp", "calls", "signs in with", "OIDC"]],
  },
  {
    id: "event-driven",
    name: "Event-driven services",
    about: "Services that publish and consume events on one bus, each with its own store.",
    objects: [
      { key: "sys", name: "Order platform", typeId: "system" },
      { key: "orders", name: "Order service", typeId: "service", inside: "sys" },
      { key: "ordersdb", name: "Orders database", typeId: "database", inside: "sys" },
      { key: "bus", name: "Event bus", typeId: "queue", inside: "sys" },
      { key: "billing", name: "Billing service", typeId: "service", inside: "sys" },
      { key: "billingdb", name: "Billing database", typeId: "database", inside: "sys" },
      { key: "notify", name: "Notification service", typeId: "service", inside: "sys" },
      { key: "mail", name: "Email provider", typeId: "external-system" },
    ],
    relationships: [["orders", "ordersdb", "reads_writes", "", "TLS"], ["orders", "bus", "flows_to", "publishes order events"], ["bus", "billing", "flows_to", "order events"], ["bus", "notify", "flows_to", "order events"], ["billing", "billingdb", "reads_writes", "", "TLS"], ["notify", "mail", "calls", "sends email", "HTTPS"]],
  },
  {
    id: "data-platform",
    name: "Data platform",
    about: "Source systems feed a warehouse through ingestion, and reports read from it.",
    objects: [
      { key: "src", name: "Operational database", typeId: "database", description: "A source system. Add one per source." },
      { key: "sys", name: "Data platform", typeId: "system" },
      { key: "ingest", name: "Ingestion pipeline", typeId: "service", inside: "sys" },
      { key: "lake", name: "Raw data store", typeId: "storage", inside: "sys" },
      { key: "dwh", name: "Data warehouse", typeId: "database", inside: "sys" },
      { key: "bi", name: "Reporting", typeId: "application", inside: "sys" },
      { key: "analyst", name: "Analyst", typeId: "actor" },
    ],
    relationships: [["ingest", "src", "reads_writes", "reads"], ["ingest", "lake", "flows_to", "lands raw files"], ["lake", "dwh", "flows_to", "loads"], ["bi", "dwh", "reads_writes", "queries", "TLS"], ["analyst", "bi", "calls", "uses", "HTTPS"]],
  },
  {
    id: "ai-agent",
    name: "AI agent with tools",
    about: "An agent that calls a model and reaches company data through an MCP server. Fill in what it reads and where it can send.",
    objects: [
      { key: "user", name: "Employee", typeId: "actor" },
      { key: "sys", name: "Assistant", typeId: "system" },
      { key: "chat", name: "Chat front end", typeId: "web-app", inside: "sys" },
      { key: "agent", name: "Assistant agent", typeId: "ai-agent", inside: "sys" },
      { key: "mcp", name: "Company data MCP server", typeId: "mcp-server", inside: "sys" },
      { key: "kb", name: "Knowledge base", typeId: "database", inside: "sys" },
      { key: "model", name: "Language model", typeId: "ai-model" },
    ],
    relationships: [["user", "chat", "calls", "asks", "HTTPS"], ["chat", "agent", "calls", "", "HTTPS"], ["agent", "model", "calls", "prompts", "HTTPS"], ["agent", "mcp", "calls", "uses tools", "HTTPS"], ["mcp", "kb", "reads_writes", "reads", "TLS"]],
  },
  {
    id: "cloud-landing",
    name: "Cloud workload behind a load balancer",
    about: "A container workload in one cloud region: load balancer, cluster, managed database, object storage and a cache.",
    objects: [
      { key: "user", name: "User", typeId: "actor" },
      { key: "sys", name: "Cloud workload", typeId: "system" },
      { key: "lb", name: "Load balancer", typeId: "gateway", inside: "sys" },
      { key: "cluster", name: "Container cluster", typeId: "cluster", inside: "sys", technology: "Kubernetes" },
      { key: "app", name: "Workload service", typeId: "service", inside: "sys" },
      { key: "db", name: "Managed database", typeId: "database", inside: "sys" },
      { key: "cache", name: "Cache", typeId: "cache", inside: "sys" },
      { key: "files", name: "Object storage", typeId: "storage", inside: "sys" },
    ],
    relationships: [["user", "lb", "calls", "", "HTTPS"], ["lb", "app", "routes_to", "", "HTTPS"], ["app", "cluster", "hosted_on"], ["app", "db", "reads_writes", "", "TLS"], ["app", "cache", "reads_writes", "", "TLS"], ["app", "files", "reads_writes", "", "HTTPS"]],
  },
];

export interface TemplateResult {
  ws: Workspace;
  diagramId: string;
  added: number;
  reused: number;
}

/** Puts a template into the model and draws one diagram of it. */
export function applyTemplate(ws: Workspace, templateId: string): TemplateResult | null {
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (!template) return null;
  let next = ws;
  const ids: Record<string, string> = {};
  let added = 0;
  let reused = 0;
  for (const o of template.objects) {
    const existing = findByName(next, o.name);
    if (existing) {
      ids[o.key] = existing.id;
      reused += 1;
      continue;
    }
    const made = createObject(next, { name: o.name, typeId: o.typeId, parentId: o.inside ? (ids[o.inside] ?? null) : null, technology: o.technology ?? "", description: o.description ?? "" });
    next = made.ws;
    ids[o.key] = made.object.id;
    added += 1;
  }
  for (const [from, to, kind, label = "", protocol = ""] of template.relationships) {
    const sourceId = ids[from];
    const targetId = ids[to];
    if (!sourceId || !targetId || Object.values(next.relationships).some((r) => r.sourceId === sourceId && r.targetId === targetId)) continue;
    next = createRelationship(next, { sourceId, targetId, kind, label, protocol }).ws;
  }
  const taken = new Set(Object.values(next.diagrams).map((d) => d.name));
  let name = template.name;
  for (let n = 2; taken.has(name); n++) name = `${template.name} ${n}`;
  const created = createDiagram(next, { name, viewType: "custom", description: template.about });
  // The system box is left off: its parts are drawn, and the diagram reads better without a box around nothing.
  const shown = template.objects.filter((o) => o.typeId !== "system").map((o) => ids[o.key]);
  next = addObjectsToDiagram(created.ws, created.diagram.id, shown);
  return { ws: next, diagramId: created.diagram.id, added, reused };
}
