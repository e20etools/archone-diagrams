import { OBJECT_TYPES, RELATION_KIND_INFO, isKnownType, objectType } from "../catalog";
import { NODE_H, NODE_W } from "../layout";
import { findByName, newId, normalizeName, nowIso } from "../model";
import { LIFECYCLES, RELATION_KINDS, type Lifecycle, type Proposal, type ProposedObject, type ProposedRelationship, type RelationKind, type Workspace } from "../types";
import { guessKind, guessType, nestByGeometry, type ImportedPage } from "./diagramFile";
import type { TextModel } from "./mermaid";
import type { Sheet } from "./xlsx";

/**
 * Turns an imported file into a draft for review. Like an AI draft, nothing reaches the model
 * until a person accepts it, and every accepted item records the file it came from.
 */

export const IMPORT_ENGINE = { spreadsheet: "Spreadsheet import", visio: "Visio import", drawio: "draw.io import", mermaid: "Mermaid import", structurizr: "Structurizr import" } as const;
export type ImportKind = keyof typeof IMPORT_ENGINE;

const MAX_OBJECTS = 3000;
const MAX_RELATIONSHIPS = 6000;
export class ImportError extends Error {}

function proposal(ws: Workspace, kind: ImportKind, fileName: string, notes: string, objects: ProposedObject[], relationships: ProposedRelationship[], extra: Partial<Proposal>): Proposal {
  if (objects.length > MAX_OBJECTS || relationships.length > MAX_RELATIONSHIPS) {
    throw new ImportError(`This file holds more than ${MAX_OBJECTS} objects or ${MAX_RELATIONSHIPS} relationships. Import it in smaller parts.`);
  }
  return {
    id: newId("prop"),
    origin: "import",
    importKind: kind,
    source: fileName,
    engine: IMPORT_ENGINE[kind],
    notes,
    createdAt: nowIso(),
    status: "pending",
    targetDiagramId: null,
    objects: objects.map((o) => ({ ...o, matchId: findByName(ws, o.name)?.id ?? null })),
    relationships,
    ...extra,
  };
}

const sentence = (parts: (string | false | 0 | undefined)[]) => parts.filter(Boolean).join(" ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- diagram files ---------- */

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** One page of a Visio or draw.io file as a draft: an object per labelled shape, a relationship per connector, boxes placed as drawn. */
export function pageToProposal(ws: Workspace, page: ImportedPage, kind: "visio" | "drawio", fileName: string): Proposal {
  const shapes = nestByGeometry(page.shapes);
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const childrenOf = new Map<string, string[]>();
  for (const s of shapes) if (s.parentId) childrenOf.set(s.parentId, [...(childrenOf.get(s.parentId) ?? []), s.id]);
  // How many levels of shapes sit inside a shape decides how high in the model it belongs.
  const depthBelow = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return Math.max(0, ...(childrenOf.get(id) ?? []).map((c) => 1 + depthBelow(c, seen)));
  };

  // Boxes here are one size, so the drawing is stretched until shapes of its usual size no longer touch.
  const leaves = shapes.filter((s) => !childrenOf.has(s.id));
  const scaleX = clamp((NODE_W + 44) / (median(leaves.map((s) => s.width)) || NODE_W), 0.5, 4);
  const scaleY = clamp((NODE_H + 52) / (median(leaves.map((s) => s.height)) || NODE_H), 0.5, 4);
  const left = Math.min(...leaves.map((s) => s.x + s.width / 2), Infinity);
  const top = Math.min(...leaves.map((s) => s.y + s.height / 2), Infinity);

  // The same name twice on a page is the same thing drawn twice: one object, placed where it first appears.
  const keyByName = new Map<string, string>();
  const keyOf = new Map<string, string>();
  const objects: ProposedObject[] = [];
  let repeated = 0;
  for (const shape of shapes) {
    const [first, ...rest] = shape.text.split("\n");
    const name = first.length > 90 ? `${first.slice(0, 88).trimEnd()}…` : first;
    const known = keyByName.get(normalizeName(name));
    if (known) {
      keyOf.set(shape.id, known);
      repeated += 1;
      continue;
    }
    const key = `o${objects.length + 1}`;
    keyByName.set(normalizeName(name), key);
    keyOf.set(shape.id, key);
    const depth = depthBelow(shape.id);
    const guessed = guessType(shape.hint, shape.text);
    const typeId = depth >= 2 ? "domain" : depth === 1 ? (guessed && objectType(guessed).level <= 2 && guessed !== "actor" ? guessed : "system") : (guessed ?? "application");
    const isLeaf = depth === 0;
    objects.push({
      key,
      name,
      typeId,
      description: [first.length > 90 ? first : "", ...rest].filter(Boolean).join(" ").slice(0, 2000),
      technology: "",
      parentKey: null,
      decision: "pending",
      matchId: null,
      // A shape that encloses others is the frame around them, not a box of its own.
      ...(isLeaf ? { x: Math.round((shape.x + shape.width / 2 - left) * scaleX), y: Math.round((shape.y + shape.height / 2 - top) * scaleY) } : {}),
    });
  }
  for (const shape of shapes) {
    const own = objects.find((o) => o.key === keyOf.get(shape.id));
    const parentKey = shape.parentId ? keyOf.get(shape.parentId) : undefined;
    const parent = objects.find((o) => o.key === parentKey);
    if (own && parent && own !== parent && !own.parentKey && objectType(parent.typeId).level < objectType(own.typeId).level) own.parentKey = parent.key;
  }

  const seen = new Set<string>();
  const relationships: ProposedRelationship[] = [];
  for (const connector of page.connectors) {
    const sourceKey = keyOf.get(connector.sourceId);
    const targetKey = keyOf.get(connector.targetId);
    if (!sourceKey || !targetKey || sourceKey === targetKey || !byId.has(connector.sourceId)) continue;
    const typeOf = (key: string) => objects.find((o) => o.key === key)!.typeId;
    const relationKind = guessKind(connector.text, typeOf(sourceKey), typeOf(targetKey));
    const label = connector.text.replace(/\s+/g, " ").slice(0, 200);
    const signature = `${sourceKey}>${targetKey}>${relationKind}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    relationships.push({ key: `r${relationships.length + 1}`, sourceKey, targetKey, kind: relationKind, label, decision: "pending" });
  }

  const { unlabelled, loose, notes: textNotes } = page.skipped;
  const notes = sentence([
    `Page "${page.name}".`,
    "Types and relationship kinds are guessed from the shapes and labels; check them before accepting.",
    repeated > 0 && `${plural(repeated, "shape")} repeated a name already on the page and ${repeated === 1 ? "was" : "were"} merged into one object.`,
    unlabelled > 0 && `Left out: ${plural(unlabelled, "shape")} without a label.`,
    loose > 0 && `Left out: ${plural(loose, "connector")} not attached to a labelled shape at both ends.`,
    textNotes > 0 && `Left out: ${plural(textNotes, "text note")}.`,
  ]);
  if (!objects.length) throw new ImportError(`The page "${page.name}" has no labelled shapes to import.`);
  return proposal(ws, kind, fileName, notes, objects, relationships, { placeAsDrawn: true });
}

/* ---------- diagrams written as text ---------- */

/** A Mermaid or Structurizr file as a draft. The file gives no positions, so the new diagram is laid out afresh. */
export function textModelToProposal(ws: Workspace, model: TextModel, kind: "mermaid" | "structurizr", fileName: string): Proposal {
  // The same name twice is the same thing written twice: one object.
  const keyByName = new Map<string, string>();
  const keyOf = new Map<string, string>();
  const objects: ProposedObject[] = [];
  let repeated = 0;
  for (const element of model.elements) {
    const name = (element.name.trim() || element.id).slice(0, 300);
    const known = keyByName.get(normalizeName(name));
    if (known) {
      keyOf.set(element.id, known);
      repeated += 1;
      continue;
    }
    const key = `o${objects.length + 1}`;
    keyByName.set(normalizeName(name), key);
    keyOf.set(element.id, key);
    objects.push({
      key,
      name,
      typeId: isKnownType(element.typeId) ? element.typeId : "application",
      description: element.description.slice(0, 2000),
      technology: element.technology.slice(0, 300),
      parentKey: null,
      decision: "pending",
      matchId: null,
      ...(element.tags.length ? { tags: element.tags.slice(0, 30) } : {}),
    });
  }
  const byKey = new Map(objects.map((o) => [o.key, o]));
  let flattened = 0;
  for (const element of model.elements) {
    if (!element.parentId) continue;
    const own = byKey.get(keyOf.get(element.id) ?? "");
    // A parent has to sit on a higher level; where the file nests otherwise, the nearest ancestor that does is used.
    let parentId: string | null = element.parentId;
    const seen = new Set<string>();
    while (own && !own.parentKey && parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byKey.get(keyOf.get(parentId) ?? "");
      if (parent && parent !== own && objectType(parent.typeId).level < objectType(own.typeId).level) own.parentKey = parent.key;
      else parentId = model.elements.find((e) => e.id === parentId)?.parentId ?? null;
    }
    if (own && !own.parentKey) flattened += 1;
  }

  const seen = new Set<string>();
  const relationships: ProposedRelationship[] = [];
  let loose = 0;
  for (const link of model.links) {
    const sourceKey = keyOf.get(link.sourceId);
    const targetKey = keyOf.get(link.targetId);
    if (!sourceKey || !targetKey) {
      loose += 1;
      continue;
    }
    if (sourceKey === targetKey) continue;
    const relationKind = link.kind ?? guessKind(`${link.label} ${link.technology}`, byKey.get(sourceKey)!.typeId, byKey.get(targetKey)!.typeId);
    const signature = `${sourceKey}>${targetKey}>${relationKind}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    relationships.push({
      key: `r${relationships.length + 1}`,
      sourceKey,
      targetKey,
      kind: relationKind,
      label: link.label.replace(/\s+/g, " ").slice(0, 200),
      decision: "pending",
      ...(link.technology ? { protocol: link.technology.slice(0, 60) } : {}),
    });
  }

  const notes = sentence([
    model.title && `"${model.title}".`,
    kind === "mermaid"
      ? "Types and relationship kinds are guessed from the shapes and labels; check them before accepting."
      : "Relationship kinds are guessed from their descriptions; check them before accepting.",
    "The file does not say where boxes sit, so the diagram is laid out afresh.",
    repeated > 0 && `${plural(repeated, "element")} repeated a name already in the file and ${repeated === 1 ? "was" : "were"} merged into one object.`,
    flattened > 0 && `${plural(flattened, "element")} could not keep ${flattened === 1 ? "its" : "their"} place inside another, because the model nests domains, systems, applications and components in that order.`,
    loose > 0 && `Left out: ${plural(loose, "link")} to something that is not in the file.`,
    model.skipped.length > 0 && `Also: ${model.skipped.join("; ")}.`,
  ]);
  if (!objects.length) throw new ImportError("The file has nothing to import.");
  return proposal(ws, kind, fileName, notes, objects, relationships, {});
}

/* ---------- spreadsheets ---------- */

export type SheetRole = "objects" | "relationships" | "skip";
export interface FieldInfo {
  id: string;
  label: string;
  required?: boolean;
  /** Column headings that mean this field, compared without case, spaces or punctuation. */
  headings: string[];
}
export const OBJECT_FIELDS: FieldInfo[] = [
  { id: "name", label: "Name", required: true, headings: ["name", "object", "objectname", "component", "componentname", "application", "applicationname", "system", "systemname", "title", "ciname", "asset", "assetname", "service"] },
  { id: "type", label: "Type", headings: ["type", "objecttype", "kind", "category", "class", "citype"] },
  { id: "description", label: "Description", headings: ["description", "desc", "summary", "notes", "note", "comment", "comments", "purpose"] },
  { id: "owner", label: "Owner", headings: ["owner", "ownedby", "owners", "responsible", "team", "businessowner", "productowner", "contact", "owningteam"] },
  { id: "lifecycle", label: "Lifecycle", headings: ["lifecycle", "lifecyclestatus", "status", "state", "phase", "stage"] },
  { id: "technology", label: "Technology", headings: ["technology", "tech", "stack", "techstack", "platform", "product", "runtime", "language"] },
  { id: "tags", label: "Tags", headings: ["tags", "tag", "labels", "keywords"] },
  { id: "parent", label: "Inside", headings: ["inside", "parent", "partof", "belongsto", "container", "group", "domain", "parentname"] },
];
export const RELATIONSHIP_FIELDS: FieldInfo[] = [
  { id: "from", label: "From", required: true, headings: ["from", "source", "sourcename", "consumer", "caller", "start", "fromobject", "fromname"] },
  { id: "to", label: "To", required: true, headings: ["to", "target", "targetname", "destination", "provider", "callee", "end", "toobject", "toname"] },
  { id: "kind", label: "Kind", headings: ["kind", "type", "relationship", "relationshiptype", "relation", "relationtype"] },
  { id: "label", label: "Label", headings: ["label", "name", "title", "what"] },
  { id: "protocol", label: "Protocol", headings: ["protocol", "interface", "transport"] },
  { id: "port", label: "Port", headings: ["port", "ports"] },
  { id: "description", label: "Description", headings: ["description", "desc", "notes", "note", "comment", "comments"] },
];
export const fieldsOf = (role: SheetRole) => (role === "objects" ? OBJECT_FIELDS : role === "relationships" ? RELATIONSHIP_FIELDS : []);

export interface SheetMapping {
  role: SheetRole;
  /** For each field id, the index of the column that holds it, or null when the sheet has no such column. */
  columns: Record<string, number | null>;
}

const squash = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9]+/g, "");

function mapColumns(headings: string[], fields: FieldInfo[]): Record<string, number | null> {
  const squashed = headings.map(squash);
  // A heading of a few words can contain a known one ("Application name (short)"); a sentence is not a heading.
  const short = headings.map((h) => h.trim().split(/\s+/).length <= 4);
  const taken = new Set<number>();
  const columns: Record<string, number | null> = {};
  // Exact heading matches first, so "Type" is not claimed by a field that merely contains the word.
  for (const pass of ["exact", "contains"] as const) {
    for (const field of fields) {
      if (columns[field.id] !== undefined && columns[field.id] !== null) continue;
      const index = squashed.findIndex((h, i) => !taken.has(i) && h !== "" && (pass === "exact" ? field.headings.includes(h) : short[i] && field.headings.some((known) => known.length >= 4 && h.includes(known))));
      columns[field.id] = index >= 0 ? index : null;
      if (index >= 0) taken.add(index);
    }
  }
  return columns;
}

/** A first guess at what a sheet holds and which column is which, from its first row. The person corrects it in the dialog. */
export function guessMapping(sheet: Sheet): SheetMapping {
  const headings = sheet.rows[0] ?? [];
  const asRelationships = mapColumns(headings, RELATIONSHIP_FIELDS);
  if (asRelationships.from !== null && asRelationships.to !== null) return { role: "relationships", columns: asRelationships };
  const asObjects = mapColumns(headings, OBJECT_FIELDS);
  if (asObjects.name !== null) return { role: "objects", columns: asObjects };
  return { role: "skip", columns: {} };
}

/** The same sheet read as a different kind of thing. */
export function remap(sheet: Sheet, role: SheetRole): SheetMapping {
  return { role, columns: role === "skip" ? {} : mapColumns(sheet.rows[0] ?? [], fieldsOf(role)) };
}

const TYPE_BY_NAME = new Map<string, string>(OBJECT_TYPES.flatMap((t) => [[squash(t.id), t.id], [squash(t.label), t.id]] as [string, string][]));
/** The object type a cell names: an exact type name first, then a guess from the words. */
export function typeFromCell(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  return TYPE_BY_NAME.get(squash(text)) ?? guessType("", text);
}

const LIFECYCLE_WORDS: [Lifecycle, RegExp][] = [
  ["retired", /\b(retired|decommissioned|end of life|eol|removed|switched off|sunset)\b/],
  ["deprecated", /\b(deprecated|phase out|phasing out|phase-out|legacy|to be retired|sunsetting|contain|tolerate)\b/],
  ["planned", /\b(planned|plan|proposed|future|pipeline|in development|build|new)\b/],
  ["active", /\b(active|live|production|prod|in use|in service|current|operational|invest|run)\b/],
];
export function lifecycleFromCell(value: string): Lifecycle | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  return (LIFECYCLES as readonly string[]).includes(text) ? (text as Lifecycle) : (LIFECYCLE_WORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? null);
}

const KIND_BY_NAME = new Map<string, RelationKind>(RELATION_KINDS.flatMap((k) => [[squash(k), k], [squash(RELATION_KIND_INFO[k].label), k]] as [string, RelationKind][]));

export interface SheetReport {
  objectRows: number;
  relationshipRows: number;
  /** Rows left out, with the reason, at most 50 of them. */
  skipped: { sheet: string; row: number; reason: string }[];
  skippedCount: number;
  /** Type cells that matched no type; those rows get the fallback type. */
  unknownTypes: string[];
  /** Objects named only as a parent or as an end of a relationship, added so nothing dangles. */
  implied: number;
}

/**
 * Builds the draft from the mapped sheets. Rows with the same name are one object. An object
 * that is only named as a parent or in a relationship is added too, with the fallback type,
 * unless the model already holds it.
 */
export function sheetsToProposal(ws: Workspace, sheets: Sheet[], mappings: SheetMapping[], fileName: string, fallbackTypeId = "application"): { proposal: Proposal; report: SheetReport } {
  const report: SheetReport = { objectRows: 0, relationshipRows: 0, skipped: [], skippedCount: 0, unknownTypes: [], implied: 0 };
  const skip = (sheet: string, row: number, reason: string) => {
    report.skippedCount += 1;
    if (report.skipped.length < 50) report.skipped.push({ sheet, row, reason });
  };
  const fallback = isKnownType(fallbackTypeId) ? fallbackTypeId : "application";
  const objects: ProposedObject[] = [];
  const byName = new Map<string, ProposedObject>();
  const parentNames = new Map<string, string>();
  const unknownTypes = new Set<string>();

  const ensure = (name: string, listed = false): ProposedObject => {
    const known = byName.get(normalizeName(name));
    if (known) return known;
    const existing = findByName(ws, name);
    if (!existing && !listed) report.implied += 1;
    const made: ProposedObject = { key: `o${objects.length + 1}`, name: existing?.name ?? name, typeId: existing?.typeId ?? fallback, description: "", technology: "", parentKey: null, decision: "pending", matchId: null, provided: [] };
    objects.push(made);
    byName.set(normalizeName(name), made);
    return made;
  };

  sheets.forEach((sheet, index) => {
    const mapping = mappings[index];
    if (!mapping || mapping.role !== "objects" || mapping.columns.name == null) return;
    const cell = (row: string[], field: string) => (mapping.columns[field] == null ? "" : (row[mapping.columns[field]!] ?? "").trim());
    sheet.rows.slice(1).forEach((row, r) => {
      const name = cell(row, "name").replace(/\s+/g, " ").slice(0, 200);
      if (!name) return skip(sheet.name, r + 2, "No name");
      report.objectRows += 1;
      const object = ensure(name, true);
      const provided = new Set(object.provided ?? []);
      const typeCell = cell(row, "type");
      if (typeCell) {
        const typeId = typeFromCell(typeCell);
        if (typeId) {
          object.typeId = typeId;
          provided.add("type");
        } else unknownTypes.add(typeCell);
      }
      const set = (field: "description" | "technology" | "owner", limit: number) => {
        const value = cell(row, field);
        if (!value) return;
        object[field] = value.slice(0, limit);
        provided.add(field);
      };
      set("description", 4000);
      set("technology", 200);
      set("owner", 200);
      const lifecycle = lifecycleFromCell(cell(row, "lifecycle"));
      if (lifecycle) {
        object.lifecycle = lifecycle;
        provided.add("lifecycle");
      }
      const tags = cell(row, "tags");
      if (tags) {
        object.tags = [...new Set(tags.split(/[,;|]/).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
        provided.add("tags");
      }
      const parent = cell(row, "parent");
      if (parent && normalizeName(parent) !== normalizeName(name)) {
        parentNames.set(object.key, parent);
        provided.add("parent");
      }
      object.provided = [...provided];
    });
  });
  // Parents are resolved once every row is read, so a child may be listed before its parent.
  for (const [key, parentName] of parentNames) {
    const child = objects.find((o) => o.key === key)!;
    const parent = ensure(parentName);
    // A parent has to sit higher than its child; one that came with no type of its own is lifted to fit.
    if (!parent.provided?.includes("type") && !findByName(ws, parent.name) && objectType(parent.typeId).level >= objectType(child.typeId).level) {
      parent.typeId = objectType(child.typeId).level >= 3 ? "system" : "domain";
    }
    if (objectType(parent.typeId).level < objectType(child.typeId).level) child.parentKey = parent.key;
  }

  const relationships: ProposedRelationship[] = [];
  const seen = new Set<string>();
  sheets.forEach((sheet, index) => {
    const mapping = mappings[index];
    if (!mapping || mapping.role !== "relationships" || mapping.columns.from == null || mapping.columns.to == null) return;
    const cell = (row: string[], field: string) => (mapping.columns[field] == null ? "" : (row[mapping.columns[field]!] ?? "").trim());
    sheet.rows.slice(1).forEach((row, r) => {
      const from = cell(row, "from");
      const to = cell(row, "to");
      if (!from || !to) return skip(sheet.name, r + 2, "The From or To cell is empty");
      if (normalizeName(from) === normalizeName(to)) return skip(sheet.name, r + 2, "From and To are the same object");
      report.relationshipRows += 1;
      const source = ensure(from);
      const target = ensure(to);
      const label = cell(row, "label").slice(0, 200);
      const kindCell = cell(row, "kind");
      const relationKind = KIND_BY_NAME.get(squash(kindCell)) ?? guessKind(`${kindCell} ${label}`, source.typeId, target.typeId);
      const signature = `${source.key}>${target.key}>${relationKind}`;
      if (seen.has(signature)) return skip(sheet.name, r + 2, "The same relationship is listed on an earlier row");
      seen.add(signature);
      relationships.push({
        key: `r${relationships.length + 1}`,
        sourceKey: source.key,
        targetKey: target.key,
        kind: relationKind,
        label,
        decision: "pending",
        protocol: cell(row, "protocol").slice(0, 100) || undefined,
        port: cell(row, "port").slice(0, 100) || undefined,
        description: cell(row, "description").slice(0, 4000) || undefined,
      });
    });
  });

  report.unknownTypes = [...unknownTypes].slice(0, 20);
  if (!objects.length) throw new ImportError("No rows with a name were found. Check which column holds the names.");
  const notes = sentence([
    `${plural(report.objectRows, "object row")} and ${plural(report.relationshipRows, "relationship row")} read.`,
    report.implied > 0 && `${plural(report.implied, "object")} named only as a parent or in a relationship ${report.implied === 1 ? "was" : "were"} added as ${objectType(fallback).label}.`,
    unknownTypes.size > 0 && `Types not recognised (${[...unknownTypes].slice(0, 6).join(", ")}${unknownTypes.size > 6 ? ", and more" : ""}) were set to ${objectType(fallback).label}.`,
    report.skippedCount > 0 && `${plural(report.skippedCount, "row")} left out.`,
    "Rows that name an object already in the model update it in the columns that have a value.",
  ]);
  return { proposal: proposal(ws, "spreadsheet", fileName, notes, objects, relationships, { withoutDiagram: true }), report };
}

/** The whole model as two sheets, in the columns the import reads back. */
export function modelSheets(ws: Workspace): Sheet[] {
  const objects = Object.values(ws.objects).sort((a, b) => a.name.localeCompare(b.name));
  const name = (id: string | null) => (id && ws.objects[id]?.name) || "";
  return [
    {
      name: "Objects",
      rows: [
        OBJECT_FIELDS.map((f) => f.label),
        ...objects.map((o) => [o.name, objectType(o.typeId).label, o.description, o.owner, o.lifecycle, o.technology, o.tags.join(", "), name(o.parentId)]),
      ],
    },
    {
      name: "Relationships",
      rows: [
        RELATIONSHIP_FIELDS.map((f) => f.label),
        ...Object.values(ws.relationships)
          .filter((r) => ws.objects[r.sourceId] && ws.objects[r.targetId])
          .sort((a, b) => name(a.sourceId).localeCompare(name(b.sourceId)) || name(a.targetId).localeCompare(name(b.targetId)))
          .map((r) => [name(r.sourceId), name(r.targetId), RELATION_KIND_INFO[r.kind].label, r.label, r.protocol, r.port, r.description]),
      ],
    },
  ];
}
