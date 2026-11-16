import type { Lifecycle, RelationKind, ViewType } from "./types";

export type Category = "business" | "people" | "application" | "data" | "infrastructure" | "external";

export interface ObjectType {
  id: string;
  label: string;
  /** 1 = domain, 2 = system, 3 = application or resource, 4 = component. A parent must sit on a lower number. */
  level: 1 | 2 | 3 | 4;
  category: Category;
  /** Key into the icon map in components/icons.tsx. */
  icon: string;
  hint: string;
}

export const LEVEL_NAMES: Record<number, string> = {
  1: "Domain",
  2: "System",
  3: "Application",
  4: "Component",
};

export const CATEGORY_INFO: Record<Category, { label: string; color: string }> = {
  business: { label: "Business", color: "#16233A" },
  people: { label: "People", color: "#B7791F" },
  application: { label: "Applications", color: "#2447D6" },
  data: { label: "Data", color: "#0E8A7D" },
  infrastructure: { label: "Infrastructure", color: "#6B4FBB" },
  external: { label: "External", color: "#6B7686" },
};

export const OBJECT_TYPES: ObjectType[] = [
  { id: "domain", label: "Domain", level: 1, category: "business", icon: "layers", hint: "A business or technology area that groups systems" },
  { id: "actor", label: "Person or team", level: 2, category: "people", icon: "user", hint: "Someone who uses a system" },
  { id: "system", label: "Software system", level: 2, category: "application", icon: "boxes", hint: "A system your organisation owns" },
  { id: "external-system", label: "External system", level: 2, category: "external", icon: "globe", hint: "A system run by someone else" },
  { id: "application", label: "Application", level: 3, category: "application", icon: "app", hint: "A deployable application" },
  { id: "web-app", label: "Web app", level: 3, category: "application", icon: "monitor", hint: "A browser front end" },
  { id: "mobile-app", label: "Mobile app", level: 3, category: "application", icon: "phone", hint: "An iOS or Android app" },
  { id: "service", label: "Service or API", level: 3, category: "application", icon: "cog", hint: "A back-end service or API" },
  { id: "database", label: "Database", level: 3, category: "data", icon: "database", hint: "A relational or NoSQL store" },
  { id: "queue", label: "Queue or stream", level: 3, category: "data", icon: "queue", hint: "A message queue or event stream" },
  { id: "cache", label: "Cache", level: 3, category: "data", icon: "zap", hint: "An in-memory cache" },
  { id: "storage", label: "File storage", level: 3, category: "data", icon: "drive", hint: "Object or file storage" },
  { id: "gateway", label: "Gateway", level: 3, category: "infrastructure", icon: "split", hint: "An API gateway, load balancer or CDN" },
  { id: "server", label: "Server or VM", level: 3, category: "infrastructure", icon: "server", hint: "A physical or virtual machine" },
  { id: "cluster", label: "Cluster", level: 3, category: "infrastructure", icon: "container", hint: "A container platform or cluster" },
  { id: "network", label: "Network device", level: 3, category: "infrastructure", icon: "shield", hint: "A firewall, VPN or network zone device" },
  { id: "component", label: "Component", level: 4, category: "application", icon: "puzzle", hint: "A module inside an application" },
  // AI: what acts on its own, what it thinks with and what gives it tools.
  { id: "ai-agent", label: "AI agent", level: 3, category: "application", icon: "bot", hint: "Software that decides its own steps using an AI model" },
  { id: "ai-model", label: "AI model", level: 3, category: "application", icon: "brain", hint: "A language or other AI model, hosted by you or by a provider" },
  { id: "mcp-server", label: "MCP server", level: 3, category: "application", icon: "plug", hint: "A server that gives AI agents tools and data over MCP" },
  // Process steps, for diagrams drawn in BPMN.
  { id: "process", label: "Process", level: 3, category: "business", icon: "workflow", hint: "A business process: a sequence of steps with a start and an end" },
  { id: "task", label: "Task", level: 4, category: "business", icon: "task", hint: "One step of a process, done by a person or a system" },
  { id: "event", label: "Event", level: 4, category: "business", icon: "event", hint: "Something that starts, interrupts or ends a process" },
  { id: "decision", label: "Decision", level: 4, category: "business", icon: "decision", hint: "A point where a process splits or joins (a BPMN gateway)" },
  // Network zones hold what sits in them, so the zone is drawn around it.
  { id: "zone", label: "Network zone", level: 2, category: "infrastructure", icon: "zone", hint: "A part of the network with its own rules, such as a DMZ. What is placed inside it is drawn within it" },
  // Another diagram drawn as one box, so a component can connect to everything it shows.
  { id: "diagram", label: "Diagram", level: 2, category: "external", icon: "diagram", hint: "Another diagram of this workspace, as one box to connect to" },
];

const TYPE_BY_ID = new Map(OBJECT_TYPES.map((t) => [t.id, t]));
export const DEFAULT_TYPE_ID = "application";

export function objectType(typeId: string): ObjectType {
  return TYPE_BY_ID.get(typeId) ?? TYPE_BY_ID.get(DEFAULT_TYPE_ID)!;
}
export function isKnownType(typeId: string): boolean {
  return TYPE_BY_ID.has(typeId);
}
export function typeColor(typeId: string): string {
  return CATEGORY_INFO[objectType(typeId).category].color;
}

export interface RelationKindInfo {
  label: string;
  /** Shown on edges that have no label of their own. */
  verb: string;
  /** True when the source cannot work without the target; only these kinds drive dependency and impact analysis. */
  dependency: boolean;
  hint: string;
}

export const RELATION_KIND_INFO: Record<RelationKind, RelationKindInfo> = {
  calls: { label: "Calls", verb: "calls", dependency: true, hint: "The source sends requests to the target" },
  depends_on: { label: "Depends on", verb: "depends on", dependency: true, hint: "The source needs the target to work" },
  reads_writes: { label: "Reads or writes", verb: "reads / writes", dependency: true, hint: "The source stores or loads data in the target" },
  hosted_on: { label: "Hosted on", verb: "hosted on", dependency: true, hint: "The source runs on the target" },
  routes_to: { label: "Routes to", verb: "routes to", dependency: false, hint: "The source forwards traffic to the target" },
  replicates_to: { label: "Replicates to", verb: "replicates to", dependency: false, hint: "The source copies data to the target" },
  flows_to: { label: "Then", verb: "then", dependency: false, hint: "The target step follows the source step in a process" },
};

export const LIFECYCLE_INFO: Record<Lifecycle, { label: string; color: string }> = {
  planned: { label: "Planned", color: "#2447D6" },
  active: { label: "Active", color: "#1F8A4C" },
  deprecated: { label: "Deprecated", color: "#C97A0A" },
  retired: { label: "Retired", color: "#B4321F" },
};

export const VIEW_TYPE_INFO: Record<ViewType, { label: string; hint: string }> = {
  landscape: { label: "C4 System landscape", hint: "Every system and the people who use them" },
  context: { label: "C4 Level 1: System context", hint: "One system and everything it talks to" },
  container: { label: "C4 Level 2: Containers", hint: "The applications and data stores inside one system" },
  deployment: { label: "Infrastructure", hint: "Servers, clusters, networks and what is hosted on them" },
  dataflow: { label: "Data", hint: "Data stores and the applications that read or write them" },
  business: { label: "Business", hint: "Domains, processes, their steps and the people who take part" },
  custom: { label: "Custom", hint: "Any objects you choose" },
};

/** Stable, readable colours for the "colour by owner" overlay. */
export const OWNER_PALETTE = ["#2447D6", "#0E8A7D", "#6B4FBB", "#B7791F", "#B4321F", "#1F8A4C", "#C2478F", "#3B7EA1"];
export function ownerColor(owner: string): string {
  if (!owner.trim()) return "#9AA5B5";
  let h = 0;
  for (const ch of owner.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return OWNER_PALETTE[h % OWNER_PALETTE.length];
}
