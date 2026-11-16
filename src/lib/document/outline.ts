import { ADR_STATUS_LABEL, adrLabel, sortedAdrs } from "../adr";
import { LIFECYCLE_INFO, RELATION_KIND_INFO, VIEW_TYPE_INFO, objectType } from "../catalog";
import { ruleById, rulesRun as rulesRun_, runChecks, type PackId, type Severity } from "../checks/checks";
import { diagramObjects, diagramRelationships } from "../exporters";
import { flowsOf, stepRoute } from "../flows";
import { trustFacts, type TrustFacts } from "../trust";
import type { Workspace } from "../types";

/**
 * The architecture document, as plain content: what it says, before it is laid out as a
 * Word file or as slides. Everything in it is read from the model at the moment of export.
 */

export interface DocOptions {
  title: string;
  /** In the order they should appear. */
  diagramIds: string[];
  inventory: boolean;
  decisions: boolean;
  /** Rule packs to report findings for; none leaves the section out. */
  packs: PackId[];
  data: boolean;
}

export interface DocDiagram {
  id: string;
  name: string;
  view: string;
  description: string;
  elements: { name: string; type: string; owner: string; description: string }[];
  connections: { from: string; to: string; what: string }[];
  /** The use cases told over this diagram, each as its steps in order. */
  flows: { name: string; description: string; steps: { route: string; text: string }[] }[];
}
export interface DocOutline {
  title: string;
  workspace: string;
  author: string;
  /** "16 November 2026" */
  date: string;
  counts: { label: string; value: number }[];
  diagrams: DocDiagram[];
  inventory: { name: string; type: string; owner: string; lifecycle: string; technology: string }[] | null;
  decisions: { label: string; title: string; status: string; date: string; context: string; decision: string; consequences: string; about: string }[] | null;
  findings: { severity: Severity; title: string; why: string; count: number; examples: string[] }[] | null;
  /** How many rules were run for the findings section. */
  rulesRun: number;
  data: TrustFacts | null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const EXAMPLES = 3;

export function buildOutline(ws: Workspace, options: DocOptions, at = new Date()): DocOutline {
  const diagrams: DocDiagram[] = options.diagramIds
    .map((id) => ws.diagrams[id])
    .filter(Boolean)
    .map((d) => ({
      id: d.id,
      name: d.name,
      view: VIEW_TYPE_INFO[d.viewType].label,
      description: d.description.trim(),
      elements: diagramObjects(ws, d).map((o) => ({ name: o.name, type: objectType(o.typeId).label, owner: o.owner.trim(), description: o.description.trim() })),
      connections: diagramRelationships(ws, d)
        .map((r) => ({
          from: ws.objects[r.sourceId]?.name ?? "",
          to: ws.objects[r.targetId]?.name ?? "",
          what: [RELATION_KIND_INFO[r.kind].label, r.label.trim(), r.protocol.trim()].filter(Boolean).join(", "),
        }))
        .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
      flows: flowsOf(d)
        .filter((f) => f.steps.length > 0)
        .map((f) => ({ name: f.name, description: f.description, steps: f.steps.map((s) => ({ route: stepRoute(ws, s), text: s.text })) })),
    }));

  const objects = Object.values(ws.objects);
  let findings: DocOutline["findings"] = null;
  let rulesRun = 0;
  if (options.packs.length) {
    const byRule = new Map<string, { severity: Severity; messages: string[] }>();
    for (const f of runChecks(ws, null, options.packs)) {
      const entry = byRule.get(f.ruleId) ?? { severity: f.severity, messages: [] };
      entry.messages.push(f.message);
      byRule.set(f.ruleId, entry);
    }
    findings = [...byRule].map(([ruleId, entry]) => ({ severity: entry.severity, title: ruleById(ruleId, ws)?.title ?? ruleId, why: ruleById(ruleId, ws)?.why ?? "", count: entry.messages.length, examples: entry.messages.slice(0, EXAMPLES) }));
    rulesRun = rulesRun_(options.packs, ws);
  }

  const adrs = sortedAdrs(ws);
  return {
    title: options.title.trim() || `${ws.name}: architecture`,
    workspace: ws.name,
    author: ws.userName.trim(),
    date: day(at.toISOString()),
    counts: [
      { label: "Objects", value: objects.length },
      { label: "Relationships", value: Object.keys(ws.relationships).length },
      { label: "Diagrams", value: Object.keys(ws.diagrams).length },
      { label: "Decisions", value: adrs.length },
    ],
    diagrams,
    inventory: options.inventory
      ? objects
          .map((o) => ({ name: o.name, type: objectType(o.typeId).label, owner: o.owner.trim(), lifecycle: LIFECYCLE_INFO[o.lifecycle].label, technology: o.technology.trim() }))
          .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
      : null,
    decisions: options.decisions
      ? adrs.map((a) => ({
          label: adrLabel(a),
          title: a.title,
          status: ADR_STATUS_LABEL[a.status],
          date: day(a.decidedAt ?? a.createdAt),
          context: a.context.trim(),
          decision: a.decision.trim(),
          consequences: a.consequences.trim(),
          about: a.objectIds.map((id) => ws.objects[id]?.name).filter(Boolean).join(", "),
        }))
      : null,
    findings,
    rulesRun,
    data: options.data ? trustFacts(ws) : null,
  };
}

/** A file name for the export: the title, made safe, with the date. */
export function documentFileName(outline: Pick<DocOutline, "title">, at = new Date()): string {
  const slug = outline.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "architecture";
  return `${slug}-${at.toISOString().slice(0, 10)}`;
}

/** The picture of one diagram, as the canvas drew it. */
export interface DocImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** The largest size that fits the box and keeps the picture's shape. */
export function fit(image: { width: number; height: number }, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1e9);
  return { width: image.width * scale, height: image.height * scale };
}
