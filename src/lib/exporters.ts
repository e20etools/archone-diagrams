import { LIFECYCLE_INFO, RELATION_KIND_INFO, objectType } from "./catalog";
import { diagramsUsing } from "./model";
import type { Diagram, ModelObject, Relationship, Workspace } from "./types";
import { scopeMembers, visibleEdges, type ViewEdge } from "./views";

/** Text exports: CSV and JSON for data, Mermaid and PlantUML for code (PRD FR-32). Image exports live in exportImage.ts. */

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "diagram";

export function diagramObjects(ws: Workspace, diagram: Diagram): ModelObject[] {
  return Object.keys(diagram.nodes)
    .map((id) => ws.objects[id])
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Relationships whose two ends are both on the diagram. */
export function diagramRelationships(ws: Workspace, diagram: Diagram): Relationship[] {
  const ids = new Set(visibleEdges(ws, diagram).flatMap((e) => e.relationshipIds));
  return [...ids].map((id) => ws.relationships[id]).filter(Boolean);
}

/* ---------- CSV ---------- */

export function csvCell(value: string): string {
  // A leading =, +, - or @ would be run as a formula by spreadsheet apps; an apostrophe keeps it as text.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const originLabel: Record<string, string> = {
  manual: "Entered by hand",
  "ai-prompt": "AI draft from text",
  "ai-image": "AI draft from image",
  import: "Imported",
  api: "Created through the API",
  demo: "Demo data",
};

export function objectsCsv(ws: Workspace, objects: ModelObject[]): string {
  const header = ["ID", "Name", "Type", "Level", "Part of", "Owner", "Lifecycle", "Technology", "Tags", "Description", "Origin", "Approved by", "Used in diagrams"];
  const rows = objects.map((o) => {
    const type = objectType(o.typeId);
    return [
      o.id,
      o.name,
      type.label,
      String(type.level),
      o.parentId ? (ws.objects[o.parentId]?.name ?? "") : "",
      o.owner,
      LIFECYCLE_INFO[o.lifecycle].label,
      o.technology,
      o.tags.join("; "),
      o.description,
      originLabel[o.provenance.origin] ?? o.provenance.origin,
      o.provenance.approvedBy ?? "",
      diagramsUsing(ws, o.id).map((d) => d.name).join("; "),
    ];
  });
  return toCsv([header, ...rows]);
}

export function relationshipsCsv(ws: Workspace, relationships: Relationship[]): string {
  const header = ["ID", "From", "Kind", "To", "Label", "Protocol", "Port", "Description", "Origin", "Approved by"];
  const rows = relationships.map((r) => [
    r.id,
    ws.objects[r.sourceId]?.name ?? "",
    RELATION_KIND_INFO[r.kind].label,
    ws.objects[r.targetId]?.name ?? "",
    r.label,
    r.protocol,
    r.port,
    r.description,
    originLabel[r.provenance.origin] ?? r.provenance.origin,
    r.provenance.approvedBy ?? "",
  ]);
  return toCsv([header, ...rows]);
}

/* ---------- JSON ---------- */

export function diagramJson(ws: Workspace, diagram: Diagram): string {
  return JSON.stringify(
    {
      format: "archone-diagram",
      version: 1,
      exportedAt: new Date().toISOString(),
      diagram,
      objects: diagramObjects(ws, diagram),
      relationships: diagramRelationships(ws, diagram),
    },
    null,
    2,
  );
}

export function workspaceJson(ws: Workspace): string {
  return JSON.stringify({ format: "archone-workspace", ...ws }, null, 2);
}

/* ---------- diagram as code ---------- */

const edgeText = (e: ViewEdge) => e.label.trim() || RELATION_KIND_INFO[e.kind].verb;

function aliases(objects: ModelObject[]): Map<string, string> {
  return new Map(objects.map((o, i) => [o.id, `n${i + 1}`]));
}

const mermaidText = (s: string) => s.replace(/"/g, "#quot;").replace(/[\r\n]+/g, " ");

function mermaidNode(alias: string, o: ModelObject): string {
  const type = objectType(o.typeId);
  const label = `"${mermaidText(o.name)}<br/>${mermaidText(type.label)}"`;
  if (type.category === "data") return `${alias}[(${label})]`;
  if (type.id === "actor") return `${alias}([${label}])`;
  if (type.id === "queue") return `${alias}[[${label}]]`;
  return `${alias}[${label}]`;
}

export function toMermaid(ws: Workspace, diagram: Diagram): string {
  const objects = diagramObjects(ws, diagram);
  const alias = aliases(objects);
  const inside = new Set(scopeMembers(ws, diagram));
  const lines = [`flowchart ${diagram.direction}`];
  const scope = diagram.scopeId ? ws.objects[diagram.scopeId] : undefined;
  if (scope && inside.size) {
    lines.push(`  subgraph scope["${mermaidText(scope.name)}"]`);
    for (const o of objects) if (inside.has(o.id)) lines.push(`    ${mermaidNode(alias.get(o.id)!, o)}`);
    lines.push("  end");
  }
  for (const o of objects) if (!inside.has(o.id)) lines.push(`  ${mermaidNode(alias.get(o.id)!, o)}`);
  for (const e of visibleEdges(ws, diagram)) {
    const s = alias.get(e.sourceId);
    const t = alias.get(e.targetId);
    if (!s || !t) continue;
    lines.push(`  ${s} ${e.implied ? "-.->" : "-->"}|"${mermaidText(edgeText(e))}"| ${t}`);
  }
  return lines.join("\n") + "\n";
}

const pumlText = (s: string) => s.replace(/"/g, "'").replace(/[\r\n]+/g, " ");

function pumlKeyword(o: ModelObject): string {
  const type = objectType(o.typeId);
  if (type.id === "actor") return "actor";
  if (type.id === "queue") return "queue";
  if (type.category === "data") return "database";
  if (type.id === "external-system") return "cloud";
  if (type.id === "server" || type.id === "cluster") return "node";
  return "rectangle";
}

export function toPlantUml(ws: Workspace, diagram: Diagram): string {
  const objects = diagramObjects(ws, diagram);
  const alias = aliases(objects);
  const inside = new Set(scopeMembers(ws, diagram));
  const element = (o: ModelObject, indent: string) =>
    `${indent}${pumlKeyword(o)} "${pumlText(o.name)}\\n[${pumlText(objectType(o.typeId).label)}]" as ${alias.get(o.id)}`;
  const lines = ["@startuml", `title ${pumlText(diagram.name)}`, "skinparam shadowing false"];
  if (diagram.direction === "LR") lines.push("left to right direction");
  const scope = diagram.scopeId ? ws.objects[diagram.scopeId] : undefined;
  if (scope && inside.size) {
    lines.push(`package "${pumlText(scope.name)}" {`);
    for (const o of objects) if (inside.has(o.id)) lines.push(element(o, "  "));
    lines.push("}");
  }
  for (const o of objects) if (!inside.has(o.id)) lines.push(element(o, ""));
  for (const e of visibleEdges(ws, diagram)) {
    const s = alias.get(e.sourceId);
    const t = alias.get(e.targetId);
    if (!s || !t) continue;
    lines.push(`${s} ${e.implied ? "..>" : "-->"} ${t} : ${pumlText(edgeText(e))}`);
  }
  lines.push("@enduml");
  return lines.join("\n") + "\n";
}

/* ---------- download helpers (browser) ---------- */

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename: string, text: string, mime = "text/plain") {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}
