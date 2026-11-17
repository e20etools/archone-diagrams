import { ADR_STATUS_LABEL, adrLabel, sortedAdrs } from "./adr";
import { CATEGORY_INFO, viewCategory } from "./categories";
import { LIFECYCLE_INFO, RELATION_KIND_INFO, VIEW_TYPE_INFO, objectType } from "./catalog";
import { DATA_FIELDS, PACKS, ruleById, runChecks } from "./checks/checks";
import { diagramMap, mapReach, mapRows } from "./diagramMap";
import { walk } from "./impact";
import { LIBRARY_SECTIONS, componentById, exactComponent } from "./library";
import { protocolByName } from "./library/protocols";
import { diagramsUsing, nowIso, protocolsOf, sortedDiagrams } from "./model";
import { singlePoints } from "./resilience";
import { FILTER_OPS, customReportSchema, type CustomReport, type FilterOp } from "./types";
import type { Diagram, ModelObject, Relationship, Workspace } from "./types";
import { visibleEdges } from "./views";

/**
 * Reports read from the model: inventories, connections, risk, governance, diagrams and data,
 * and the workspace's own reports, built from a subject, columns, filters and a grouping.
 * Every report is a table, sometimes with a chart, and exports the same way.
 */

export type Cell = string | number;
export interface ReportResult {
  columns: string[];
  rows: Cell[][];
  chart?: { title: string; data: { label: string; value: number }[] };
  /** A sentence under the title: what the numbers say. */
  note?: string;
}

export const REPORT_AREAS = [
  { id: "inventory", label: "Inventory" },
  { id: "connections", label: "Connections and interfaces" },
  { id: "risk", label: "Risk and resilience" },
  { id: "governance", label: "Governance and quality" },
  { id: "data", label: "Data" },
  { id: "diagrams", label: "Diagrams" },
] as const;
export type ReportArea = (typeof REPORT_AREAS)[number]["id"];

export interface BuiltInReport {
  id: string;
  area: ReportArea;
  title: string;
  description: string;
  run: (ws: Workspace) => ReportResult;
}

/* ---------- helpers ---------- */

const APPS = new Set(["system", "application", "web-app", "mobile-app", "service", "external-system", "ai-agent", "mcp-server"]);
const DATA = new Set(["database", "storage", "cache", "queue"]);
const typeName = (o: ModelObject) => objectType(o.typeId).label;
const criticality = (o: ModelObject) => o.fields["Business criticality"] ?? "";
const isTier1 = (o: ModelObject) => o.tags.includes("tier-1") || /critical/i.test(criticality(o));
const nameOf = (ws: Workspace, id: string) => ws.objects[id]?.name ?? "?";
const lifecycle = (o: ModelObject) => LIFECYCLE_INFO[o.lifecycle]?.label ?? o.lifecycle;
const day = (iso: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");
const list = (names: string[], max = 6) => (names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", "));
const live = (ws: Workspace) => Object.values(ws.objects).filter((o) => o.typeId !== "diagram");
const liveRels = (ws: Workspace) => Object.values(ws.relationships).filter((r) => ws.objects[r.sourceId] && ws.objects[r.targetId]);
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
const countBy = <T>(items: T[], key: (t: T) => string) => {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i) || "None", (m.get(key(i) || "None") ?? 0) + 1);
  return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
};
const component = (o: ModelObject) => componentById(o.componentId) ?? (o.componentId ? undefined : exactComponent(o.name));
const dependents = (ws: Workspace) => {
  const m = new Map<string, string[]>();
  for (const r of liveRels(ws)) if (RELATION_KIND_INFO[r.kind]?.dependency) (m.get(r.targetId) ?? m.set(r.targetId, []).get(r.targetId)!).push(r.sourceId);
  return m;
};
const dependencies = (ws: Workspace) => {
  const m = new Map<string, string[]>();
  for (const r of liveRels(ws)) if (RELATION_KIND_INFO[r.kind]?.dependency) (m.get(r.sourceId) ?? m.set(r.sourceId, []).get(r.sourceId)!).push(r.targetId);
  return m;
};
const protocolText = (r: Relationship) => protocolsOf(r).map((p) => p.name).join(", ");
const portText = (r: Relationship) => protocolsOf(r).map((p) => p.port).filter(Boolean).join(", ");
const DIRECTION = { out: "Outbound", in: "Inbound", both: "Both ways" } as const;
const clearProtocols = (r: Relationship) => (r.encrypted === "yes" ? [] : protocolsOf(r).filter((p) => protocolByName(p.name)?.secure === false));

/* ---------- the built-in reports ---------- */

export const BUILT_IN_REPORTS: BuiltInReport[] = [
  {
    id: "application-portfolio",
    area: "inventory",
    title: "Application portfolio",
    description: "Every system, application and service, with its owner, lifecycle, technology and criticality.",
    run: (ws) => {
      const items = live(ws).filter((o) => APPS.has(o.typeId)).sort(byName);
      return {
        columns: ["Name", "Type", "Owner", "Lifecycle", "Technology", "Criticality", "Tier-1", "Diagrams"],
        rows: items.map((o) => [o.name, typeName(o), o.owner, lifecycle(o), o.technology, criticality(o), isTier1(o) ? "Yes" : "", diagramsUsing(ws, o.id).length]),
        chart: { title: "By lifecycle", data: countBy(items, lifecycle) },
        note: `${items.length} applications and services; ${items.filter(isTier1).length} are tier-1 or critical.`,
      };
    },
  },
  {
    id: "components-by-type",
    area: "inventory",
    title: "Components by type",
    description: "How many of each type the model holds, and how many teams own them.",
    run: (ws) => {
      const groups = countBy(live(ws), typeName);
      return {
        columns: ["Type", "Components", "Owners", "Without an owner"],
        rows: groups.map((g) => {
          const items = live(ws).filter((o) => typeName(o) === g.label);
          return [g.label, g.value, new Set(items.map((o) => o.owner.trim()).filter(Boolean)).size, items.filter((o) => !o.owner.trim()).length];
        }),
        chart: { title: "Components by type", data: groups.slice(0, 12) },
      };
    },
  },
  {
    id: "technology-stack",
    area: "inventory",
    title: "Technology stack",
    description: "The technologies in use, and which components run on each.",
    run: (ws) => {
      const groups = countBy(live(ws).filter((o) => o.technology.trim()), (o) => o.technology.trim());
      return {
        columns: ["Technology", "Components", "Used by"],
        rows: groups.map((g) => [g.label, g.value, list(live(ws).filter((o) => o.technology.trim() === g.label).map((o) => o.name))]),
        chart: { title: "Most used", data: groups.slice(0, 12) },
        note: `${groups.length} technologies across ${live(ws).filter((o) => o.technology.trim()).length} components.`,
      };
    },
  },
  {
    id: "library-usage",
    area: "inventory",
    title: "Library components in use",
    description: "Which components of the library the model uses, from which section, and how often.",
    run: (ws) => {
      const used = new Map<string, ModelObject[]>();
      for (const o of live(ws)) {
        const c = component(o);
        if (c) (used.get(c.id) ?? used.set(c.id, []).get(c.id)!).push(o);
      }
      const rows = [...used].map(([id, items]) => {
        const c = componentById(id)!;
        return [c.name, LIBRARY_SECTIONS.find((s) => s.id === c.sectionId)?.label ?? c.sectionId, items.length, list(items.map((o) => o.name))] as Cell[];
      });
      rows.sort((a, b) => Number(b[2]) - Number(a[2]) || String(a[0]).localeCompare(String(b[0])));
      return { columns: ["Library component", "Section", "Objects", "Objects using it"], rows, chart: { title: "Most used", data: rows.slice(0, 12).map((r) => ({ label: String(r[0]), value: Number(r[2]) })) } };
    },
  },
  {
    id: "external-parties",
    area: "inventory",
    title: "External systems and vendors",
    description: "Systems run by others, who calls them and over which protocols.",
    run: (ws) => {
      const into = dependents(ws);
      const items = live(ws).filter((o) => o.typeId === "external-system").sort(byName);
      return {
        columns: ["Name", "Description", "Used by", "Callers", "Protocols"],
        rows: items.map((o) => {
          const callers = into.get(o.id) ?? [];
          const protocols = [...new Set(liveRels(ws).filter((r) => r.targetId === o.id).flatMap((r) => protocolsOf(r).map((p) => p.name)))];
          return [o.name, o.description, callers.length, list(callers.map((id) => nameOf(ws, id))), protocols.join(", ")];
        }),
      };
    },
  },
  {
    id: "shared-components",
    area: "inventory",
    title: "Shared components",
    description: "Components that appear on more than one diagram: the shared services everything leans on.",
    run: (ws) => {
      const items = live(ws)
        .map((o) => ({ o, ds: diagramsUsing(ws, o.id).filter((d) => !d.archive?.archived) }))
        .filter((x) => x.ds.length > 1)
        .sort((a, b) => b.ds.length - a.ds.length || a.o.name.localeCompare(b.o.name));
      return {
        columns: ["Component", "Type", "Owner", "Diagrams", "On"],
        rows: items.map(({ o, ds }) => [o.name, typeName(o), o.owner, ds.length, list(ds.map((d) => d.name))]),
        chart: { title: "On the most diagrams", data: items.slice(0, 12).map(({ o, ds }) => ({ label: o.name, value: ds.length })) },
      };
    },
  },
  {
    id: "network-zones",
    area: "inventory",
    title: "Network zones",
    description: "Each network zone and what sits in it.",
    run: (ws) => {
      const zones = live(ws).filter((o) => o.typeId === "zone").sort(byName);
      return {
        columns: ["Zone", "Components", "In it", "Diagrams"],
        rows: zones.map((z) => {
          const inside = live(ws).filter((o) => o.parentId === z.id);
          return [z.name, inside.length, list(inside.map((o) => o.name), 10), list(diagramsUsing(ws, z.id).map((d) => d.name))];
        }),
      };
    },
  },
  {
    id: "interface-catalogue",
    area: "connections",
    title: "Interface catalogue",
    description: "Every connection: who talks to whom, how, over which protocols, ports and network, and whether it is encrypted.",
    run: (ws) => {
      const rels = liveRels(ws).filter((r) => r.kind !== "flows_to" && r.kind !== "hosted_on");
      return {
        columns: ["From", "To", "Kind", "Label", "Protocols", "Ports", "Network", "Direction", "Encrypted"],
        rows: rels
          .map((r) => [nameOf(ws, r.sourceId), nameOf(ws, r.targetId), RELATION_KIND_INFO[r.kind]?.label ?? r.kind, r.label, protocolText(r), portText(r), r.network ?? "", DIRECTION[r.flow ?? "out"], r.encrypted === "yes" ? "Yes" : r.encrypted === "no" ? "No" : ""] as Cell[])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        note: `${rels.length} connections; ${rels.filter((r) => protocolsOf(r).length).length} say which protocol they use.`,
      };
    },
  },
  {
    id: "protocols-ports",
    area: "connections",
    title: "Protocols and ports in use",
    description: "Each protocol and port the connections use, how often, and whether it encrypts what it carries.",
    run: (ws) => {
      const m = new Map<string, { name: string; port: string; transport: string; count: number }>();
      for (const r of liveRels(ws))
        for (const p of protocolsOf(r)) {
          const key = `${p.name}|${p.port}`;
          const e = m.get(key) ?? m.set(key, { name: p.name, port: p.port, transport: p.transport ?? protocolByName(p.name)?.transport ?? "", count: 0 }).get(key)!;
          e.count++;
        }
      const rows = [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      return {
        columns: ["Protocol", "Port", "Transport", "Connections", "Encrypts"],
        rows: rows.map((p) => [p.name, p.port, p.transport, p.count, protocolByName(p.name) ? (protocolByName(p.name)!.secure ? "Yes" : "No") : ""]),
        chart: { title: "Most used", data: rows.slice(0, 12).map((p) => ({ label: p.port ? `${p.name} ${p.port}` : p.name, value: p.count })) },
      };
    },
  },
  {
    id: "clear-text",
    area: "connections",
    title: "Connections in clear text",
    description: "Connections over protocols that do not encrypt, and not marked as encrypted some other way.",
    run: (ws) => {
      const rels = liveRels(ws).filter((r) => clearProtocols(r).length);
      return {
        columns: ["From", "To", "Protocols in clear text", "Network"],
        rows: rels.map((r) => [nameOf(ws, r.sourceId), nameOf(ws, r.targetId), clearProtocols(r).map((p) => p.name).join(", "), r.network ?? ""]),
        note: rels.length ? `${rels.length} connections send data in clear text.` : "No connection is known to send data in clear text.",
      };
    },
  },
  {
    id: "cross-diagram",
    area: "connections",
    title: "Dependencies between diagrams",
    description: "Which diagrams depend on which, and which share components, with the components behind each link.",
    run: (ws) => {
      const rows = mapRows(ws, diagramMap(ws));
      return { columns: rows[0], rows: rows.slice(1) };
    },
  },
  {
    id: "single-points",
    area: "risk",
    title: "Single points of failure",
    description: "The components whose failure takes the most with them.",
    run: (ws) => {
      const points = singlePoints(ws, 50).filter((p) => p.dependents > 0);
      return {
        columns: ["Component", "Type", "Owner", "Stop with it", "Tier-1 among them", "People affected"],
        rows: points.map((p) => [p.object.name, typeName(p.object), p.object.owner, p.dependents, p.tier1, p.people]),
        chart: { title: "What stops with each", data: points.slice(0, 10).map((p) => ({ label: p.object.name, value: p.dependents })) },
      };
    },
  },
  {
    id: "impact-ranking",
    area: "risk",
    title: "Impact ranking",
    description: "Each component by how much depends on it, up to the fifth level, and how many diagrams that reaches.",
    run: (ws) => {
      const direct = dependents(ws);
      const items = live(ws)
        .filter((o) => o.typeId !== "actor" && o.typeId !== "domain")
        .map((o) => {
          const steps = walk(ws, [o.id], "neededBy", 5);
          const diagrams = new Set(steps.flatMap((s) => diagramsUsing(ws, s.id).map((d) => d.id)));
          return { o, direct: (direct.get(o.id) ?? []).length, all: steps.length, diagrams: diagrams.size };
        })
        .filter((x) => x.all > 0)
        .sort((a, b) => b.all - a.all || b.direct - a.direct)
        .slice(0, 100);
      return {
        columns: ["Component", "Type", "Owner", "Depend on it directly", "Depend on it within 5 levels", "Diagrams reached", "Tier-1"],
        rows: items.map((x) => [x.o.name, typeName(x.o), x.o.owner, x.direct, x.all, x.diagrams, isTier1(x.o) ? "Yes" : ""]),
        chart: { title: "Most depended on, within 5 levels", data: items.slice(0, 10).map((x) => ({ label: x.o.name, value: x.all })) },
      };
    },
  },
  {
    id: "critical-weak-links",
    area: "risk",
    title: "Critical components and what they rest on",
    description: "What each tier-1 or critical component depends on, marking the dependencies that are not critical themselves.",
    run: (ws) => {
      const needs = dependencies(ws);
      const rows: Cell[][] = [];
      for (const o of live(ws).filter(isTier1).sort(byName))
        for (const id of needs.get(o.id) ?? []) {
          const d = ws.objects[id];
          rows.push([o.name, d.name, typeName(d), d.owner, isTier1(d) ? "Yes" : "No: a weak link", d.lifecycle === "deprecated" || d.lifecycle === "retired" ? lifecycle(d) : ""]);
        }
      return { columns: ["Critical component", "Depends on", "Type", "Owner", "Itself critical", "Lifecycle warning"], rows, note: `${rows.filter((r) => String(r[4]).startsWith("No")).length} dependencies of critical components are not critical themselves.` };
    },
  },
  {
    id: "ownership-gaps",
    area: "governance",
    title: "Components without an owner",
    description: "Nobody is called when these stop.",
    run: (ws) => {
      const into = dependents(ws);
      const items = live(ws).filter((o) => !o.owner.trim() && o.typeId !== "actor" && !["task", "event", "decision"].includes(o.typeId)).sort((a, b) => (into.get(b.id) ?? []).length - (into.get(a.id) ?? []).length || a.name.localeCompare(b.name));
      return { columns: ["Component", "Type", "Depended on by", "Diagrams"], rows: items.map((o) => [o.name, typeName(o), (into.get(o.id) ?? []).length, list(diagramsUsing(ws, o.id).map((d) => d.name))]), note: `${items.length} components have no owner.` };
    },
  },
  {
    id: "lifecycle",
    area: "governance",
    title: "Lifecycle and end of life",
    description: "Components by lifecycle, and those deprecated or retired that others still depend on.",
    run: (ws) => {
      const into = dependents(ws);
      const ending = live(ws).filter((o) => o.lifecycle === "deprecated" || o.lifecycle === "retired").sort(byName);
      return {
        columns: ["Component", "Lifecycle", "Owner", "Still depended on by", "Who"],
        rows: ending.map((o) => [o.name, lifecycle(o), o.owner, (into.get(o.id) ?? []).length, list((into.get(o.id) ?? []).map((id) => nameOf(ws, id)))]),
        chart: { title: "Components by lifecycle", data: countBy(live(ws), lifecycle) },
      };
    },
  },
  {
    id: "documentation-gaps",
    area: "governance",
    title: "Components without a description",
    description: "What a newcomer would not understand from the model.",
    run: (ws) => {
      const items = live(ws).filter((o) => !o.description.trim() && !["task", "event", "decision", "zone"].includes(o.typeId)).sort(byName);
      return { columns: ["Component", "Type", "Owner"], rows: items.map((o) => [o.name, typeName(o), o.owner]), note: `${items.length} of ${live(ws).length} components have no description.` };
    },
  },
  {
    id: "check-findings",
    area: "governance",
    title: "Findings of the checks",
    description: "What every rule pack finds in the model: good practice, security, privacy, card data, NCA ECC and AI agents.",
    run: (ws) => {
      const findings = runChecks(
        ws,
        null,
        PACKS.map((p) => p.id),
      );
      const severity = { high: "High", medium: "Medium", low: "Low" } as const;
      return {
        columns: ["Severity", "Rule", "Finding"],
        rows: findings.map((f) => [severity[f.severity], ruleById(f.ruleId)?.title ?? f.ruleId, f.message]),
        chart: { title: "By severity", data: (["high", "medium", "low"] as const).map((s) => ({ label: severity[s], value: findings.filter((f) => f.severity === s).length })) },
      };
    },
  },
  {
    id: "decisions",
    area: "governance",
    title: "Architecture decisions",
    description: "The decision records, their status and what they are about.",
    run: (ws) => {
      const adrs = sortedAdrs(ws);
      return {
        columns: ["Number", "Title", "Status", "Date", "About"],
        rows: adrs.map((a) => [adrLabel(a), a.title, ADR_STATUS_LABEL[a.status] ?? a.status, day(a.decidedAt ?? a.createdAt), list(a.objectIds.map((id) => nameOf(ws, id)))]),
        chart: { title: "By status", data: countBy(adrs, (a) => ADR_STATUS_LABEL[a.status] ?? a.status) },
      };
    },
  },
  {
    id: "data-stores",
    area: "data",
    title: "Data stores",
    description: "Databases, storage, caches and queues: their classification, personal data, and who reads or writes them.",
    run: (ws) => {
      const into = new Map<string, string[]>();
      for (const r of liveRels(ws)) if (r.kind === "reads_writes" || r.kind === "calls") (into.get(r.targetId) ?? into.set(r.targetId, []).get(r.targetId)!).push(r.sourceId);
      const items = live(ws).filter((o) => DATA.has(o.typeId)).sort(byName);
      return {
        columns: ["Data store", "Type", "Technology", "Owner", "Classification", "Personal data", "Residency", "Read or written by"],
        rows: items.map((o) => [o.name, typeName(o), o.technology, o.owner, o.fields[DATA_FIELDS.classification] ?? "", o.fields[DATA_FIELDS.personal] ?? "", o.fields[DATA_FIELDS.residency] ?? "", list((into.get(o.id) ?? []).map((id) => nameOf(ws, id)))]),
        chart: { title: "By classification", data: countBy(items, (o) => o.fields[DATA_FIELDS.classification] ?? "") },
        note: `${items.filter((o) => !(o.fields[DATA_FIELDS.classification] ?? "").trim()).length} of ${items.length} data stores have no classification.`,
      };
    },
  },
  {
    id: "diagram-catalogue",
    area: "diagrams",
    title: "Diagram catalogue",
    description: "Every diagram: its kind, size, and how many other diagrams it depends on and impacts.",
    run: (ws) => {
      const map = diagramMap(ws);
      const diagrams = Object.values(ws.diagrams).sort(byName);
      return {
        columns: ["Diagram", "Kind", "Area", "Boxes", "Lines", "Depends on diagrams", "Impacts diagrams", "Updated", "Archived"],
        rows: diagrams.map((d) => [
          d.name,
          VIEW_TYPE_INFO[d.viewType]?.label ?? d.viewType,
          CATEGORY_INFO[viewCategory(d.viewType)].label,
          Object.keys(d.nodes).filter((id) => ws.objects[id]).length,
          visibleEdges(ws, d).length,
          d.archive?.archived ? "" : mapReach(map, d.id, "needs").size,
          d.archive?.archived ? "" : mapReach(map, d.id, "neededBy").size,
          day(d.updatedAt),
          d.archive?.archived ? "Yes" : "",
        ]),
        chart: { title: "By kind", data: countBy(diagrams, (d) => VIEW_TYPE_INFO[d.viewType]?.label ?? d.viewType) },
      };
    },
  },
];

export const builtInReport = (id: string) => BUILT_IN_REPORTS.find((r) => r.id === id);

/* ---------- the workspace's own reports ---------- */

export const REPORT_SUBJECTS = [
  { id: "components", label: "Components" },
  { id: "connections", label: "Connections" },
  { id: "diagrams", label: "Diagrams" },
] as const;
export type ReportSubject = (typeof REPORT_SUBJECTS)[number]["id"];
export { FILTER_OPS, customReportSchema };
export type { CustomReport, FilterOp };

export interface Field<T> {
  id: string;
  label: string;
  get: (ws: Workspace, item: T, ctx: Context) => Cell;
}
interface Context {
  into: Map<string, string[]>;
  out: Map<string, string[]>;
}

const objectFields: Field<ModelObject>[] = [
  { id: "name", label: "Name", get: (_, o) => o.name },
  { id: "type", label: "Type", get: (_, o) => typeName(o) },
  { id: "component", label: "Library component", get: (_, o) => component(o)?.name ?? "" },
  { id: "owner", label: "Owner", get: (_, o) => o.owner },
  { id: "lifecycle", label: "Lifecycle", get: (_, o) => lifecycle(o) },
  { id: "technology", label: "Technology", get: (_, o) => o.technology },
  { id: "criticality", label: "Business criticality", get: (_, o) => criticality(o) },
  { id: "tier1", label: "Tier-1", get: (_, o) => (isTier1(o) ? "Yes" : "No") },
  { id: "tags", label: "Tags", get: (_, o) => o.tags.join(", ") },
  { id: "parent", label: "Inside", get: (ws, o) => (o.parentId ? nameOf(ws, o.parentId) : "") },
  { id: "description", label: "Description", get: (_, o) => o.description },
  { id: "diagrams", label: "Diagrams (count)", get: (ws, o) => diagramsUsing(ws, o.id).length },
  { id: "diagramNames", label: "Diagrams", get: (ws, o) => diagramsUsing(ws, o.id).map((d) => d.name).join(", ") },
  { id: "dependsOn", label: "Depends on (count)", get: (_, o, c) => (c.out.get(o.id) ?? []).length },
  { id: "dependedOn", label: "Depended on by (count)", get: (_, o, c) => (c.into.get(o.id) ?? []).length },
  { id: "impact5", label: "Depended on within 5 levels", get: (ws, o) => walk(ws, [o.id], "neededBy", 5).length },
  { id: "classification", label: "Data classification", get: (_, o) => o.fields[DATA_FIELDS.classification] ?? "" },
  { id: "personal", label: "Personal data", get: (_, o) => o.fields[DATA_FIELDS.personal] ?? "" },
  { id: "updated", label: "Last changed", get: (_, o) => day(o.updatedAt) },
];
const relationshipFields: Field<Relationship>[] = [
  { id: "from", label: "From", get: (ws, r) => nameOf(ws, r.sourceId) },
  { id: "to", label: "To", get: (ws, r) => nameOf(ws, r.targetId) },
  { id: "fromType", label: "From type", get: (ws, r) => objectType(ws.objects[r.sourceId]?.typeId ?? "").label },
  { id: "toType", label: "To type", get: (ws, r) => objectType(ws.objects[r.targetId]?.typeId ?? "").label },
  { id: "kind", label: "Kind", get: (_, r) => RELATION_KIND_INFO[r.kind]?.label ?? r.kind },
  { id: "label", label: "Label", get: (_, r) => r.label },
  { id: "protocols", label: "Protocols", get: (_, r) => protocolText(r) },
  { id: "ports", label: "Ports", get: (_, r) => portText(r) },
  { id: "network", label: "Network", get: (_, r) => r.network ?? "" },
  { id: "direction", label: "Direction", get: (_, r) => DIRECTION[r.flow ?? "out"] },
  { id: "encrypted", label: "Encrypted", get: (_, r) => (r.encrypted === "yes" ? "Yes" : r.encrypted === "no" ? "No" : "") },
  { id: "clear", label: "Clear-text protocols", get: (_, r) => clearProtocols(r).map((p) => p.name).join(", ") },
];
const diagramFields: Field<Diagram>[] = [
  { id: "name", label: "Name", get: (_, d) => d.name },
  { id: "kind", label: "Kind", get: (_, d) => VIEW_TYPE_INFO[d.viewType]?.label ?? d.viewType },
  { id: "area", label: "Area", get: (_, d) => CATEGORY_INFO[viewCategory(d.viewType)].label },
  { id: "boxes", label: "Boxes", get: (ws, d) => Object.keys(d.nodes).filter((id) => ws.objects[id]).length },
  { id: "lines", label: "Lines", get: (ws, d) => visibleEdges(ws, d).length },
  { id: "scope", label: "About", get: (ws, d) => (d.scopeId ? nameOf(ws, d.scopeId) : "") },
  { id: "description", label: "Description", get: (_, d) => d.description },
  { id: "archived", label: "Archived", get: (_, d) => (d.archive?.archived ? "Yes" : "No") },
  { id: "updated", label: "Last changed", get: (_, d) => day(d.updatedAt) },
];

export const SUBJECT_FIELDS: { components: Field<ModelObject>[]; connections: Field<Relationship>[]; diagrams: Field<Diagram>[] } = { components: objectFields, connections: relationshipFields, diagrams: diagramFields };
export const fieldsOf = (subject: ReportSubject) => SUBJECT_FIELDS[subject] as Field<unknown>[];

function matches(cell: Cell, op: FilterOp, value: string): boolean {
  const text = String(cell).toLowerCase();
  const v = value.trim().toLowerCase();
  switch (op) {
    case "is":
      return text === v;
    case "is not":
      return text !== v;
    case "contains":
      return text.includes(v);
    case "does not contain":
      return !text.includes(v);
    case "is empty":
      return text.trim() === "";
    case "is not empty":
      return text.trim() !== "";
    case "at least":
      return Number(cell) >= Number(value);
    case "at most":
      return Number(cell) <= Number(value);
  }
}

export function runCustomReport(ws: Workspace, report: Pick<CustomReport, "subject" | "columns" | "filters" | "groupBy" | "sortBy" | "sortDesc">): ReportResult {
  const ctx: Context = { into: dependents(ws), out: dependencies(ws) };
  const fields = fieldsOf(report.subject);
  const items: unknown[] = report.subject === "components" ? live(ws) : report.subject === "connections" ? liveRels(ws) : sortedDiagrams(ws);
  const field = (id: string) => fields.find((f) => f.id === id);
  const kept = items.filter((item) => report.filters.every((f) => !field(f.field) || matches(field(f.field)!.get(ws, item, ctx), f.op, f.value)));
  const columns = report.columns.map(field).filter((f): f is Field<unknown> => !!f);
  let rows = kept.map((item) => ({ item, cells: columns.map((c) => c.get(ws, item, ctx)) }));
  const sort = report.sortBy ? field(report.sortBy) : columns[0];
  if (sort) {
    const key = new Map(rows.map((r) => [r, sort.get(ws, r.item, ctx)]));
    rows = rows.sort((a, b) => {
      const x = key.get(a)!;
      const y = key.get(b)!;
      const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return report.sortDesc ? -order : order;
    });
  }
  const group = report.groupBy ? field(report.groupBy) : undefined;
  return {
    columns: columns.map((c) => c.label),
    rows: rows.map((r) => r.cells),
    chart: group ? { title: `By ${group.label.toLowerCase()}`, data: countBy(kept, (item) => String(group.get(ws, item, ctx))).slice(0, 15) } : undefined,
    note: `${rows.length} of ${items.length} ${REPORT_SUBJECTS.find((s) => s.id === report.subject)!.label.toLowerCase()}.`,
  };
}

export const newReportId = () => `rep_${Math.random().toString(36).slice(2, 10)}`;

export function saveReport(ws: Workspace, report: CustomReport): Workspace {
  const clean = customReportSchema.parse({ ...report, updatedAt: nowIso() });
  return { ...ws, reports: { ...(ws.reports ?? {}), [clean.id]: clean }, updatedAt: nowIso() };
}

export function deleteReport(ws: Workspace, id: string): Workspace {
  const { [id]: _gone, ...rest } = ws.reports ?? {};
  return { ...ws, reports: rest, updatedAt: nowIso() };
}

export const sortedReports = (ws: Workspace) => Object.values(ws.reports ?? {}).sort((a, b) => a.name.localeCompare(b.name));
