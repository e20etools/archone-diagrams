import { componentById } from "./library";
import { createDiagram, createObject, createRelationship, findByName, newId, nowIso, placeNodes, updateDiagram } from "./model";
import { CATALOG, type Perspective } from "./templateCatalog";
import type { Diagram, RelationKind, SavedTemplate, ViewType, Workspace } from "./types";
import { addObjectsToDiagram, relayout, visibleEdges } from "./views";

export type { Perspective };
export const PERSPECTIVES: { id: Perspective; label: string; hint: string }[] = [
  { id: "applications", label: "Applications", hint: "How software is built and connected" },
  { id: "data", label: "Data", hint: "Where data lives, moves and is used" },
  { id: "infrastructure", label: "Infrastructure", hint: "Networks, servers, cloud, security and sites" },
  { id: "business", label: "Business", hint: "Capabilities, processes, people and change" },
];

/**
 * Starting points: a small, typical architecture put into the model with one diagram of it.
 * A template is a first draft to rename and reshape, not a reference architecture. Objects
 * whose names the model already has are reused, so applying a template twice adds nothing.
 */

export interface TemplateObject {
  key: string;
  name: string;
  typeId: string;
  inside?: string;
  technology?: string;
  description?: string;
  /** The library component it is. Every box of a template is one; its type is the component's. */
  componentId: string;
  /** Where the box stood, for a template made from a diagram. Without it the layout places the box. */
  x?: number;
  y?: number;
}
export interface Template {
  id: string;
  name: string;
  perspective: Perspective;
  about: string;
  direction?: "TB" | "LR";
  notation?: "bpmn" | "archimate";
  tags?: string;
  /** Set for a template the workspace made from one of its diagrams. */
  saved?: { author: string; createdAt: string; updatedAt: string; sourceDiagramId: string };
  objects: TemplateObject[];
  relationships: [from: string, to: string, kind: RelationKind, label?: string, protocol?: string][];
}

/** A template may only use what the library has. A name it does not know stops the app at start-up, and the tests, instead of drawing a box from nowhere. */
function libraryComponent(id: string, where: string) {
  const c = componentById(id);
  if (!c) throw new Error(`Template ${where} uses "${id}", which is not in the component library.`);
  return c;
}

/** "key component-id Name" into an object of the component's type. */
function fromCatalog(templateId: string, line: string): TemplateObject {
  const [key, component, ...name] = line.split(" ");
  const c = libraryComponent(component, templateId);
  return { key, name: name.join(" "), typeId: c.kind, componentId: c.id };
}

type StarterObject = Omit<TemplateObject, "componentId"> & { componentId?: string };
const STARTERS: (Omit<Template, "objects"> & { objects: StarterObject[] })[] = [
  {
    id: "three-tier",
    perspective: "applications",
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
    perspective: "applications",
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
    perspective: "data",
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
    perspective: "applications",
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
    perspective: "infrastructure",
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

/** The first templates were written before the library; each box gets the component its type usually is. */
export const USUAL_COMPONENT: Record<string, string> = {
  system: "applications.software-system",
  domain: "business.business-domain",
  process: "business.business-process",
  task: "business.process-step",
  event: "business.business-event",
  decision: "business.decision-point",
  server: "compute.physical-server",
  network: "network.network-device",
  component: "applications.software-module",
  zone: "zones.internal-lan",
  diagram: "diagrams.diagram",
  actor: "people.user",
  "web-app": "applications.web-application",
  application: "applications.custom-application",
  service: "applications.back-end-service",
  gateway: "platforms.api-gateway",
  database: "data.relational-database",
  queue: "integration.event-bus",
  cache: "data.cache",
  storage: "storage.object-storage",
  cluster: "containers.kubernetes-cluster",
  "external-system": "external.external-system",
  "ai-agent": "ai.ai-agent",
  "ai-model": "ai.large-language-model",
  "mcp-server": "ai.mcp-server",
};

export const TEMPLATES: Template[] = [
  ...STARTERS.map((t) => ({
    ...t,
    objects: t.objects.map((o) => {
      const c = libraryComponent(o.componentId ?? USUAL_COMPONENT[o.typeId] ?? "", t.id);
      return { ...o, typeId: c.kind, componentId: c.id };
    }),
  })),
  ...CATALOG.map((t) => ({ ...t, objects: t.objects.map((line) => fromCatalog(t.id, line)) })),
];

/** A workspace's own template, in the shape every template has. */
export function fromSaved(t: SavedTemplate): Template {
  return {
    id: t.id,
    name: t.name,
    perspective: t.perspective,
    about: t.about,
    tags: t.tags,
    direction: t.direction,
    ...(t.notation ? { notation: t.notation } : {}),
    objects: t.objects.map((o) => ({ key: o.key, name: o.name, typeId: o.typeId, componentId: o.componentId, technology: o.technology, x: o.x, y: o.y })),
    relationships: t.relationships.map((r) => [r.from, r.to, r.kind, r.label, r.protocol]),
    saved: { author: t.author, createdAt: t.createdAt, updatedAt: t.updatedAt, sourceDiagramId: t.sourceDiagramId },
  };
}

/** The built-in templates and the workspace's own, its own first. */
export function allTemplates(ws?: Pick<Workspace, "templates">): Template[] {
  const own = Object.values(ws?.templates ?? {})
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(fromSaved);
  return [...own, ...TEMPLATES];
}

export const templatesIn = (perspective: Perspective | null, pool: Template[] = TEMPLATES) => pool.filter((t) => !perspective || t.perspective === perspective);

/** Templates whose name, description, tags or box names contain every word typed. */
export function searchTemplates(query: string, perspective: Perspective | null = null, from: Template[] = TEMPLATES): Template[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = templatesIn(perspective, from);
  if (!words.length) return pool;
  return pool.filter((t) => {
    const hay = `${t.name} ${t.about} ${t.tags ?? ""} ${t.objects.map((o) => o.name).join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Objects that hold others are drawn as their parts, not as a box around nothing. */
export const containers = (t: Template) => new Set(t.objects.map((o) => o.inside).filter((k): k is string => !!k));

export interface TemplateResult {
  ws: Workspace;
  diagramId: string;
  added: number;
  reused: number;
}

/** Puts a template into the model and draws one diagram of it. */
export interface StartAs {
  /** The new diagram's name; the template's own name when left out. */
  name?: string;
  /** The kind of diagram chosen for it; Custom when left out. */
  viewType?: ViewType;
  /** The object the diagram is about, for a C4 Level 1 or Level 2 diagram. */
  scopeId?: string | null;
}

export function applyTemplate(ws: Workspace, templateId: string, start: StartAs = {}): TemplateResult | null {
  const own = ws.templates?.[templateId];
  const template = own ? fromSaved(own) : TEMPLATES.find((t) => t.id === templateId);
  if (!template) return null;
  return applyTemplateValue(ws, template, start);
}

/** Puts a template, built in or made on the spot (by the wizard), into the model with one diagram of it. */
export function applyTemplateValue(ws: Workspace, template: Template, start: StartAs = {}): TemplateResult {
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
    const made = createObject(next, { name: o.name, typeId: o.typeId, parentId: o.inside ? (ids[o.inside] ?? null) : null, technology: o.technology ?? "", description: o.description ?? "", componentId: o.componentId });
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
  const base = start.name?.trim() || template.name;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  const created = createDiagram(next, { name, viewType: start.viewType ?? "custom", scopeId: start.scopeId && next.objects[start.scopeId] ? start.scopeId : null, description: template.about, direction: template.direction ?? "TB" });
  next = template.notation ? updateDiagram(created.ws, created.diagram.id, { notation: template.notation }) : created.ws;
  // A box that holds others is left off: its parts are drawn, and the diagram reads better without a box around nothing.
  const hidden = containers(template);
  const shown = template.objects.filter((o) => !hidden.has(o.key)).map((o) => ids[o.key]);
  next = addObjectsToDiagram(next, created.diagram.id, shown);
  // A template made from a diagram keeps its boxes where they were; the others are laid out.
  const drawn = template.objects.filter((o) => !hidden.has(o.key));
  if (drawn.every((o) => o.x !== undefined && o.y !== undefined)) {
    next = placeNodes(next, created.diagram.id, Object.fromEntries(drawn.map((o) => [ids[o.key], { x: o.x!, y: o.y!, pinned: true }])));
  } else next = relayout(next, created.diagram.id, false);
  return { ws: next, diagramId: created.diagram.id, added, reused };
}

export interface TemplateDraft {
  name: string;
  perspective: Perspective;
  about: string;
  tags?: string;
}

/** A box of the diagram that is not a library component, and what the template will make it. */
export interface Substitution {
  objectId: string;
  name: string;
  componentId: string;
}

/**
 * What a diagram becomes as a template: its boxes, each a library component, the lines the
 * diagram draws between them, and where the boxes stand. A box that is not a library component
 * is saved as the usual component for its type, and listed so the person can choose otherwise
 * first. Owners, descriptions, basic information and links stay with the real objects.
 */
export function templateFromDiagram(ws: Workspace, diagramId: string, draft: TemplateDraft, author: string): { template: SavedTemplate; substitutions: Substitution[] } | null {
  const diagram = ws.diagrams[diagramId];
  if (!diagram) return null;
  const placed = Object.entries(diagram.nodes).filter(([id]) => ws.objects[id]);
  if (!placed.length) return null;
  const minX = Math.min(...placed.map(([, p]) => p.x));
  const minY = Math.min(...placed.map(([, p]) => p.y));
  const keyOf = new Map(placed.map(([id], i) => [id, `o${i + 1}`]));
  const substitutions: Substitution[] = [];
  const objects = placed.map(([id, p]) => {
    const o = ws.objects[id];
    let component = componentById(o.componentId);
    if (!component) {
      component = libraryComponent(USUAL_COMPONENT[o.typeId] ?? "applications.custom-application", "made from a diagram");
      substitutions.push({ objectId: id, name: o.name, componentId: component.id });
    }
    return { key: keyOf.get(id)!, name: o.name, componentId: component.id, typeId: component.kind, technology: o.technology, x: Math.round(p.x - minX), y: Math.round(p.y - minY) };
  });
  // Only lines between two boxes of the diagram: a rolled-up line stands for objects the template does not have.
  const relationships = visibleEdges(ws, diagram)
    .filter((e) => !e.implied && keyOf.has(e.sourceId) && keyOf.has(e.targetId))
    .map((e) => {
      const r = ws.relationships[e.id];
      return { from: keyOf.get(e.sourceId)!, to: keyOf.get(e.targetId)!, kind: e.kind, label: r?.label ?? "", protocol: r?.protocol ?? "" };
    });
  const stamp = nowIso();
  return {
    template: {
      id: newId("tpl"),
      name: draft.name.trim().slice(0, 120) || diagram.name,
      perspective: draft.perspective,
      about: draft.about.trim().slice(0, 400),
      tags: (draft.tags ?? "").trim().slice(0, 200),
      direction: diagram.direction,
      ...(diagram.notation === "bpmn" || diagram.notation === "archimate" ? { notation: diagram.notation } : {}),
      objects,
      relationships,
      sourceDiagramId: diagramId,
      author,
      createdAt: stamp,
      updatedAt: stamp,
    },
    substitutions,
  };
}

export function saveTemplate(ws: Workspace, template: SavedTemplate): Workspace {
  return { ...ws, templates: { ...(ws.templates ?? {}), [template.id]: template }, updatedAt: nowIso() };
}

export function updateSavedTemplate(ws: Workspace, id: string, patch: Partial<Pick<SavedTemplate, "name" | "perspective" | "about" | "tags">>): Workspace {
  const current = ws.templates?.[id];
  if (!current) return ws;
  return saveTemplate(ws, { ...current, ...patch, name: patch.name?.trim() || current.name, updatedAt: nowIso() });
}

export function deleteSavedTemplate(ws: Workspace, id: string): Workspace {
  if (!ws.templates?.[id]) return ws;
  const { [id]: _gone, ...rest } = ws.templates;
  return { ...ws, templates: rest, updatedAt: nowIso() };
}

/** A first guess at the perspective, from what most of the diagram's boxes are. The person chooses. */
export function guessPerspective(ws: Workspace, diagram: Diagram): Perspective {
  const votes: Record<Perspective, number> = { applications: 0, data: 0, infrastructure: 0, business: 0 };
  for (const id of Object.keys(diagram.nodes)) {
    const o = ws.objects[id];
    if (!o) continue;
    const section = componentById(o.componentId)?.sectionId ?? "";
    if (diagram.notation === "bpmn" || ["business", "people"].includes(section) || ["domain", "process", "task", "event", "decision", "actor"].includes(o.typeId)) votes.business++;
    else if (["data"].includes(section) || ["database", "storage", "cache", "queue"].includes(o.typeId)) votes.data++;
    else if (["compute", "storage", "datacenter", "network", "security", "end-user", "containers", "iot"].includes(section) || ["server", "network", "cluster", "gateway"].includes(o.typeId)) votes.infrastructure++;
    else votes.applications++;
  }
  return (Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0] as Perspective) ?? "applications";
}
