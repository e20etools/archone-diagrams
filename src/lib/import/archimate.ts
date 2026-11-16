import { RELATION_KIND_INFO, objectType } from "../catalog";
import type { RelationKind, Workspace } from "../types";
import { ImportError, OBJECT_FIELDS, RELATIONSHIP_FIELDS } from "./draft";
import { allText, descendants, escapeXml, parseXml, type XmlNode } from "./xml";
import type { Sheet } from "./xlsx";

/**
 * ArchiMate (PRD FR-10), as an exchange format: the model goes out as an ArchiMate 3 Model
 * Exchange File, which Archi, Bizzdesign, Sparx and others open, and such a file comes in as
 * a draft. Diagrams go out as views with their boxes where they were drawn.
 *
 * The two notations do not line up one to one. Going out, each object type has one ArchiMate
 * element and each relationship kind one ArchiMate relationship, chosen to be valid ArchiMate;
 * the exact type and kind also travel as properties, so a file written here comes back as it
 * left. Coming in from another tool, elements this app has no type for arrive as the nearest
 * one, and the review step is where a person corrects that.
 */

export const ARCHIMATE_ELEMENT: Record<string, string> = {
  process: "BusinessProcess",
  task: "BusinessProcess",
  event: "BusinessEvent",
  decision: "BusinessProcess",
  domain: "Grouping",
  actor: "BusinessActor",
  system: "ApplicationComponent",
  "external-system": "ApplicationComponent",
  application: "ApplicationComponent",
  "web-app": "ApplicationComponent",
  "mobile-app": "ApplicationComponent",
  service: "ApplicationComponent",
  component: "ApplicationComponent",
  "ai-agent": "ApplicationComponent",
  "ai-model": "ApplicationComponent",
  "mcp-server": "ApplicationComponent",
  database: "SystemSoftware",
  queue: "SystemSoftware",
  cache: "SystemSoftware",
  storage: "SystemSoftware",
  gateway: "Node",
  server: "Node",
  cluster: "Node",
  network: "CommunicationNetwork",
};
/** ArchiMate element to the nearest type here, for files written by other tools. */
const FROM_ELEMENT: Record<string, string> = {
  Grouping: "domain", Location: "domain",
  BusinessActor: "actor", BusinessRole: "actor", Stakeholder: "actor",
  BusinessProcess: "process", BusinessFunction: "process", BusinessInteraction: "process", BusinessEvent: "event",
  ApplicationComponent: "application", ApplicationCollaboration: "system", ApplicationInterface: "service", ApplicationService: "service", ApplicationFunction: "component", ApplicationProcess: "component",
  DataObject: "database", Artifact: "storage", SystemSoftware: "database",
  Node: "server", Device: "server", TechnologyService: "service", TechnologyInterface: "gateway", TechnologyCollaboration: "cluster", Path: "network", CommunicationNetwork: "network",
  Facility: "server", Equipment: "server",
};
const PROPS = { type: "archone:type", owner: "archone:owner", lifecycle: "archone:lifecycle", technology: "archone:technology", tags: "archone:tags", kind: "archone:kind", protocol: "archone:protocol", port: "archone:port" } as const;

const xid = (kind: string, id: string) => `${kind}-${id.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
const named = (tag: string, value: string) => (value.trim() ? `<${tag} xml:lang="en">${escapeXml(value)}</${tag}>` : "");
const props = (pairs: [string, string][]) => {
  const filled = pairs.filter(([, value]) => value.trim());
  return filled.length ? `<properties>${filled.map(([key, value]) => `<property propertyDefinitionRef="${xid("prop", key)}"><value xml:lang="en">${escapeXml(value)}</value></property>`).join("")}</properties>` : "";
};

/** The model as an ArchiMate 3.x Model Exchange File. */
export function writeArchimate(ws: Workspace): string {
  const objects = Object.values(ws.objects).sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  const relationships: string[] = [];
  const relationshipIds = new Map<string, string>();

  for (const o of objects) {
    lines.push(
      `<element identifier="${xid("id", o.id)}" xsi:type="${ARCHIMATE_ELEMENT[o.typeId] ?? "ApplicationComponent"}">${named("name", o.name || "Unnamed")}${named("documentation", o.description)}${props([
        [PROPS.type, o.typeId],
        [PROPS.owner, o.owner],
        [PROPS.lifecycle, o.lifecycle],
        [PROPS.technology, o.technology],
        [PROPS.tags, o.tags.join(", ")],
        ...Object.entries(o.fields).map(([key, value]): [string, string] => [key, value]),
      ])}</element>`,
    );
    const parent = o.parentId ? ws.objects[o.parentId] : undefined;
    if (parent) {
      // Composition is only valid between like elements, or from a grouping; otherwise an association says "contains".
      const whole = ARCHIMATE_ELEMENT[parent.typeId] === "Grouping" || ARCHIMATE_ELEMENT[parent.typeId] === ARCHIMATE_ELEMENT[o.typeId];
      relationships.push(
        `<relationship identifier="${xid("id", `in-${o.id}`)}" source="${xid("id", parent.id)}" target="${xid("id", o.id)}" xsi:type="${whole ? "Composition" : "Association"}">${whole ? "" : named("name", "contains")}${props([[PROPS.kind, "contains"]])}</relationship>`,
      );
    }
  }
  for (const r of Object.values(ws.relationships)) {
    if (!ws.objects[r.sourceId] || !ws.objects[r.targetId]) continue;
    // "A calls B" is, in ArchiMate, "B serves A". Copying data is a flow in the direction it travels.
    const flow = r.kind === "replicates_to" || r.kind === "routes_to" || r.kind === "flows_to";
    const [from, to] = flow ? [r.sourceId, r.targetId] : [r.targetId, r.sourceId];
    relationshipIds.set(r.id, xid("id", r.id));
    relationships.push(
      `<relationship identifier="${xid("id", r.id)}" source="${xid("id", from)}" target="${xid("id", to)}" xsi:type="${r.kind === "flows_to" ? "Triggering" : flow ? "Flow" : "Serving"}">${named("name", r.label || RELATION_KIND_INFO[r.kind].verb)}${named("documentation", r.description)}${props([
        [PROPS.kind, r.kind],
        [PROPS.protocol, r.protocol],
        [PROPS.port, r.port],
      ])}</relationship>`,
    );
  }

  const fieldNames = [...new Set(objects.flatMap((o) => Object.keys(o.fields)))];
  const definitions = [...Object.values(PROPS), ...fieldNames].map((key) => `<propertyDefinition identifier="${xid("prop", key)}" type="string"><name>${escapeXml(key)}</name></propertyDefinition>`);

  const views = Object.values(ws.diagrams)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const shown = Object.keys(d.nodes).filter((id) => ws.objects[id]);
      const node = (id: string) => xid("node", `${d.id}-${id}`);
      const nodes = shown.map((id) => `<node identifier="${node(id)}" elementRef="${xid("id", id)}" xsi:type="Element" x="${Math.round(d.nodes[id].x)}" y="${Math.round(d.nodes[id].y)}" w="200" h="72"/>`);
      const connections = Object.values(ws.relationships)
        .filter((r) => relationshipIds.has(r.id) && shown.includes(r.sourceId) && shown.includes(r.targetId) && !d.hiddenRelationshipIds.includes(r.id))
        .map((r) => {
          const flow = r.kind === "replicates_to" || r.kind === "routes_to" || r.kind === "flows_to";
          const [from, to] = flow ? [r.sourceId, r.targetId] : [r.targetId, r.sourceId];
          return `<connection identifier="${xid("conn", `${d.id}-${r.id}`)}" relationshipRef="${xid("id", r.id)}" xsi:type="Relationship" source="${node(from)}" target="${node(to)}"/>`;
        });
      return `<view identifier="${xid("view", d.id)}" xsi:type="Diagram">${named("name", d.name || "Diagram")}${named("documentation", d.description)}${nodes.join("")}${connections.join("")}</view>`;
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengroup.org/xsd/archimate/3.0/ http://www.opengroup.org/xsd/archimate/3.1/archimate3_Diagram.xsd" identifier="${xid("model", "archone")}">`,
    named("name", ws.name || "Model"),
    lines.length ? `<elements>${lines.join("")}</elements>` : "",
    relationships.length ? `<relationships>${relationships.join("")}</relationships>` : "",
    `<propertyDefinitions>${definitions.join("")}</propertyDefinitions>`,
    views.length ? `<views><diagrams>${views.join("")}</diagrams></views>` : "",
    "</model>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** True when the text looks like an ArchiMate exchange file rather than, say, a draw.io file. */
export const isArchimate = (source: string) => /<model[^>]*opengroup\.org\/xsd\/archimate/.test(source.slice(0, 4000));

const direct = (node: XmlNode, name: string) => node.children.find((c) => c.name === name);
const label = (node: XmlNode, name: string) => allText(direct(node, name) ?? { name: "", attrs: {}, children: [], text: "" }).replace(/\s+/g, " ").trim();

/**
 * An ArchiMate exchange file as the two sheets a spreadsheet import takes, so it goes
 * through the same review. Elements that share a name become one object.
 */
export function readArchimate(source: string): Sheet[] {
  let root: XmlNode | null = null;
  try {
    root = parseXml(source);
  } catch {
    root = null;
  }
  if (!root || root.name !== "model") throw new ImportError("This file is not an ArchiMate exchange file. Export the model from your tool as an Open Group ArchiMate Model Exchange File (.xml).");
  const definitions = new Map<string, string>();
  for (const d of descendants(root, "propertyDefinition")) definitions.set(d.attrs.identifier ?? "", label(d, "name"));
  const properties = (node: XmlNode) => {
    const out = new Map<string, string>();
    for (const p of descendants(direct(node, "properties") ?? { name: "", attrs: {}, children: [], text: "" }, "property")) out.set(definitions.get(p.attrs.propertyDefinitionRef ?? "") ?? "", label(p, "value"));
    return out;
  };

  const elements = new Map<string, { name: string; typeId: string; description: string; props: Map<string, string>; parent: string }>();
  for (const e of descendants(direct(root, "elements") ?? root, "element")) {
    const p = properties(e);
    const name = label(e, "name");
    if (!e.attrs.identifier || !name) continue;
    const stated = p.get(PROPS.type) ?? "";
    elements.set(e.attrs.identifier, { name, typeId: ARCHIMATE_ELEMENT[stated] ? stated : (FROM_ELEMENT[e.attrs.type ?? ""] ?? "application"), description: label(e, "documentation"), props: p, parent: "" });
  }
  if (!elements.size) throw new ImportError("This ArchiMate file holds no elements with a name.");

  const KINDS = Object.keys(RELATION_KIND_INFO) as RelationKind[];
  const rows: string[][] = [];
  for (const r of descendants(direct(root, "relationships") ?? root, "relationship")) {
    const from = elements.get(r.attrs.source ?? "");
    const to = elements.get(r.attrs.target ?? "");
    if (!from || !to || from === to) continue;
    const p = properties(r);
    const type = r.attrs.type ?? "";
    const stated = p.get(PROPS.kind) ?? "";
    if (stated === "contains" || ((type === "Composition" || type === "Aggregation") && !stated)) {
      // Whole and part: the part sits inside the whole, when the levels allow it.
      if (!to.parent && objectType(from.typeId).level < objectType(to.typeId).level) to.parent = from.name;
      continue;
    }
    const kind: RelationKind = KINDS.includes(stated as RelationKind) ? (stated as RelationKind) : type === "Flow" ? "calls" : type === "Triggering" ? "flows_to" : "depends_on";
    // Serving, and an assignment or realization of something by its platform, point from the provider to the user.
    const reversed = type === "Serving" || (!stated && (type === "Assignment" || type === "Realization"));
    const [source, target] = reversed ? [to, from] : [from, to];
    const text = label(r, "name");
    rows.push([source.name, target.name, RELATION_KIND_INFO[kind].label, text === RELATION_KIND_INFO[kind].verb ? "" : text, p.get(PROPS.protocol) ?? "", p.get(PROPS.port) ?? "", label(r, "documentation")]);
  }

  const lifecycles = ["planned", "active", "deprecated", "retired"];
  return [
    {
      name: "Objects",
      rows: [
        OBJECT_FIELDS.map((f) => f.label),
        ...[...elements.values()].map((e) => [e.name, objectType(e.typeId).label, e.description, e.props.get(PROPS.owner) ?? "", lifecycles.includes(e.props.get(PROPS.lifecycle) ?? "") ? e.props.get(PROPS.lifecycle)! : "", e.props.get(PROPS.technology) ?? "", e.props.get(PROPS.tags) ?? "", e.parent]),
      ],
    },
    { name: "Relationships", rows: [RELATIONSHIP_FIELDS.map((f) => f.label), ...rows] },
  ];
}
